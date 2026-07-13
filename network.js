/**
 * network.js — the DAM/AXE-equivalent transport + routing layer.
 *
 * Health-aware DHT routing over connected peers, enabled by default
 * (dhtEnabled: true). Each message is routed to the K healthiest
 * connected peers whose geohash bucket (first hex chars of the soul)
 * matches the message's routing prefix, plus L adjacent peers for mesh
 * healing. When too few peers match a bucket, routing falls back to
 * flood-fill broadcast to all connected peers, so delivery never
 * silently drops to zero. Peer health and reputation are tracked from
 * real socket activity (open, latency, observed bad behavior), so the
 * throttle gate is live without external callers. Set dhtEnabled:false
 * for pure flood-fill.
 *
 * Isomorphic: uses the global WebSocket in browsers, and the `ws`
 * package in Node (peer dependency — see package.json).
 */

'use strict';

const isNode = typeof window === 'undefined' && typeof process !== 'undefined' && !!process.versions?.node;

function randomId() {
  return globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Deep-canonicalize a value for signing/verifying: recursively sorts object
 * keys at EVERY nesting level, not just the top. `JSON.stringify(value,
 * Object.keys(value).sort())` looks like a top-level key sort but is
 * actually a recursive key ALLOWLIST — nested objects whose own keys aren't
 * in that top-level array (e.g. a `fields.title` value) silently serialize
 * as `{}` regardless of their real contents, so a signature "covering" the
 * message body never actually covered nested field data. This produces a
 * real deterministic, order-independent JSON string instead.
 */
function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

class Network {
  /**
   * @param {object} opts
   * @param {string[]} [opts.peers] - ws:// or wss:// URLs to dial on start
   * @param {object}   [opts.server] - an http/https server to attach a
   *                                   relay WebSocket endpoint to (Node)
   * @param {function} onMessage - called with (msg) for every accepted,
   *                               not-yet-seen message from any peer
   */
  constructor(opts, onMessage) {
    this.opts = opts || {};
    this.onMessage = onMessage;
    this.sockets = new Set();
    this.seen = new Set(); // message ids already relayed, for flood-fill dedup
    this.seenOrder = []; // bounded FIFO so `seen` doesn't grow forever
    this.maxSeen = 5000;
    this.metrics = { messagesReceived: 0, messagesSent: 0, bytesSent: 0, peersConnected: 0 };
    this.latencies = { send_ms: [], receive_ms: [] }; // ring buffers for latency tracking
    this.maxLatencySamples = 1000; // keep last 1000 samples per operation
    // Caps the raw WebSocket frame size at the transport layer (ws's own
    // maxPayload) so a single oversized field value can't be used to exhaust
    // memory/disk/bandwidth before any application-level check ever runs —
    // field COUNT was already bounded (graph.js MAX_FIELDS_PER_NODE) but
    // nothing previously bounded a single field VALUE or the frame as a whole.
    this.MAX_PAYLOAD_BYTES = opts.maxPayloadBytes || 1024 * 1024; // 1MB default
    this.writeRateScale = 1.0; // adaptive backpressure: scale factor for batch size
    this.peerHealthScores = new Map(); // peerId -> {latency, loss, lastSeen}
    this.peerRoutingKeys = new Map(); // peerKey -> routing prefix (learned), unknown = include all
    this.reputationLedger = []; // bounded: {peerId, delta, reason, ts}
    this.maxReputationLedger = opts.maxReputationLedger || 20000; // FIFO cap on in-memory ledger (durable log is unaffected, see storage.js)
    this.reputationCache = new Map(); // peerId -> total reputation sum (sum of all deltas)
    this.reputationCacheOrder = []; // bounded FIFO, mirrors seen/seenOrder — a gossiping peer must not grow this map unbounded via fabricated peerIds
    this.messageQueue = []; // messages queued from throttled peers

    // Reputation-gossip trust bounds. A reputationLedger-bearing message
    // requires no authentication of its own (the message it rides on may be
    // a fully unsigned put to a plain, non-keychain soul), so gossip entries
    // are treated as unauthenticated hearsay, not a corroborated observation:
    // the per-entry clamp is sized to the largest single LOCAL-observation
    // delta (REP_DELTA_REPLAY, -5), not the old flat +/-100, so one gossip
    // entry alone can no longer drive a neutral peerId straight past the
    // default REP_DROP_THRESHOLD (-10) in a single message. Distinct peerId
    // TARGETS are also rate-limited per reporting CONNECTION per window, so
    // one connection can't poison an unbounded number of victim peerIds.
    this.REP_GOSSIP_DELTA_MIN = opts.repGossipDeltaMin ?? -5;
    this.REP_GOSSIP_DELTA_MAX = opts.repGossipDeltaMax ?? 10;
    this.REP_GOSSIP_MAX_TARGETS = opts.repGossipMaxTargets || 20; // distinct peerIds one connection may gossip about per window
    // Bounds REPEATED entries for the SAME peerId within one window — the
    // distinct-target limiter above only gates the first entry per peerId,
    // so a message with many entries for one victim peerId (each carrying a
    // distinct fake timestamp to defeat the entryKey dedup) could otherwise
    // drive that single peer arbitrarily negative, bounded only by the much
    // looser maxReputationLedger message-length cap.
    this.REP_GOSSIP_MAX_ENTRIES_PER_TARGET = opts.repGossipMaxEntriesPerTarget || 5;
    this.REP_GOSSIP_WINDOW_MS = opts.repGossipWindowMs || 60000;
    this._gossipTargetsByConn = new Map(); // connKey -> { targets: Set<peerId>, entryCounts: Map<peerId, number>, windowStart: ms }

    // DHT tuning parameters
    this.DHT_K = opts.dhtK || 3; // K-nearest peers per bucket
    this.DHT_L = opts.dhtL || 2; // L adjacent buckets to gossip to
    this.DHT_GEOHASH_LENGTH = opts.dhtGeohashLength || 4; // geohash precision (4-8 chars)
    this.DHT_FALLBACK_THRESHOLD = opts.dhtFallbackThreshold || 3000; // fallback to broadcast after 3s no ACK
    this.DHT_ENABLED = opts.dhtEnabled !== false; // enable DHT (default true)

    // Hierarchical multi-hop routing (opt-in, off by default — the base DHT
    // routing above is one relay hop from origin to K peers, not a leveled
    // scheme). When enabled, a message not yet at a peer whose OWN routing
    // key fully matches the message's geohash prefix gets re-relayed forward
    // (not just flooded once) to that receiving peer's own K-healthiest
    // peers, narrowing hop by hop toward peers whose bucket match is tightest
    // — a real (bounded, TTL-capped) multi-hop traversal instead of a single
    // relay from the origin.
    this.DHT_MULTIHOP_ENABLED = opts.dhtMultihopEnabled === true;
    this.DHT_MAX_HOPS = opts.dhtMaxHops || 6; // TTL cap so multi-hop relay can't loop/run away

    // Lamport clock guards. The real per-connection replay guard (peerClocks,
    // in handleMessage below) uses only a plain monotonicity comparison
    // (msg.lamportClock <= prior) — CLOCK_FAST_THRESHOLD/CLOCK_CONSENSUS_SPREAD
    // were assigned here but never read anywhere in this file (the same dead-
    // code class the fifth audit pass already removed from graph.js); removed
    // rather than left as a phantom Byzantine-detection claim with no code
    // behind it.
    this.CLOCK_MAX_JUMP = opts.clockMaxJump || 1000; // max clock steps ahead allowed

    // Reputation thresholds
    this.REP_ACCEPT_THRESHOLD = opts.repAcceptThreshold || 0; // score >= this: accept
    this.REP_DROP_THRESHOLD = opts.repDropThreshold || -10; // score < this: drop, else queue
    this.REP_DELTA_GOOD = opts.repDeltaGood || 1; // +1 for valid write
    this.REP_DELTA_MALFORMED = opts.repDeltaMalformed || -1; // -1 for malformed
    this.REP_DELTA_REPLAY = opts.repDeltaReplay || -5; // -5 for replay/duplicate
    this.REP_DELTA_BYZANTINE = opts.repDeltaByzantine || -3; // -3 for Byzantine behavior
    this.REP_DELTA_ROUTING_HELP = opts.repDeltaRoutingHelp || 10; // +10 for routing help
    this.REP_MAX_POSITIVE = opts.repMaxPositive || 20; // ceiling on the accept buffer, mirroring the drop-threshold self-limit on the negative side
    this.QUEUE_RETRY_DELAY = opts.queueRetryDelay || 5000; // retry queued messages every 5s
    this.QUEUE_MAX_RETRIES = opts.queueMaxRetries || 5; // max retries before drop

    // Proof-of-work rate-limiting (hashcash-style), optional, orthogonal to reputation
    this.POW_ENABLED = opts.powEnabled === true; // default off — reputation ledger alone is the default throttle
    this.POW_DIFFICULTY = opts.powDifficulty || 4; // leading hex zeros required (adaptive controller adjusts this at runtime when enabled)

    // Adaptive PoW difficulty controller (optional, off by default — the prior
    // static-only difficulty required an operator to manually reconfigure
    // powDifficulty + restart to react to an observed spam surge). When
    // enabled, difficulty auto-scales within [powDifficultyMin,
    // powDifficultyMax] based on the observed accepted-put rate over a
    // sliding window: sustained high throughput ratchets difficulty up,
    // sustained low throughput relaxes it back down, bounded so it can never
    // runaway past the configured ceiling/floor.
    this.POW_ADAPTIVE = opts.powAdaptive === true;
    this.POW_DIFFICULTY_MIN = opts.powDifficultyMin || this.POW_DIFFICULTY;
    this.POW_DIFFICULTY_MAX = opts.powDifficultyMax || this.POW_DIFFICULTY + 4;
    this.POW_ADAPTIVE_WINDOW_MS = opts.powAdaptiveWindowMs || 10000;
    this.POW_ADAPTIVE_HIGH_RATE = opts.powAdaptiveHighRate || 50; // puts/window above which difficulty ratchets up
    this.POW_ADAPTIVE_LOW_RATE = opts.powAdaptiveLowRate || 5; // puts/window below which difficulty relaxes down
    this._powPutTimestamps = []; // sliding window of accepted-put arrival times, for rate measurement

    // Reputation ledger must be authoritative BEFORE any socket is opened:
    // _startServer/_dial below begin accepting/processing real peer traffic
    // synchronously from this constructor. Accepting opts.priorReputationLedger
    // and opts.onReputationDelta here (rather than the caller wiring them via
    // restoreReputationLedger()/onReputationDelta= after construction) closes
    // the boot-time window where a previously-Byzantine peer would be
    // evaluated as neutral and any penalty assessed during that window was
    // silently lost (never persisted, since the hook wasn't wired yet).
    if (opts.onReputationDelta) this.onReputationDelta = opts.onReputationDelta;
    if (opts.priorReputationLedger) this.restoreReputationLedger(opts.priorReputationLedger);

    if (isNode && this.opts.server) this._startServer();
    for (const url of this.opts.peers || []) this._dial(url);

    // Optional iroh QUIC transport (Node only, opt-in). Started asynchronously
    // (Endpoint.bind() is async); iroh sockets are _attach()ed exactly like ws
    // sockets, so routing/reputation/PoW ride on top unchanged. _irohReady is
    // exposed so close() and irohNodeAddr() can await binding regardless of when
    // they're called relative to the async bind completing.
    this.IROH_ENABLED = isNode && opts.irohEnabled === true;
    if (this.IROH_ENABLED) this._irohReady = this._startIroh();

    if (this.POW_ADAPTIVE) {
      this._powAdjustTimer = setInterval(() => this._adjustPowDifficulty(), this.POW_ADAPTIVE_WINDOW_MS);
      if (this._powAdjustTimer.unref) this._powAdjustTimer.unref();
    }
  }

  /**
   * Set reputationCache[peerId] with the same bounded-FIFO discipline as
   * `seen`/`seenOrder`: unlike the ledger arrays (already bounded by
   * maxReputationLedger), the cache Map itself had no cap, so a peer
   * gossiping a stream of fabricated peerIds could grow it without limit.
   */
  _setReputationCache(peerId, value) {
    // Cap the accept buffer so a peer can't pre-farm unbounded positive
    // reputation and then absorb many penalties without ever throttling.
    if (value > this.REP_MAX_POSITIVE) value = this.REP_MAX_POSITIVE;
    if (!this.reputationCache.has(peerId)) {
      this.reputationCacheOrder.push(peerId);
      if (this.reputationCacheOrder.length > this.maxReputationLedger) {
        // FIFO pressure must never upgrade a throttled peer to accept: skip
        // (re-queue) any peerId currently below the accept threshold when
        // choosing an eviction victim, so a Byzantine/drop-throttled peer
        // stays pinned. If every candidate is pinned (cache full of
        // negatives), evict the oldest anyway to bound growth.
        const order = this.reputationCacheOrder;
        let victimIdx = 0;
        while (victimIdx < order.length - 1) {
          const cand = order[victimIdx];
          const rep = this.reputationCache.get(cand);
          if (rep === undefined || rep >= this.REP_ACCEPT_THRESHOLD) break;
          victimIdx++;
        }
        const victim = order.splice(victimIdx, 1)[0];
        this.reputationCache.delete(victim);
      }
    }
    this.reputationCache.set(peerId, value);
  }

  _remember(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.maxSeen) this.seen.delete(this.seenOrder.shift());
    return true;
  }

  _startServer() {
    const { WebSocketServer } = require('ws');
    this.wss = new WebSocketServer({ server: this.opts.server, path: '/nevil', maxPayload: this.MAX_PAYLOAD_BYTES });
    this.wss.on('connection', (ws) => this._attach(ws));
    // A WebSocketServer is a Node EventEmitter: an 'error' event with zero
    // listeners throws as an uncaught exception and crashes the whole
    // process (malformed upgrade handshake, underlying HTTP server protocol
    // error, etc.) — an unauthenticated remote DoS without this handler.
    this.wss.on('error', (e) => {
      if (typeof console !== 'undefined' && console.error) {
        console.error('nevil network: WebSocketServer error', e?.message || e);
      }
    });
  }

  _dial(url, attempt = 0) {
    if (this._closed) return; // a redial timer scheduled before close() must not resurrect a socket after
    const WS = isNode ? require('ws') : WebSocket;
    const ws = isNode ? new WS(url, { maxPayload: this.MAX_PAYLOAD_BYTES }) : new WS(url);
    ws._dialUrl = url;
    ws._dialAttempt = attempt;
    this._attach(ws);
  }

  /**
   * Bind the iroh Endpoint and dial any configured iroh peers. Each accepted or
   * dialed connection arrives as a ws-like IrohSocket handed to _attach(), so the
   * entire admission pipeline (signature verify, PoW gate, reputation throttle,
   * maxPayload, DHT routing) treats it identically to a ws socket — the transport
   * swap changes bytes-on-wire only. opts: irohSecretKey (32-byte Ed25519 seed,
   * defaults to an ephemeral key), irohRelay (default true — n0 relay-assisted
   * hole-punching; set false for direct/LAN-only), irohPeers (array of dialable
   * EndpointAddr objects from other nodes' irohNodeAddr()).
   */
  async _startIroh() {
    const { create } = require('./iroh-transport');
    this._irohTransport = await create({
      secretKey: this.opts.irohSecretKey,
      relay: this.opts.irohRelay !== false,
      maxPayloadBytes: this.MAX_PAYLOAD_BYTES,
      onSocket: (sock) => { if (!this._closed) this._attach(sock); },
    });
    if (this._closed) { try { await this._irohTransport.close(); } catch {} return this._irohTransport; }
    for (const addr of this.opts.irohPeers || []) {
      try { await this._irohTransport.dial(addr); } catch (e) {
        if (typeof console !== 'undefined' && console.error) console.error('nevil network: iroh dial failed', e?.message || e);
      }
    }
    return this._irohTransport;
  }

  /** Dial an iroh peer at runtime by its EndpointAddr (from a peer's irohNodeAddr()). */
  async dialIroh(endpointAddr) {
    if (!this.IROH_ENABLED) throw new Error('nevil: dialIroh requires irohEnabled');
    if (this._irohReady) await this._irohReady;
    if (this._irohTransport) await this._irohTransport.dial(endpointAddr);
  }

  /** This node's dialable iroh address (EndpointAddr), for a peer to irohPeers/dialIroh. */
  async irohNodeAddr() {
    if (!this.IROH_ENABLED) return null;
    if (this._irohReady) await this._irohReady;
    return this._irohTransport ? this._irohTransport.addr() : null;
  }

  /** Exponential backoff (capped) for redialing a configured peer that keeps failing, instead of a fixed unthrottled 2s retry forever. */
  _redialDelay(attempt) {
    const base = this.opts.redialBaseMs || 2000;
    const cap = this.opts.redialMaxMs || 60000;
    return Math.min(cap, base * Math.pow(2, attempt));
  }

  _attach(ws) {
    this.sockets.add(ws);
    this.metrics.peersConnected = this.sockets.size;
    // Register the peer in the health map immediately so DHT routing sees
    // real connected peers by default (no external caller required).
    let peerKey = this._getPeerKey(ws);
    this.updatePeerHealth(peerKey, 0, 0);
    const handleOpen = () => {
      ws._dialAttempt = 0;
      // For a dialed (not server-accepted) socket, _getPeerKey returns the
      // dial URL before the TCP handshake completes and address:port after —
      // re-keying here without migrating the pre-connect entry would leave
      // two permanent, never-reconciled peerHealthScores entries for one
      // physical peer (the stale URL-keyed stub is never read again but also
      // never cleaned up, since handleClose only ever deletes the CURRENT key).
      const newKey = this._getPeerKey(ws);
      if (newKey !== peerKey) {
        this.peerHealthScores.delete(peerKey);
        this.peerRoutingKeys.delete(peerKey);
        if (this.peerClocks) this.peerClocks.delete(peerKey);
        this._gossipTargetsByConn.delete(peerKey);
        peerKey = newKey;
      }
      this.updatePeerHealth(peerKey, 0, 0);
    };
    const handleClose = () => {
      this.sockets.delete(ws);
      this.metrics.peersConnected = this.sockets.size;
      // _getPeerKey is address:port (Node) — ephemeral per TCP connection, so
      // a reconnect never reuses this key. Without cleanup here, every past
      // connection leaves a permanent stale entry in these three peer-keyed
      // maps, unlike every other collection in this file (seen, reputation
      // ledger/cache, messageQueue, _directSendTargets, _ackedIds), which are
      // all bounded-FIFO or otherwise capped. Stale entries are harmless to
      // correctness (routing/relay only reads currently-connected sockets)
      // but grow memory without bound under normal connection churn.
      this.peerHealthScores.delete(peerKey);
      this.peerRoutingKeys.delete(peerKey);
      if (this.peerClocks) this.peerClocks.delete(peerKey);
      this._gossipTargetsByConn.delete(peerKey);
      // Self-heal: redial only sockets we initiated (not server-attached).
      // Tracked in _redialTimers (not just left as a bare setTimeout) so
      // close() can cancel it even though the socket already left `sockets`
      // by this point — otherwise a redial scheduled just before close()
      // fires afterward and resurrects a live connection on a torn-down instance.
      if (ws._dialUrl && !ws._redialScheduled && !this._closed) {
        ws._redialScheduled = true;
        const nextAttempt = (ws._dialAttempt || 0) + 1;
        this._redialTimers = this._redialTimers || new Set();
        const timer = setTimeout(() => { this._redialTimers.delete(timer); this._dial(ws._dialUrl, nextAttempt); }, this._redialDelay(ws._dialAttempt || 0));
        if (timer.unref) timer.unref();
        this._redialTimers.add(timer);
      }
    };
    const handleMessage = (raw) => {
      const recvStart = Date.now();
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.data ?? raw.toString());
      } catch {
        this.updateReputation(this._getPeerKey(ws), this.REP_DELTA_MALFORMED, 'malformed');
        return; // malformed frame, drop and penalize sender
      }
      // A parsed primitive/null/array is not a valid message envelope — field
      // access below (msg.id, msg.sender, ...) would throw uncaught otherwise.
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        this.updateReputation(this._getPeerKey(ws), this.REP_DELTA_MALFORMED, 'malformed');
        return;
      }
      // Cap id length: an unbounded attacker-controlled id string can bloat
      // `seen`/`seenOrder` memory even though entry COUNT is bounded by maxSeen.
      if (typeof msg.id !== 'string' || msg.id.length === 0 || msg.id.length > 256) {
        this.updateReputation(this._getPeerKey(ws), this.REP_DELTA_MALFORMED, 'malformed');
        return;
      }
      if (!this._remember(msg.id)) {
        // Seeing our own message id relayed back (mesh loop-back) is the
        // real-traffic ACK signal for the DHT_FALLBACK_THRESHOLD timer in
        // broadcast(): it proves at least one peer actually received and
        // is propagating this message, so the flood-fill fallback is unneeded.
        // Only count it if it comes back via a connection we did NOT send
        // the original directly to — a peer we sent it to trivially echoing
        // the id straight back proves nothing about real propagation and
        // would let that single peer forge the ACK for free.
        const directTargets = this._directSendTargets?.get(msg.id);
        const notADirectTarget = !directTargets || !directTargets.has(this._getPeerKey(ws));
        // Require the re-delivered frame to actually carry the ORIGINAL
        // message body (verified against a digest recorded at broadcast
        // time), not just a bare {id} echo — otherwise ANY connected peer
        // that was never a direct send target (e.g. outside the DHT-selected
        // bucket) could forge the loop-back ACK for free with a minimal
        // {id} frame, silently suppressing the DHT_FALLBACK_THRESHOLD
        // reflood safety net for a message that never actually propagated.
        const expectedDigest = this._sentDigests?.get(msg.id);
        // An ABSENT digest means this node never broadcast this message, so a
        // loop-back of it proves nothing about OUR propagation — it must fail,
        // not pass, or any foreign-origin duplicate would forge an ACK and farm
        // routing-help reputation for free.
        const digestMatches = expectedDigest !== undefined && expectedDigest === canonicalJSON({ soul: msg.soul, fields: msg.fields, ts: msg.ts });
        if (notADirectTarget && digestMatches) {
          this._ackedIds = this._ackedIds || new Set();
          const firstAck = !this._ackedIds.has(msg.id);
          this._ackedIds.add(msg.id);
          if (this._ackedIds.size > this.maxSeen) this._ackedIds.delete(this._ackedIds.values().next().value);
          // This peer re-delivered a message carrying the original body via a
          // path we did NOT send it directly — proof it actually relayed real
          // traffic on our behalf, the exact 'routing-help' the reputation
          // ledger documents. REP_DELTA_ROUTING_HELP was previously never
          // awarded anywhere, so the positive routing incentive was dead. Award
          // it only on the FIRST loop-back of a given id, so a peer echoing the
          // same id repeatedly can't farm unbounded routing reputation.
          if (firstAck) this.updateReputation(this._getPeerKey(ws), this.REP_DELTA_ROUTING_HELP, 'routing-help');
        }
        return; // already seen, stop the flood here
      }
      // Cheap reputation gate BEFORE expensive signature verification: a
      // connection already known to be drop-throttled must not force a full
      // libsodium Ed25519 verify (Buffer allocs + JSON.stringify + native
      // call) on every message it sends — that lets an already-Byzantine
      // peer impose disproportionate CPU cost for free. Keyed per CONNECTION
      // (peerKey), never per claimed msg.sender (attacker-controlled).
      const connKey = this._getPeerKey(ws);
      if (this.getThrottleState(connKey) === 'drop') {
        this.metrics.messagesDropped = (this.metrics.messagesDropped || 0) + 1;
        return; // cheap drop, no signature/PoW work spent on a blacklisted connection
      }
      // Signature verification: keypear-derived sender authenticity. A `put`
      // targeting a keychain-derived soul (64-hex Ed25519 pubkey) MUST carry a
      // valid signature — omitting both `sender`/`signature` used to skip
      // verification entirely and merge straight into the graph, defeating
      // the putAt/getAtVerified ownership model for anyone relaying raw puts.
      // Plain (non-keychain) souls have no identity to verify against, so
      // they are unaffected — this only closes the identity-forgery gap.
      if (msg.type === 'put' && this._isKeychainDerived(msg.soul) && !(msg.sender && msg.signature)) {
        this.metrics.signatureDropped = (this.metrics.signatureDropped || 0) + 1;
        this.updateReputation(connKey, this.REP_DELTA_BYZANTINE, 'byzantine');
        return; // unsigned write to an identity-addressed soul, drop and penalize
      }
      let senderAuthenticated = false;
      if (msg.sender && msg.signature) {
        if (!this._verifySignature(msg.sender, msg, msg.signature)) {
          this.metrics.signatureDropped = (this.metrics.signatureDropped || 0) + 1;
          // Penalize the CONNECTION, not msg.sender — sender is unauthenticated
          // (that's exactly why verification just failed), so an attacker could
          // otherwise fabricate any victim's soul as sender to frame them.
          this.updateReputation(connKey, this.REP_DELTA_BYZANTINE, 'byzantine');
          return; // signature failed, drop and penalize sender
        }
        senderAuthenticated = true; // signature present and verified: msg.sender is now trustworthy
      }
      // Lamport clock gate: reject out-of-order or rollback clocks. Keyed per
      // CONNECTION (peerKey), not per claimed `msg.sender` — an unauthenticated
      // sender field is attacker-controlled, so bucketing by it (or by a shared
      // 'unknown' string when omitted) let any anonymous peer manipulate a
      // shared counter to block others. Per-socket tracking means an attacker
      // can only ever race against their own connection's prior clock.
      if (msg.lamportClock !== undefined) {
        // A non-numeric lamportClock (e.g. the per-field-map shape
        // graph.mergeNode also accepts as valid) coerces to NaN in the `<=`
        // compare below, which is always false — the message would be
        // accepted AND the object stored as the new `prior`, permanently
        // breaking replay protection for this connection since every future
        // numeric compare against a stored object is also NaN-based. Reject
        // non-finite-number clocks the same as any other malformed field.
        if (typeof msg.lamportClock !== 'number' || !Number.isFinite(msg.lamportClock)) {
          this.updateReputation(connKey, this.REP_DELTA_MALFORMED, 'malformed');
          return;
        }
        const lastClock = this.peerClocks = this.peerClocks || new Map();
        const prior = lastClock.get(connKey) || 0;
        if (msg.lamportClock <= prior) {
          this.metrics.clockDropped = (this.metrics.clockDropped || 0) + 1;
          // Penalize the CONNECTION, not msg.sender — at this point sender is
          // only authenticated if a signature was present AND verified above;
          // an omitted/unsigned sender field is attacker-controlled, so
          // trusting it here would let an attacker forge a victim's soul as
          // sender and have the replay penalty charged to the victim instead
          // of the attacker's own connection (frame-the-victim DoS).
          this.updateReputation(connKey, this.REP_DELTA_REPLAY, 'replay');
          return; // clock did not advance, possible replay/rollback
        }
        lastClock.set(connKey, msg.lamportClock);
      }
      // PoW verification: when enabled, every write must carry a valid puzzle solution;
      // when a puzzle is present regardless of the flag, verify it (never trust unchecked work).
      if (this.POW_ENABLED && msg.type === 'put' && !this._verifyPoW(msg.soul, msg.pow, msg.id, msg.fields, msg.ts)) {
        this.metrics.powDropped = (this.metrics.powDropped || 0) + 1;
        // Penalize the CONNECTION, not msg.sender — same rationale as the
        // signature-failure site above: sender is only authenticated if a
        // signature was present AND verified, which a PoW-failing message
        // need not carry. Trusting an unauthenticated sender field here
        // would let an attacker forge a victim's soul as sender and have
        // the PoW-fail penalty charged to the victim (frame-the-victim DoS).
        this.updateReputation(connKey, this.REP_DELTA_BYZANTINE, 'byzantine');
        return; // missing or invalid PoW, drop and penalize sender
      }
      if (!this.POW_ENABLED && msg.pow && !this._verifyPoW(msg.soul, msg.pow, msg.id, msg.fields, msg.ts)) {
        this.metrics.powDropped = (this.metrics.powDropped || 0) + 1;
        // Penalize the CONNECTION, not msg.sender — see rationale above.
        this.updateReputation(connKey, this.REP_DELTA_BYZANTINE, 'byzantine');
        return; // PoW failed, drop and penalize sender
      }
      // Reputation gossip: fold in only entries not already applied. Each
      // sender now gossips its ledger tail (see nevil.js), but a message can
      // still be re-delivered via a different route, so dedup by identity
      // (peerId+delta+reason+timestamp) before summing — otherwise the same
      // historical delta gets re-added to reputationCache on every repeat
      // delivery, inflating scores far past the true sum of distinct deltas.
      // Cap incoming reputationLedger length before iterating/relaying: an
      // honest sender only ever gossips its ledger tail since the last
      // gossip (bounded by real traffic volume), so an array anywhere near
      // maxReputationLedger is itself a signal of a crafted oversized
      // payload — iterating and then JSON.stringify-relaying it to K/all
      // peers at every hop would otherwise let one small attacker frame
      // impose O(entries * hops) CPU/bandwidth cost mesh-wide for free.
      if (msg.reputationLedger && Array.isArray(msg.reputationLedger) && msg.reputationLedger.length > this.maxReputationLedger) {
        this.updateReputation(connKey, this.REP_DELTA_MALFORMED, 'malformed');
        return;
      }
      if (msg.reputationLedger && Array.isArray(msg.reputationLedger)) {
        this._seenReputationEntries = this._seenReputationEntries || new Set();
        // Per-CONNECTION distinct-target rate limit: reputationLedger gossip
        // requires no authentication binding a claimed entry.peerId to the
        // connection reporting it (any message reaching this point — even a
        // fully unsigned put to a plain, non-keychain soul — can carry a
        // gossip payload), so without this bound a single first-contact
        // connection could poison an unbounded number of victim peerIds in
        // one payload or across many small ones. Bucketed per rolling window
        // so a long-lived honest connection's gossip volume over time isn't
        // permanently capped by an early burst.
        let targetInfo = this._gossipTargetsByConn.get(connKey);
        const now = Date.now();
        if (!targetInfo || now - targetInfo.windowStart > this.REP_GOSSIP_WINDOW_MS) {
          targetInfo = { targets: new Set(), entryCounts: new Map(), windowStart: now };
          this._gossipTargetsByConn.set(connKey, targetInfo);
          if (this._gossipTargetsByConn.size > this.maxSeen) {
            this._gossipTargetsByConn.delete(this._gossipTargetsByConn.keys().next().value);
          }
        }
        for (const entry of msg.reputationLedger) {
          // Number.isFinite (not just typeof === 'number') excludes
          // NaN/Infinity/-Infinity, and the magnitude clamp bounds a single
          // entry's effect — without both, one unauthenticated frame could
          // permanently poison a peerId's reputation to -Infinity. nevil.js's
          // mergeReputationLedger shares this same REP_GOSSIP_DELTA_MIN/MAX
          // clamp, dedup set, and per-caller target rate-limit.
          if (!entry || typeof entry.peerId !== 'string' || typeof entry.delta !== 'number' || !Number.isFinite(entry.delta)) continue;
          if (!targetInfo.targets.has(entry.peerId)) {
            if (targetInfo.targets.size >= this.REP_GOSSIP_MAX_TARGETS) continue; // this connection already exhausted its per-window target budget
            targetInfo.targets.add(entry.peerId);
          }
          // The distinct-target check above only gates the FIRST entry seen
          // for a peerId this window — without a separate per-peerId count,
          // a single oversized message with many entries for one victim
          // peerId (each carrying a distinct fake timestamp to defeat the
          // entryKey dedup below) could apply an unbounded number of clamped
          // deltas to that one target, bounded only by the much looser
          // maxReputationLedger message-length cap.
          const appliedCount = targetInfo.entryCounts.get(entry.peerId) || 0;
          if (appliedCount >= this.REP_GOSSIP_MAX_ENTRIES_PER_TARGET) continue; // this connection already exhausted its per-window per-target entry budget
          // Gossip entries are unauthenticated hearsay (no proof the
          // reporting connection actually observed entry.peerId's behavior),
          // so the clamp is sized to the largest single LOCAL-observation
          // delta (REP_DELTA_REPLAY, -5 by default) rather than the far
          // larger +/-100 previously used — one gossip entry alone can no
          // longer drive a neutral peerId straight past REP_DROP_THRESHOLD
          // (-10 by default) in a single message.
          const delta = Math.max(this.REP_GOSSIP_DELTA_MIN, Math.min(this.REP_GOSSIP_DELTA_MAX, entry.delta));
          // Key on the CLAMPED delta, not entry.delta (raw) — otherwise many
          // entries for the same peerId/reason/timestamp with distinct raw
          // magnitudes that all clamp to the same effective value (e.g. 100,
          // 150, 999999) each produce a distinct key, bypassing dedup and
          // summing the same effective delta into reputationCache repeatedly.
          const entryKey = entry.peerId + '|' + delta + '|' + entry.reason + '|' + entry.timestamp;
          if (this._seenReputationEntries.has(entryKey)) continue;
          this._seenReputationEntries.add(entryKey);
          if (this._seenReputationEntries.size > this.maxReputationLedger) {
            this._seenReputationEntries.delete(this._seenReputationEntries.values().next().value);
          }
          targetInfo.entryCounts.set(entry.peerId, appliedCount + 1);
          const sum = this.reputationCache.get(entry.peerId) || 0;
          this._setReputationCache(entry.peerId, sum + delta);
        }
      }
      // Throttle gating: check sender reputation and decide accept/queue/drop.
      // Only trust msg.sender as the throttle key when it was cryptographically
      // authenticated above (senderAuthenticated) — otherwise it is
      // attacker-controlled, and an attacker could forge a victim's soul as
      // sender to have the victim's reputation/throttle state (rather than
      // the attacker's own connection's) gate this message.
      const senderId = senderAuthenticated ? msg.sender : connKey;
      const throttleState = this.getThrottleState(senderId);
      if (throttleState === 'drop') {
        this.metrics.messagesDropped = (this.metrics.messagesDropped || 0) + 1;
        return; // drop low-reputation sender silently
      }
      if (throttleState === 'queue') {
        // Queue the message; relay later when sender reputation recovers.
        // Bounded FIFO (maxQueuedMessages) and periodic drain (_drainQueue,
        // scheduled below) — previously nothing ever read this queue, so it
        // grew unboundedly and every queued write was silently lost forever
        // even after the sender's reputation recovered.
        this.messageQueue = this.messageQueue || [];
        this.messageQueue.push({ msg, senderId, receivedAt: Date.now(), retries: 0 });
        if (this.messageQueue.length > (this.opts.maxQueuedMessages || 10000)) this.messageQueue.shift();
        this._scheduleQueueDrain();
        return;
      }
      // throttleState === 'accept': process normally
      this.metrics.messagesReceived++;
      const recvMs = Date.now() - recvStart;
      this._recordLatency('receive_ms', recvMs);
      const peerKey = this._getPeerKey(ws);
      this.updatePeerHealth(peerKey, recvMs, 0);
      if (this.POW_ADAPTIVE && msg.type === 'put') this._recordPowRateSample();
      // Learn this peer's routing bucket from the souls it actually relays —
      // peerRoutingKeys was previously never populated anywhere, so
      // _getPrefixMatches' bucket-preference always took the "unknown peer:
      // include all" branch and never actually filtered by bucket match.
      // Restricted to type:'put' — that's the only message shape the
      // mandatory-signature gate above actually scrutinizes for a
      // keychain-derived soul; any other/omitted type carrying a fabricated
      // 64-hex soul would otherwise poison this peer's routing-key entry
      // with zero authentication, biasing DHT/multi-hop peer selection
      // toward a Sybil connection for an attacker-chosen bucket.
      if (msg.type === 'put' && msg.soul && this._isKeychainDerived(msg.soul)) {
        this.peerRoutingKeys.set(peerKey, this._computeGeohash(msg.soul));
      }
      this.onMessage(msg);
      // Reward the sender for a valid, first-seen, fully-gated put. Previously
      // every internal updateReputation call was a PENALTY (malformed/byzantine/
      // replay) and REP_DELTA_GOOD ('good', the documented "valid write" reward)
      // was never awarded anywhere — so a well-behaved peer stayed pinned at 0
      // and could never build a positive buffer to absorb a later isolated
      // penalty, making the reputation ledger a one-way ratchet toward drop.
      // Keyed on senderId with the same authenticated-vs-connKey rule as the
      // throttle gate, so an unauthenticated peer can't farm reputation for a
      // forged victim soul.
      if (msg.type === 'put') this.updateReputation(senderId, this.REP_DELTA_GOOD, 'good');
      if (this.DHT_MULTIHOP_ENABLED && this.DHT_ENABLED && this._isKeychainDerived(msg.soul)) {
        this._relayMultiHop(msg, ws);
      } else {
        this._relay(msg, ws); // flood to every other connected peer
      }
    };

    if (isNode) {
      ws.on('open', handleOpen);
      ws.on('close', handleClose);
      ws.on('message', handleMessage);
      ws.on('error', handleClose);
    } else {
      ws.addEventListener('open', handleOpen);
      ws.addEventListener('close', handleClose);
      ws.addEventListener('message', handleMessage);
      ws.addEventListener('error', handleClose);
    }
  }

  /** Send a message to every connected peer, marking it seen locally first. */
  broadcast(payload, lamportClock) {
    const msg = { id: randomId(), lamportClock: lamportClock || 0, ...payload };
    this._remember(msg.id);
    const routedPeers = this._selectRoutingPeers(msg);
    // Remember exactly who we sent to, so the ACK check below can require a
    // loop-back from a peer we did NOT directly send to — a peer we DID send
    // to trivially echoing the id straight back proves nothing about real
    // mesh propagation and would let a single connected peer forge the ACK
    // signal for free with one unauthenticated {id} frame.
    this._directSendTargets = this._directSendTargets || new Map();
    this._directSendTargets.set(msg.id, routedPeers);
    if (this._directSendTargets.size > this.maxSeen) {
      this._directSendTargets.delete(this._directSendTargets.keys().next().value);
    }
    // Record the original payload's digest so a later loop-back "ACK" for
    // this id can be verified as a genuine re-delivery of THIS message
    // (see handleMessage) rather than trusted on a bare {id} frame alone.
    this._sentDigests = this._sentDigests || new Map();
    this._sentDigests.set(msg.id, canonicalJSON({ soul: msg.soul, fields: msg.fields, ts: msg.ts }));
    if (this._sentDigests.size > this.maxSeen) {
      this._sentDigests.delete(this._sentDigests.keys().next().value);
    }
    this._relay(msg, null);
    // DHT_FALLBACK_THRESHOLD ACK timeout: a DHT-routed (non-flood-fill) send
    // to a bounded peer subset is fire-and-forget with no receipt signal, so
    // a message to an unresponsive bucket could otherwise vanish silently.
    // If no peer relays this id back to us (via _relay's re-broadcast of
    // already-seen ids, tracked in `seen`) within the threshold, re-send as
    // a true flood-fill to every connected peer. Skip scheduling entirely
    // when the initial routing selection already covered every connected
    // socket (e.g. a small/fully-connected mesh) — a re-flood there is a
    // guaranteed duplicate send, since a message can never "loop back" to
    // us in a mesh where recipients don't relay to their own sender.
    const allConnectedAlreadyTargeted = routedPeers.size >= this.sockets.size;
    if (this.DHT_ENABLED && this.sockets.size > 0 && !allConnectedAlreadyTargeted) {
      this._dhtFallbackTimers = this._dhtFallbackTimers || new Set();
      const timer = setTimeout(() => {
        this._dhtFallbackTimers.delete(timer);
        if (!this._ackedIds?.has(msg.id)) this._relay(msg, null, true);
      }, this.DHT_FALLBACK_THRESHOLD);
      if (timer.unref) timer.unref();
      this._dhtFallbackTimers.add(timer);
    }
    return msg;
  }

  _isKeychainDerived(soul) {
    // Explicit typeof guard, not just the regex: RegExp.test coerces its
    // argument via String(x), so a non-string like a single-element array
    // (e.g. ['a'.repeat(64)], a shape JSON.parse can legitimately produce
    // from {"soul":["aaa...a"]}) can coerce to a valid-looking 64-hex string
    // and return true, letting a non-string soul reach downstream code
    // (_computeGeohash, _relayMultiHop) that assumes a real string and
    // throws (soul.substring is not a function) — a real unauthenticated
    // remote crash when dhtMultihopEnabled is on, since the multi-hop relay
    // check has no msg.type === 'put' restriction to incidentally gate it.
    // Case-insensitive to match keychain.js's own Keychain.fromPublicKey
    // regex (/^[0-9a-fA-F]{64}$/) — casing must never affect whether a soul
    // is treated as identity-addressed, since Buffer.from(hex,'hex') decodes
    // upper/lowercase to the byte-identical key and an uppercase-hex put
    // must not silently bypass the mandatory-signature gate above.
    return typeof soul === 'string' && /^[0-9a-fA-F]{64}$/.test(soul);
  }

  _verifySignature(sender, msg, signature) {
    // Verify message signature: sender is keypear-derived soul (public key hex)
    // Signature covers: {soul, fields, ts, lamportClock, ...} (everything except id, sender, signature, _hops)
    if (!sender || !signature || typeof signature !== 'string') return false;
    let sodium;
    try {
      sodium = require('sodium-universal');
    } catch (e) {
      // A missing/broken native binding is an ENVIRONMENT failure, not a bad
      // signature — conflating the two (both silently returning false) would
      // make a broken sodium install look identical to "every peer is
      // forging writes", Byzantine-penalizing every legitimate sender with
      // no diagnostic trail. Fail closed (still reject the write — an
      // unverifiable signature must never be treated as valid) but log
      // loudly and distinctly so this is diagnosable instead of silent.
      if (typeof console !== 'undefined' && console.error) {
        console.error('nevil network: sodium-universal unavailable, cannot verify signatures — rejecting all signed writes', e?.message || e);
      }
      return false;
    }
    try {
      const publicKeyHex = sender;
      const publicKeyBuf = Buffer.from(publicKeyHex, 'hex');
      const msgCopy = { ...msg };
      delete msgCopy.id;
      delete msgCopy.sender;
      delete msgCopy.signature;
      // _hops is added/incremented by _relayMultiHop AFTER the origin signs,
      // so it must be excluded the same as id/sender/signature — otherwise a
      // signed put fails verification at every hop past the first once
      // dhtMultihopEnabled mutates the message on relay.
      delete msgCopy._hops;
      // canonicalJSON (not JSON.stringify(msgCopy, Object.keys(msgCopy).sort()))
      // — the array-form replacer is a recursive key ALLOWLIST applied at
      // every nesting level, so nested objects like `fields` always
      // serialized as `{}` regardless of contents, meaning the signature
      // never actually covered field data. Must stay byte-for-byte
      // consistent with the signing side in nevil.js.
      const msgBody = canonicalJSON(msgCopy);
      const sigBuf = Buffer.from(signature, 'hex');
      return sodium.crypto_sign_verify_detached(sigBuf, Buffer.from(msgBody), publicKeyBuf);
    } catch (e) {
      return false; // actual bad signature / malformed hex — normal reject path
    }
  }

  /** Record one accepted-put arrival for the sliding-window rate used by the adaptive PoW controller. */
  _recordPowRateSample() {
    const now = Date.now();
    this._powPutTimestamps.push(now);
    const cutoff = now - this.POW_ADAPTIVE_WINDOW_MS;
    while (this._powPutTimestamps.length && this._powPutTimestamps[0] < cutoff) this._powPutTimestamps.shift();
  }

  /**
   * Adjust POW_DIFFICULTY based on the observed accepted-put rate over the
   * current sliding window. Ratchets by exactly 1 leading-zero-hex-digit per
   * call (roughly 16x expected solve-time change) so a single burst can't
   * whipsaw difficulty; bounded to [POW_DIFFICULTY_MIN, POW_DIFFICULTY_MAX].
   * Self-scheduled: the constructor sets up its own setInterval (POW_ADAPTIVE_WINDOW_MS)
   * when powAdaptive is enabled — nevil.js does not call or schedule this.
   */
  _adjustPowDifficulty() {
    if (!this.POW_ADAPTIVE) return this.POW_DIFFICULTY;
    const now = Date.now();
    const cutoff = now - this.POW_ADAPTIVE_WINDOW_MS;
    while (this._powPutTimestamps.length && this._powPutTimestamps[0] < cutoff) this._powPutTimestamps.shift();
    const rate = this._powPutTimestamps.length;
    if (rate > this.POW_ADAPTIVE_HIGH_RATE && this.POW_DIFFICULTY < this.POW_DIFFICULTY_MAX) {
      this.POW_DIFFICULTY++;
    } else if (rate < this.POW_ADAPTIVE_LOW_RATE && this.POW_DIFFICULTY > this.POW_DIFFICULTY_MIN) {
      this.POW_DIFFICULTY--;
    }
    return this.POW_DIFFICULTY;
  }

  /**
   * Digest the payload a PoW puzzle is bound to, in addition to soul+id.
   * Without this, `_verifyPoW` only ever hashed soul+id+nonce — `fields`/`ts`
   * were never part of the puzzle, so a relaying peer could swap a plain
   * (non-keychain, unsigned) put's actual data in transit while keeping the
   * same valid PoW solution. Canonicalized (not plain JSON.stringify) so key
   * order in `fields`/`ts` can't change the digest and desync solve/verify.
   */
  static _powPayloadDigest(fields, ts) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(canonicalJSON({ fields: fields || {}, ts: ts || {} })).digest('hex');
  }

  _verifyPoW(soul, pow, id, fields, ts) {
    // Verify PoW: check that leading_zeros(sha256(soul:id:payloadDigest:nonce)) >= difficulty.
    // Binding to `id` (a fresh random value per broadcast, already required
    // and dedup'd via _remember/`seen`) ties one solved puzzle to one
    // specific message — without it, a puzzle solved once for a soul could
    // be replayed unlimited times across distinct messages with fresh ids.
    // Binding to a digest of `fields`/`ts` closes the relay-tampering gap on
    // plain (non-keychain) souls, which have no signature to fall back on:
    // a relaying peer can no longer swap the write's actual content while
    // keeping the original valid PoW solution.
    if (!pow || typeof pow.nonce !== 'number' || typeof pow.difficulty !== 'number') return false;
    if (pow.difficulty < this.POW_DIFFICULTY) return false; // can't satisfy the gate with a weaker puzzle
    const crypto = require('crypto');
    const payloadDigest = Network._powPayloadDigest(fields, ts);
    const input = soul + ':' + id + ':' + payloadDigest + ':' + pow.nonce;
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    const leadingZeros = hash.match(/^0*/)[0].length;
    return leadingZeros >= pow.difficulty;
  }

  /** Solve a hashcash-style puzzle for `soul`+`id`+`fields`+`ts` at `difficulty` leading hex zeros. O(16^difficulty) expected iterations. */
  static solvePoW(soul, difficulty, id, fields, ts) {
    const crypto = require('crypto');
    const payloadDigest = Network._powPayloadDigest(fields, ts);
    let nonce = 0;
    for (;;) {
      const hash = crypto.createHash('sha256').update(soul + ':' + id + ':' + payloadDigest + ':' + nonce).digest('hex');
      if (hash.match(/^0*/)[0].length >= difficulty) return { nonce, difficulty };
      nonce++;
    }
  }

  _getPrefixMatches(soul, peers) {
    // Bucket peers by the soul's geohash routing prefix. For a keychain-derived
    // soul (64-hex public key) the prefix is its first DHT_GEOHASH_LENGTH chars.
    if (!this._isKeychainDerived(soul)) return peers; // non-keychain soul: flood-fill
    const soulPrefix = this._computeGeohash(soul);
    return peers.filter(pk => {
      const rk = this.peerRoutingKeys.get(pk);
      if (rk === undefined) return true; // unknown peer: include (no routing key recorded)
      return rk.startsWith(soulPrefix);
    });
  }

  _updateBackpressure() {
    // If p99 latency exceeds 100ms, reduce write rate by 10%
    const metrics = this.getMetrics();
    const p99 = Math.max(
      metrics.latencies.send_ms.p99,
      metrics.latencies.receive_ms.p99
    );
    if (p99 > 100) {
      this.writeRateScale = Math.max(0.1, this.writeRateScale * 0.9);
    } else if (p99 < 50) {
      this.writeRateScale = Math.min(1.0, this.writeRateScale * 1.05);
    }
  }

  _relay(msg, exceptSocket, forceFlood = false) {
    const sendStart = Date.now();
    const data = JSON.stringify(msg);
    // Update adaptive backpressure before relay
    this._updateBackpressure();

    // DHT routing: route message via geohash bucket or fallback to broadcast.
    // forceFlood (DHT_FALLBACK_THRESHOLD ACK-timeout retry) bypasses bucket
    // selection entirely and sends to every connected peer.
    const targetPeers = forceFlood ? null : this._selectRoutingPeers(msg);

    for (const ws of this.sockets) {
      if (ws === exceptSocket) continue;
      // Only send if peer is in target list (DHT-routed)
      const peerKey = this._getPeerKey(ws);
      if (targetPeers && !targetPeers.has(peerKey) && this.DHT_ENABLED) continue;

      const state = ws.readyState;
      if (state === 1 /* OPEN */) {
        try {
          if (ws.send(data) !== false) {
            this.metrics.messagesSent++;
            this.metrics.bytesSent += data.length;
          }
          const sendMs = Date.now() - sendStart;
          this._recordLatency('send_ms', sendMs);
        } catch {
          // dead socket, will be cleaned up by its own close handler
        }
      }
    }
  }

  /**
   * Hierarchical multi-hop relay: this node just received `msg` and, instead
   * of only flooding it once to every connected peer (base _relay), forwards
   * it specifically toward peers whose OWN learned routing bucket is closer
   * to the message's target geohash than this node's neighbors in general —
   * repeated at each hop, this narrows the message toward the target bucket
   * across multiple relay steps rather than being bounded to one hop from
   * the origin. Bounded by DHT_MAX_HOPS (a hop counter carried on the
   * message itself) so it can never loop or run away; `_remember`'s dedup
   * (already applied before this is called) prevents redundant re-relay of
   * the same message id regardless of hop count.
   */
  _relayMultiHop(msg, exceptSocket) {
    // A non-numeric attacker-supplied _hops (e.g. a string) would make `+ 1`
    // silently do string concatenation instead of arithmetic, permanently
    // defeating the DHT_MAX_HOPS termination bound for that message across
    // every subsequent hop mesh-wide — coerce to a safe integer instead.
    const priorHops = typeof msg._hops === 'number' && Number.isFinite(msg._hops) ? msg._hops : 0;
    const hops = priorHops + 1;
    if (hops > this.DHT_MAX_HOPS) {
      this._relay(msg, exceptSocket); // hop budget exhausted: fall back to a normal single flood from here
      return;
    }
    const forwarded = { ...msg, _hops: hops };
    const targetPrefix = this._computeGeohash(msg.soul);
    const candidates = Array.from(this.sockets)
      .filter((ws) => ws !== exceptSocket)
      .map((ws) => ({ ws, pk: this._getPeerKey(ws) }))
      .filter(({ pk }) => this.peerHealthScores.has(pk));

    // Prefer peers whose learned routing key matches the target prefix more
    // tightly than a generic flood would — peers with an exact/longer prefix
    // match are "closer" to the target bucket in the multi-hop sense.
    const scored = candidates.map(({ ws, pk }) => {
      const rk = this.peerRoutingKeys.get(pk);
      const matchLen = rk ? commonPrefixLength(rk, targetPrefix) : 0;
      return { ws, pk, matchLen };
    }).sort((a, b) => b.matchLen - a.matchLen);

    const K = this.DHT_K;
    const forwardTo = scored.slice(0, Math.max(K, 1));
    if (forwardTo.length === 0) return;

    const data = JSON.stringify(forwarded);
    for (const { ws } of forwardTo) {
      if (ws.readyState === 1) {
        try {
          ws.send(data);
          this.metrics.messagesSent++;
          this.metrics.bytesSent += data.length;
        } catch { /* dead socket, cleaned up by its own close handler */ }
      }
    }
  }

  _getPeerKey(ws) {
    // An iroh socket carries a stable Ed25519 EndpointId-derived key (set once at
    // registration) — unlike ws's ephemeral address:port, it identifies the same
    // physical peer across reconnects, so reputation/routing key it consistently.
    if (ws._peerKey) return ws._peerKey;
    // Get unique identifier for peer (address:port or UUID in browser)
    if (isNode && ws._socket) {
      return ws._socket.remoteAddress + ':' + ws._socket.remotePort;
    }
    return ws.url || 'unknown';
  }

  _selectRoutingPeers(msg) {
    // Health-aware DHT selection over CONNECTED peers (peerHealthScores is
    // auto-populated from real socket activity, so this returns live peers by
    // default). Route to K healthiest peers in the soul's geohash bucket, plus
    // L adjacent peers for healing; fall back to flood-fill when too few match.
    const K = this.DHT_K;
    const L = this.DHT_L;
    const selected = new Set();

    // DHT disabled: pure flood-fill to all connected peers.
    if (!this.DHT_ENABLED) {
      for (const ws of this.sockets) selected.add(this._getPeerKey(ws));
      return selected;
    }

    const soul = msg.soul || msg.id;
    const connected = Array.from(this.sockets).map(ws => this._getPeerKey(ws));
    if (!soul || connected.length === 0) {
      for (const pk of connected) selected.add(pk);
      return selected;
    }

    // Bounded-subset routing is only meaningful for keychain-derived souls
    // (they have a real geohash bucket to route within). For any other
    // soul there is no bucket to narrow to, so DHT routing must flood-fill
    // rather than silently truncate to the K+L healthiest peers — without
    // this, _getPrefixMatches' own "non-keychain soul: flood-fill" intent
    // never actually took effect, because useBucket below saw ALL peers as
    // "matching" and picked only the top K+L of them with no fallback.
    if (!this._isKeychainDerived(soul)) {
      for (const pk of connected) selected.add(pk);
      return selected;
    }

    // Rank connected peers by health (lower latency/less loss = better).
    const ranked = connected
      .map(pk => ({ pk, health: this.peerHealthScores.get(pk) || { latency: this.opts.maxLatency || 500, loss: 0 } }))
      .sort((a, b) => (a.health.latency - 100 * a.health.loss) - (b.health.latency - 100 * b.health.loss));

    // Prefer peers whose routing bucket matches the soul's geohash prefix.
    const bucketedKeys = this._getPrefixMatches(soul, ranked.map(e => e.pk));
    const useBucket = bucketedKeys.length >= Math.ceil(K / 2);
    const candidateKeys = useBucket ? bucketedKeys : ranked.map(e => e.pk);

    const rankedCandidates = candidateKeys
      .map(pk => ranked.find(e => e.pk === pk))
      .filter(Boolean);

    for (let i = 0; i < Math.min(K, rankedCandidates.length); i++) selected.add(rankedCandidates[i].pk);
    for (let i = 0; i < L && (K + i) < ranked.length; i++) selected.add(ranked[K + i].pk);

    // Flood-fill fallback if bucket yield was too thin.
    if (selected.size < Math.ceil(K / 2)) {
      for (const pk of connected) selected.add(pk);
    }
    return selected;
  }

  _computeGeohash(soul) {
    // Bucket precision honors the documented dhtGeohashLength knob (this.DHT_
    // GEOHASH_LENGTH) instead of a hardcoded 4 — previously the config option
    // was accepted and stored but the two geohash paths both hardcoded a
    // 4-char prefix, so setting dhtGeohashLength had no effect on bucketing.
    // Every caller pre-guards on _isKeychainDerived(soul), so soul is always a
    // 64-hex keychain pubkey here — a prefix of it is a valid deterministic
    // bucket. Non-keychain souls flood-fill and never reach this method.
    return soul.substring(0, this.DHT_GEOHASH_LENGTH);
  }

  _recordLatency(op, ms) {
    this.latencies[op].push(ms);
    if (this.latencies[op].length > this.maxLatencySamples) {
      this.latencies[op].shift();
    }
  }

  _computePercentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  getMetrics() {
    const p50send = this._computePercentile(this.latencies.send_ms, 50);
    const p90send = this._computePercentile(this.latencies.send_ms, 90);
    const p99send = this._computePercentile(this.latencies.send_ms, 99);
    const p50recv = this._computePercentile(this.latencies.receive_ms, 50);
    const p90recv = this._computePercentile(this.latencies.receive_ms, 90);
    const p99recv = this._computePercentile(this.latencies.receive_ms, 99);
    return {
      ...this.metrics,
      writeRateScale: this.writeRateScale,
      latencies: {
        send_ms: { p50: p50send, p90: p90send, p99: p99send, samples: this.latencies.send_ms.length },
        receive_ms: { p50: p50recv, p90: p90recv, p99: p99recv, samples: this.latencies.receive_ms.length }
      }
    };
  }

  /**
   * Update peer health score (latency + loss rate) via a bounded moving
   * average. `count` is capped at HEALTH_AVERAGE_WINDOW so a long-lived
   * peer's score stays responsive to recent behavior instead of becoming
   * increasingly resistant to change the longer the connection has lived.
   */
  updatePeerHealth(peerId, latency, loss = 0) {
    const window = this.opts.dhtHealthAverageWindow || 100;
    const existing = this.peerHealthScores.get(peerId) || { latency: 0, loss: 0, count: 0 };
    const n = Math.min(existing.count, window);
    existing.latency = (existing.latency * n + latency) / (n + 1);
    existing.loss = (existing.loss * n + loss) / (n + 1);
    existing.count = Math.min(existing.count + 1, window);
    existing.lastSeen = Date.now();
    this.peerHealthScores.set(peerId, existing);
  }

  /** Get peers sorted by health (latency ascending, loss descending). */
  getHealthyPeers() {
    const peers = Array.from(this.peerHealthScores.entries());
    return peers.sort((a, b) => {
      const scoreA = a[1].latency - (100 * a[1].loss); // lower = better
      const scoreB = b[1].latency - (100 * b[1].loss);
      return scoreA - scoreB;
    }).map(p => p[0]);
  }

  /**
   * Record reputation delta (append-only). Reasons: 'good', 'malformed',
   * 'replay', 'byzantine', 'routing-help'. When `onReputationDelta` is
   * wired (see Nevil._boot), the entry is also durably persisted so a
   * restart doesn't reset every peer's throttle/Byzantine state to
   * neutral — without it the ledger is memory-only for this process.
   */
  updateReputation(peerId, delta, reason = 'good') {
    const entry = { peerId, delta, reason, timestamp: Date.now() };
    this._pushReputationLedger(entry);
    const currentRep = this.reputationCache.get(peerId) || 0;
    this._setReputationCache(peerId, currentRep + delta);
    if (this.onReputationDelta) this.onReputationDelta(entry);
    return entry;
  }

  /**
   * Push onto the bounded reputationLedger FIFO, tracking how many entries
   * have ever been shifted out. A length-based gossip cursor (nevil.js)
   * would otherwise silently misalign once shifting starts: `.length` stays
   * capped at maxReputationLedger while indices keep moving, so a stored
   * "sent up to length N" cursor no longer names the same position.
   * `reputationLedgerShifted + reputationLedger.length` is the true total
   * ever pushed, giving consumers a stable basis to compute what's new.
   */
  _pushReputationLedger(entry) {
    this.reputationLedger.push(entry);
    if (this.reputationLedger.length > this.maxReputationLedger) {
      this.reputationLedger.shift();
      this.reputationLedgerShifted = (this.reputationLedgerShifted || 0) + 1;
    }
  }

  /** Replay a previously-persisted reputation ledger (called on boot before any live traffic). */
  restoreReputationLedger(entries) {
    for (const entry of entries) {
      this._pushReputationLedger(entry);
      const currentRep = this.reputationCache.get(entry.peerId) || 0;
      this._setReputationCache(entry.peerId, currentRep + entry.delta);
    }
  }

  /** Get current reputation score (sum of all deltas). */
  getReputation(peerId) {
    return this.reputationCache.get(peerId) || 0;
  }

  /** Get reputation ledger entries for peer. */
  getReputationLedger(peerId) {
    return this.reputationLedger.filter(e => e.peerId === peerId);
  }

  /**
   * Drain queued messages from senders whose reputation has since recovered
   * to 'accept'. Re-checks each queued entry's current throttle state rather
   * than assuming recovery; entries still throttled are re-queued up to
   * QUEUE_MAX_RETRIES before being dropped, so a permanently low-reputation
   * sender's backlog doesn't sit in memory forever.
   */
  _drainQueue() {
    if (!this.messageQueue || this.messageQueue.length === 0) return;
    const remaining = [];
    for (const item of this.messageQueue) {
      const state = this.getThrottleState(item.senderId);
      if (state === 'accept') {
        this.metrics.messagesReceived++;
        this.onMessage(item.msg);
        if (this.POW_ADAPTIVE && item.msg.type === 'put') this._recordPowRateSample();
        if (this.DHT_MULTIHOP_ENABLED && this.DHT_ENABLED && this._isKeychainDerived(item.msg.soul)) {
          this._relayMultiHop(item.msg, null);
        } else {
          this._relay(item.msg, null);
        }
      } else if (state === 'queue' && item.retries < this.QUEUE_MAX_RETRIES) {
        item.retries++;
        remaining.push(item);
      } // 'drop' or retries exhausted: dropped, not re-queued
    }
    this.messageQueue = remaining;
  }

  _scheduleQueueDrain() {
    if (this._queueDrainTimer) return;
    this._queueDrainTimer = setTimeout(() => {
      this._queueDrainTimer = null;
      this._drainQueue();
      if (this.messageQueue && this.messageQueue.length > 0) this._scheduleQueueDrain();
    }, this.QUEUE_RETRY_DELAY);
    if (this._queueDrainTimer.unref) this._queueDrainTimer.unref();
  }

  /**
   * Decide message throttle state: accept (>=REP_ACCEPT_THRESHOLD), drop
   * (<REP_DROP_THRESHOLD), queue otherwise (the band between them).
   * REP_DROP_THRESHOLD was previously assigned but never read here —
   * REP_QUEUE_MIN alone silently did double duty as the real drop cutoff,
   * leaving repDropThreshold a phantom config option with zero effect. Both
   * default to -10, so this is a behavioral no-op for default config;
   * explicitly using REP_DROP_THRESHOLD here makes repDropThreshold a
   * genuinely live knob, matching AGENTS.md's documented Reputation Ledger
   * config list. REP_QUEUE_MIN is no longer consulted here.
   */
  getThrottleState(peerId) {
    const rep = this.getReputation(peerId);
    if (rep >= this.REP_ACCEPT_THRESHOLD) return 'accept';
    if (rep < this.REP_DROP_THRESHOLD) return 'drop';
    return 'queue';
  }

  /** Check if peer is in Byzantine isolation (reputation < threshold). */
  isByzantineIsolated(peerId, threshold = -20) {
    return this.getReputation(peerId) < threshold;
  }

  /**
   * Tear down every open socket, pending timer, and the attached
   * WebSocketServer (if any). `http.Server.close()`/`WebSocketServer.close()`
   * alone only stop ACCEPTING new connections — already-open sockets and
   * scheduled setTimeout handles (redial, queue drain, DHT ACK fallback)
   * keep the event loop alive indefinitely, so an embedding process could
   * never exit cleanly without this.
   */
  close() {
    this._closed = true; // guards _dial against a redial timer that outlives close()
    if (this._queueDrainTimer) { clearTimeout(this._queueDrainTimer); this._queueDrainTimer = null; }
    if (this._powAdjustTimer) { clearInterval(this._powAdjustTimer); this._powAdjustTimer = null; }
    if (this._redialTimers) { for (const timer of this._redialTimers) clearTimeout(timer); this._redialTimers.clear(); }
    if (this._dhtFallbackTimers) { for (const timer of this._dhtFallbackTimers) clearTimeout(timer); this._dhtFallbackTimers.clear(); }
    for (const ws of this.sockets) {
      ws._redialScheduled = true; // suppress self-heal redial on close
      try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* already closed */ }
    }
    this.sockets.clear();
    if (this.wss) { try { this.wss.close(); } catch { /* already closed */ } }
    // Tear down the iroh Endpoint + accept loop (async) so no QUIC handle keeps
    // the event loop alive. Returns a promise a graceful-shutdown caller can
    // await; ws-only callers get the prior synchronous teardown and can ignore
    // the return value. _irohReady may still be resolving (bind mid-flight) — wait
    // for it before closing so we never leak a just-bound endpoint.
    if (this.IROH_ENABLED) {
      return Promise.resolve(this._irohReady)
        .then((t) => (t || this._irohTransport) && (t || this._irohTransport).close())
        .catch(() => {});
    }
    return undefined;
  }
}

module.exports = { Network, isNode, randomId, canonicalJSON };
