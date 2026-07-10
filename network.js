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
    this.writeRateScale = 1.0; // adaptive backpressure: scale factor for batch size
    this.dhtTable = []; // append-only routing table for multi-level DHT
    this.peerHealthScores = new Map(); // peerId -> {latency, loss, lastSeen}
    this.peerRoutingKeys = new Map(); // peerKey -> routing prefix (learned), unknown = include all
    this.dialedUrls = new Set(this.opts.peers || []); // urls we dialed (vs server-attached)
    this.reputationLedger = []; // bounded: {peerId, delta, reason, ts}
    this.maxReputationLedger = opts.maxReputationLedger || 20000; // FIFO cap on in-memory ledger (durable log is unaffected, see storage.js)
    this.reputationCache = new Map(); // peerId -> total reputation sum (sum of all deltas)
    this.messageQueue = []; // messages queued from throttled peers

    // DHT tuning parameters
    this.DHT_K = opts.dhtK || 3; // K-nearest peers per bucket
    this.DHT_L = opts.dhtL || 2; // L adjacent buckets to gossip to
    this.DHT_GEOHASH_LENGTH = opts.dhtGeohashLength || 4; // geohash precision (4-8 chars)
    this.DHT_HEALTH_UPDATE_FREQ = opts.dhtHealthUpdateFreq || 5000; // update health every 5s
    this.DHT_FALLBACK_THRESHOLD = opts.dhtFallbackThreshold || 3000; // fallback to broadcast after 3s no ACK
    this.DHT_ENABLED = opts.dhtEnabled !== false; // enable DHT (default true)

    // Lamport clock guards
    this.CLOCK_MAX_JUMP = opts.clockMaxJump || 1000; // max clock steps ahead allowed
    this.CLOCK_FAST_THRESHOLD = opts.clockFastThreshold || 1000; // steps/sec for Byzantine detection
    this.CLOCK_CONSENSUS_SPREAD = opts.clockConsensusSpread || 10000; // max acceptable peer clock spread

    // Reputation thresholds
    this.REP_ACCEPT_THRESHOLD = opts.repAcceptThreshold || 0; // score >= this: accept
    this.REP_QUEUE_MIN = opts.repQueueMin || -10; // score in [-10, 0): queue
    this.REP_DROP_THRESHOLD = opts.repDropThreshold || -10; // score < -10: drop
    this.REP_DELTA_GOOD = opts.repDeltaGood || 1; // +1 for valid write
    this.REP_DELTA_MALFORMED = opts.repDeltaMalformed || -1; // -1 for malformed
    this.REP_DELTA_REPLAY = opts.repDeltaReplay || -5; // -5 for replay/duplicate
    this.REP_DELTA_BYZANTINE = opts.repDeltaByzantine || -3; // -3 for Byzantine behavior
    this.REP_DELTA_ROUTING_HELP = opts.repDeltaRoutingHelp || 10; // +10 for routing help
    this.QUEUE_RETRY_DELAY = opts.queueRetryDelay || 5000; // retry queued messages every 5s
    this.QUEUE_MAX_RETRIES = opts.queueMaxRetries || 5; // max retries before drop

    // Proof-of-work rate-limiting (hashcash-style), optional, orthogonal to reputation
    this.POW_ENABLED = opts.powEnabled === true; // default off — reputation ledger alone is the default throttle
    this.POW_DIFFICULTY = opts.powDifficulty || 4; // leading hex zeros required

    if (isNode && this.opts.server) this._startServer();
    for (const url of this.opts.peers || []) this._dial(url);
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
    this.wss = new WebSocketServer({ server: this.opts.server, path: '/nevil' });
    this.wss.on('connection', (ws) => this._attach(ws));
  }

  _dial(url) {
    const WS = isNode ? require('ws') : WebSocket;
    const ws = new WS(url);
    ws._dialUrl = url;
    this._attach(ws);
  }

  _attach(ws) {
    this.sockets.add(ws);
    this.metrics.peersConnected = this.sockets.size;
    // Register the peer in the health map immediately so DHT routing sees
    // real connected peers by default (no external caller required).
    const peerKey = this._getPeerKey(ws);
    this.updatePeerHealth(peerKey, 0, 0);
    const handleOpen = () => { this.updatePeerHealth(this._getPeerKey(ws), 0, 0); };
    const handleClose = () => {
      this.sockets.delete(ws);
      this.metrics.peersConnected = this.sockets.size;
      // Self-heal: redial only sockets we initiated (not server-attached).
      if (ws._dialUrl && !ws._redialScheduled) {
        ws._redialScheduled = true;
        setTimeout(() => this._dial(ws._dialUrl), 2000);
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
        this._ackedIds = this._ackedIds || new Set();
        this._ackedIds.add(msg.id);
        if (this._ackedIds.size > this.maxSeen) this._ackedIds.delete(this._ackedIds.values().next().value);
        return; // already seen, stop the flood here
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
        this.updateReputation(this._getPeerKey(ws), this.REP_DELTA_BYZANTINE, 'byzantine');
        return; // unsigned write to an identity-addressed soul, drop and penalize
      }
      if (msg.sender && msg.signature && !this._verifySignature(msg.sender, msg, msg.signature)) {
        this.metrics.signatureDropped = (this.metrics.signatureDropped || 0) + 1;
        this.updateReputation(msg.sender, this.REP_DELTA_BYZANTINE, 'byzantine');
        return; // signature failed, drop and penalize sender
      }
      // Lamport clock gate: reject out-of-order or rollback clocks. Keyed per
      // CONNECTION (peerKey), not per claimed `msg.sender` — an unauthenticated
      // sender field is attacker-controlled, so bucketing by it (or by a shared
      // 'unknown' string when omitted) let any anonymous peer manipulate a
      // shared counter to block others. Per-socket tracking means an attacker
      // can only ever race against their own connection's prior clock.
      if (msg.lamportClock !== undefined) {
        const connKey = this._getPeerKey(ws);
        const lastClock = this.peerClocks = this.peerClocks || new Map();
        const prior = lastClock.get(connKey) || 0;
        if (msg.lamportClock <= prior) {
          this.metrics.clockDropped = (this.metrics.clockDropped || 0) + 1;
          this.updateReputation(msg.sender || connKey, this.REP_DELTA_REPLAY, 'replay');
          return; // clock did not advance, possible replay/rollback
        }
        lastClock.set(connKey, msg.lamportClock);
      }
      // PoW verification: when enabled, every write must carry a valid puzzle solution;
      // when a puzzle is present regardless of the flag, verify it (never trust unchecked work).
      if (this.POW_ENABLED && msg.type === 'put' && !this._verifyPoW(msg.soul, msg.pow)) {
        this.metrics.powDropped = (this.metrics.powDropped || 0) + 1;
        this.updateReputation(msg.sender || 'unknown', this.REP_DELTA_BYZANTINE, 'byzantine');
        return; // missing or invalid PoW, drop and penalize sender
      }
      if (!this.POW_ENABLED && msg.pow && !this._verifyPoW(msg.soul, msg.pow)) {
        this.metrics.powDropped = (this.metrics.powDropped || 0) + 1;
        this.updateReputation(msg.sender || 'unknown', this.REP_DELTA_BYZANTINE, 'byzantine');
        return; // PoW failed, drop and penalize sender
      }
      // Reputation gossip: fold in only entries not already applied. Each
      // sender now gossips its ledger tail (see nevil.js), but a message can
      // still be re-delivered via a different route, so dedup by identity
      // (peerId+delta+reason+timestamp) before summing — otherwise the same
      // historical delta gets re-added to reputationCache on every repeat
      // delivery, inflating scores far past the true sum of distinct deltas.
      if (msg.reputationLedger && Array.isArray(msg.reputationLedger)) {
        this._seenReputationEntries = this._seenReputationEntries || new Set();
        for (const entry of msg.reputationLedger) {
          if (!entry || typeof entry.peerId !== 'string' || typeof entry.delta !== 'number') continue;
          const entryKey = entry.peerId + '|' + entry.delta + '|' + entry.reason + '|' + entry.timestamp;
          if (this._seenReputationEntries.has(entryKey)) continue;
          this._seenReputationEntries.add(entryKey);
          if (this._seenReputationEntries.size > this.maxReputationLedger) {
            this._seenReputationEntries.delete(this._seenReputationEntries.values().next().value);
          }
          const sum = this.reputationCache.get(entry.peerId) || 0;
          this.reputationCache.set(entry.peerId, sum + entry.delta);
        }
      }
      // Throttle gating: check sender reputation and decide accept/queue/drop
      const senderId = msg.sender || 'unknown';
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
      this.updatePeerHealth(this._getPeerKey(ws), recvMs, 0);
      this.onMessage(msg);
      this._relay(msg, ws); // flood to every other connected peer
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
    this._relay(msg, null);
    // DHT_FALLBACK_THRESHOLD ACK timeout: a DHT-routed (non-flood-fill) send
    // to a bounded peer subset is fire-and-forget with no receipt signal, so
    // a message to an unresponsive bucket could otherwise vanish silently.
    // If no peer relays this id back to us (via _relay's re-broadcast of
    // already-seen ids, tracked in `seen`) within the threshold, re-send as
    // a true flood-fill to every connected peer.
    if (this.DHT_ENABLED && this.sockets.size > 0) {
      const timer = setTimeout(() => {
        if (!this._ackedIds?.has(msg.id)) this._relay(msg, null, true);
      }, this.DHT_FALLBACK_THRESHOLD);
      if (timer.unref) timer.unref();
    }
    return msg;
  }

  _isKeychainDerived(soul) {
    // Check if soul looks like a hex Ed25519 public key (64 hex chars)
    return /^[0-9a-f]{64}$/.test(soul);
  }

  _verifySignature(sender, msg, signature) {
    // Verify message signature: sender is keypear-derived soul (public key hex)
    // Signature covers: {soul, fields, ts, lamportClock, ...} (everything except id, sender, signature)
    if (!sender || !signature || typeof signature !== 'string') return false;
    try {
      const sodium = require('sodium-universal');
      const publicKeyHex = sender;
      const publicKeyBuf = Buffer.from(publicKeyHex, 'hex');
      const msgCopy = { ...msg };
      delete msgCopy.id;
      delete msgCopy.sender;
      delete msgCopy.signature;
      const msgBody = JSON.stringify(msgCopy, Object.keys(msgCopy).sort());
      const sigBuf = Buffer.from(signature, 'hex');
      return sodium.crypto_sign_verify_detached(sigBuf, Buffer.from(msgBody), publicKeyBuf);
    } catch (e) {
      return false;
    }
  }

  _verifyPoW(soul, pow) {
    // Verify PoW: check that leading_zeros(sha256(soul || nonce)) >= difficulty
    if (!pow || typeof pow.nonce !== 'number' || typeof pow.difficulty !== 'number') return false;
    if (pow.difficulty < this.POW_DIFFICULTY) return false; // can't satisfy the gate with a weaker puzzle
    const crypto = require('crypto');
    const input = soul + ':' + pow.nonce;
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    const leadingZeros = hash.match(/^0*/)[0].length;
    return leadingZeros >= pow.difficulty;
  }

  /** Solve a hashcash-style puzzle for `soul` at `difficulty` leading hex zeros. O(16^difficulty) expected iterations. */
  static solvePoW(soul, difficulty) {
    const crypto = require('crypto');
    let nonce = 0;
    for (;;) {
      const hash = crypto.createHash('sha256').update(soul + ':' + nonce).digest('hex');
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

      const state = isNode ? ws.readyState : ws.readyState;
      if (state === 1 /* OPEN */) {
        try {
          ws.send(data);
          this.metrics.messagesSent++;
          this.metrics.bytesSent += data.length;
          const sendMs = Date.now() - sendStart;
          this._recordLatency('send_ms', sendMs);
        } catch {
          // dead socket, will be cleaned up by its own close handler
        }
      }
    }
  }

  _getPeerKey(ws) {
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
    // Simplified geohash: use first 4 chars of soul if hex, else hash it
    if (this._isKeychainDerived(soul)) {
      return soul.substring(0, 4);
    }
    // Fallback: FNV-1a over the FULL soul (not just its first 4 chars) —
    // hashing only a short prefix meant distinct souls sharing that prefix
    // collided into the same bucket regardless of the rest of the string.
    let hash = 0x811c9dc5;
    for (let i = 0; i < soul.length; i++) {
      hash ^= soul.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').substring(0, 4);
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
      latencies: {
        send_ms: { p50: p50send, p90: p90send, p99: p99send, samples: this.latencies.send_ms.length },
        receive_ms: { p50: p50recv, p90: p90recv, p99: p99recv, samples: this.latencies.receive_ms.length }
      }
    };
  }

  /** Add DHT routing table entry (append-only): {geohashPrefix, peerId, latency, reputationMin}. */
  addDHTEntry(geohashPrefix, peerId, latency, reputationMin = 0) {
    const entry = { geohashPrefix, peerId, latency, reputationMin, timestamp: Date.now() };
    this.dhtTable.push(entry);
    return entry;
  }

  /** Get DHT entries matching soul prefix (L1-L2 lookup). */
  getDHTMatches(soul, geohashPrefix) {
    return this.dhtTable.filter(e =>
      e.geohashPrefix === geohashPrefix ||
      e.geohashPrefix === soul.substring(0, 4)
    );
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

  /** Update reputation cache (pull from gossip). */
  updateReputationCache(peerId, reputation) {
    this.reputationCache.set(peerId, reputation);
  }

  /** Get cached reputation for peer. */
  getReputationCache(peerId) {
    return this.reputationCache.get(peerId) || 0;
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
    this.reputationLedger.push(entry);
    if (this.reputationLedger.length > this.maxReputationLedger) this.reputationLedger.shift();
    const currentRep = this.reputationCache.get(peerId) || 0;
    this.reputationCache.set(peerId, currentRep + delta);
    if (this.onReputationDelta) this.onReputationDelta(entry);
    return entry;
  }

  /** Replay a previously-persisted reputation ledger (called on boot before any live traffic). */
  restoreReputationLedger(entries) {
    for (const entry of entries) {
      this.reputationLedger.push(entry);
      if (this.reputationLedger.length > this.maxReputationLedger) this.reputationLedger.shift();
      const currentRep = this.reputationCache.get(entry.peerId) || 0;
      this.reputationCache.set(entry.peerId, currentRep + entry.delta);
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
        this._relay(item.msg, null);
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

  /** Decide message throttle state: accept (>=0), queue ([-10,0)), or drop (<-10). */
  getThrottleState(peerId) {
    const rep = this.getReputation(peerId);
    if (rep >= 0) return 'accept';
    if (rep < -10) return 'drop';
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
    if (this._queueDrainTimer) { clearTimeout(this._queueDrainTimer); this._queueDrainTimer = null; }
    for (const ws of this.sockets) {
      ws._redialScheduled = true; // suppress self-heal redial on close
      try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* already closed */ }
    }
    this.sockets.clear();
    if (this.wss) { try { this.wss.close(); } catch { /* already closed */ } }
  }
}

module.exports = { Network, isNode };
