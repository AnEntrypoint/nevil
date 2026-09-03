/**
 * iroh-transport.js — an optional, Node-only iroh QUIC transport that presents
 * the SAME ws-like socket facade network.js already speaks (readyState, send,
 * on('message'|'close'|'error'), _peerKey), so a connection opened over iroh is
 * _attach()ed and routed/reputation-gated identically to a `ws` socket.
 *
 * Why iroh, and why optional: iroh gives QUIC transport with relay-assisted NAT
 * hole-punching and an Ed25519 EndpointId that lines up exactly with nevil's own
 * Ed25519 souls — connectivity `ws://` can't reach on its own. It is a native
 * napi binding (@number0/iroh), so it is strictly opt-in: it is `require`d
 * lazily inside `create()` and nowhere else, leaving the ws-only / browser /
 * two-runtime-dependency baseline entirely untouched when irohEnabled is false.
 *
 * Framing: a QUIC BiStream is a raw byte stream, not message-framed like ws, so
 * each JSON envelope is written length-prefixed (4-byte big-endian length + body)
 * and re-assembled on the receive side. A single oversized frame (beyond
 * maxPayloadBytes) is refused before its body is read, mirroring ws maxPayload.
 */

'use strict';

const ALPN_STR = 'nevil/1';

/** iroh's napi send/recv operate on Array<number>; convert both directions. */
function toByteArray(buf) {
  return Array.from(buf);
}

/**
 * A single peer connection wrapped as a ws-like socket. network.js only ever
 * touches: readyState (1 === OPEN), send(string), on(evt, cb), and _peerKey.
 */
class IrohSocket {
  constructor(conn, bi, peerKey, maxPayloadBytes) {
    this._conn = conn;
    this._bi = bi;
    this._peerKey = peerKey; // stable Ed25519 EndpointId hex — same physical peer across reconnects
    this._maxPayload = maxPayloadBytes;
    this.readyState = 1; // OPEN — a socket only exists here once its BiStream is live
    this._handlers = { message: [], close: [], error: [] };
    this._sendChain = Promise.resolve(); // serialize writes so framed bodies never interleave
    this._readLoop();
  }

  on(evt, cb) {
    if (this._handlers[evt]) this._handlers[evt].push(cb);
    return this;
  }

  _emit(evt, arg) {
    for (const cb of this._handlers[evt] || []) {
      try { cb(arg); } catch { /* a listener throwing must not tear down the transport */ }
    }
  }

  /**
   * ws-compatible send: accepts a JSON string, frames it length-prefixed, and
   * writes it on the shared BiStream. Writes are serialized (best-effort, in
   * order) so QUIC backpressure never interleaves two frames' bytes; a failed
   * write closes the socket rather than silently dropping into a black hole.
   */
  send(data) {
    if (this.readyState !== 1) return false;
    const body = Buffer.from(typeof data === 'string' ? data : String(data), 'utf8');
    if (body.length > this._maxPayload) return false; // symmetric with ws maxPayload — report the drop so metrics stay truthful
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const frame = toByteArray(Buffer.concat([len, body]));
    this._sendChain = this._sendChain.then(() => this._bi.send.writeAll(frame)).catch((e) => {
      this._fail(e);
    });
    return true;
  }

  async _readLoop() {
    try {
      while (this.readyState === 1) {
        const lenArr = await this._bi.recv.readExact(4);
        const len = Buffer.from(lenArr).readUInt32BE(0);
        if (len > this._maxPayload) { this._fail(new Error('frame exceeds maxPayloadBytes')); return; }
        const bodyArr = await this._bi.recv.readExact(len);
        const text = Buffer.from(bodyArr).toString('utf8');
        this._emit('message', text);
      }
    } catch (e) {
      // readExact rejects on a closed/reset stream — the normal end-of-connection
      // path, not necessarily an error; surface it as close, not error.
      this._close();
    }
  }

  _fail(e) {
    this._emit('error', e);
    this._close();
  }

  _close() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    try { this._conn.close(0, ''); } catch { /* already gone */ }
    this._emit('close');
  }

  close() { this._close(); }
}

/**
 * The endpoint owner. Binds one iroh Endpoint, runs an accept loop turning each
 * incoming connection into an IrohSocket, and dials configured peers. Every new
 * socket (accepted or dialed) is handed to onSocket(sock) so network.js can
 * _attach() it exactly like a ws socket.
 */
class IrohTransport {
  constructor(endpoint, opts) {
    this._endpoint = endpoint;
    this._maxPayload = opts.maxPayloadBytes;
    this._onSocket = opts.onSocket;
    this._closed = false;
    this._sockets = new Set();
    this._byPeer = new Map(); // peerKey -> IrohSocket, dedup mutual dials
    this._acceptLoop();
  }

  /** Ed25519 EndpointId hex — deterministic per peer, stable across reconnects. */
  static peerKeyOf(endpointId) {
    return 'iroh:' + endpointId.toString();
  }

  async _acceptLoop() {
    while (!this._closed) {
      let incoming;
      try {
        incoming = await this._endpoint.acceptNext();
      } catch {
        if (this._closed) return;
        continue;
      }
      if (!incoming) { if (this._closed) return; continue; }
      this._onIncoming(incoming).catch(() => { /* one bad dial never kills the loop */ });
    }
  }

  async _onIncoming(incoming) {
    const connecting = await incoming.accept();
    const conn = await connecting.connect();
    const peerKey = IrohTransport.peerKeyOf(conn.remoteId());
    const bi = await conn.acceptBi();
    this._register(conn, bi, peerKey, false);
  }

  /** Dial a peer by its EndpointAddr (from another node's transport.addr()). */
  async dial(endpointAddr) {
    if (this._closed) return;
    const alpn = toByteArray(Buffer.from(ALPN_STR, 'utf8'));
    const conn = await this._endpoint.connect(endpointAddr, alpn);
    const peerKey = IrohTransport.peerKeyOf(conn.remoteId());
    const bi = await conn.openBi();
    this._register(conn, bi, peerKey, true);
  }

  /**
   * A simultaneous mutual dial yields two physical connections for one peer; if
   * each end keeps its own dialed one and closes the other, both retained sockets
   * sit on a connection the remote already closed and the link dies. Converge both
   * ends on the SAME survivor via a fixed total order on the two EndpointIds: the
   * lower-id node keeps its DIALED connection, the higher-id node keeps the
   * ACCEPTED one. Both compute the identical winner, so exactly one connection
   * survives on both sides and neither closes the one its kept socket depends on.
   */
  _keepThisConn(conn, dialed) {
    const lowerKeepsDialed = this.id() < conn.remoteId().toString();
    return dialed ? lowerKeepsDialed : !lowerKeepsDialed;
  }

  _register(conn, bi, peerKey, dialed) {
    const existing = this._byPeer.get(peerKey);
    if (existing) {
      if (!this._keepThisConn(conn, dialed)) { try { conn.close(0, ''); } catch {} return; }
      // This connection is the deterministic winner but a losing socket registered
      // first; replace it so the retained socket is on the surviving connection.
      this._sockets.delete(existing);
      try { existing.close(); } catch {}
    }
    const sock = new IrohSocket(conn, bi, peerKey, this._maxPayload);
    this._byPeer.set(peerKey, sock);
    this._sockets.add(sock);
    sock.on('close', () => {
      this._sockets.delete(sock);
      if (this._byPeer.get(peerKey) === sock) this._byPeer.delete(peerKey);
    });
    this._onSocket(sock);
  }

  /** This node's dialable address, for another node to dial(). */
  async addr() {
    return this._endpoint.addr();
  }

  /** This node's Ed25519 EndpointId hex. */
  id() {
    return this._endpoint.id().toString();
  }

  async close() {
    this._closed = true;
    for (const sock of this._sockets) { try { sock.close(); } catch {} }
    this._sockets.clear();
    this._byPeer.clear();
    try { await this._endpoint.close(); } catch { /* already closed */ }
  }
}

/**
 * Build an IrohTransport. Lazily requires @number0/iroh here and ONLY here, so
 * the whole module (and everything that imports network.js) stays loadable with
 * iroh absent as long as irohEnabled is false. A missing binding fails loud and
 * specific, naming the optional dependency, instead of a cryptic deep error.
 *
 * opts: { secretKey?: Uint8Array|Buffer (32 bytes), relay?: boolean (default
 * true), maxPayloadBytes, onSocket(sock) }
 */
async function create(opts) {
  let iroh;
  try {
    iroh = require('@number0/iroh');
  } catch (e) {
    throw new Error(
      'nevil: irohEnabled requires the optional dependency @number0/iroh ' +
      '(native binding, Node only). Install it with `npm install @number0/iroh`, ' +
      'or leave irohEnabled off to use the ws transport. Underlying: ' + (e && e.message)
    );
  }

  const builder = iroh.Endpoint.builder();
  // applyN0*/applyMinimal also install the rustls crypto provider — binding
  // without one throws "Missing or incompatible rustls crypto provider".
  if (opts.relay === false) builder.applyN0DisableRelay();
  else builder.applyN0();

  if (opts.secretKey != null) {
    const bytes = opts.secretKey instanceof Uint8Array ? opts.secretKey : Buffer.from(opts.secretKey);
    if (bytes.length !== 32) {
      throw new Error('nevil: irohSecretKey must be exactly 32 bytes (an Ed25519 seed), got ' + bytes.length);
    }
    builder.secretKey(Array.from(bytes));
  }
  builder.alpns([toByteArray(Buffer.from(ALPN_STR, 'utf8'))]);

  const endpoint = await builder.bind();
  return new IrohTransport(endpoint, opts);
}

module.exports = { create, IrohTransport, IrohSocket, ALPN_STR };
