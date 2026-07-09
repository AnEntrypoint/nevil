/**
 * network.js — the DAM/AXE-equivalent transport + routing layer.
 *
 * Preference: plain WebSockets + flood-fill gossip, not a DHT-style
 * routing overlay. AXE exists to avoid broadcasting every write to
 * every peer once a mesh has hundreds of nodes; building a correct
 * DHT is a substantial project on its own and only pays off at a scale
 * this composite doesn't target. Flood-fill (relay every new message to
 * every connected peer except the one it came from, deduped by message
 * id) is trivially correct and easy to audit — the tradeoff, stated
 * plainly: O(peers) traffic per write instead of O(log peers). Fine for
 * small-to-medium meshes (tens of peers); not a scale-to-thousands
 * design.
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
    this.reputationCache = new Map(); // peerId -> total reputation sum

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
    ws.addEventListener ? ws.addEventListener('open', () => {}) : null;
    this._attach(ws);
  }

  _attach(ws) {
    this.sockets.add(ws);
    this.metrics.peersConnected = this.sockets.size;
    const handleClose = () => {
      this.sockets.delete(ws);
      this.metrics.peersConnected = this.sockets.size;
    };
    const handleMessage = (raw) => {
      const recvStart = Date.now() + Math.random() / 1000;
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.data ?? raw.toString());
      } catch {
        return; // malformed frame, drop silently
      }
      if (!msg.id || !this._remember(msg.id)) return; // already seen, stop the flood here
      // Signature verification: keypear-derived sender authenticity
      if (msg.sender && msg.signature && !this._verifySignature(msg.sender, msg, msg.signature)) {
        this.metrics.signatureDropped = (this.metrics.signatureDropped || 0) + 1;
        return; // signature failed, drop silently
      }
      // Lamport clock gate: reject out-of-order or rollback clocks
      if (msg.lamportClock !== undefined) {
        const peerId = msg.sender || 'unknown';
        const lastClock = this.peerClocks = this.peerClocks || new Map();
        const prior = lastClock.get(peerId) || 0;
        if (msg.lamportClock <= prior) {
          this.metrics.clockDropped = (this.metrics.clockDropped || 0) + 1;
          return; // clock did not advance, possible replay/rollback
        }
        lastClock.set(peerId, msg.lamportClock);
      }
      // PoW verification: if message includes PoW, verify before relaying
      if (msg.pow && !this._verifyPoW(msg.soul, msg.pow)) {
        this.metrics.powDropped = (this.metrics.powDropped || 0) + 1;
        return; // PoW failed, drop silently
      }
      this.metrics.messagesReceived++;
      const recvMs = Date.now() + Math.random() / 1000 - recvStart;
      this._recordLatency('receive_ms', recvMs);
      // Reputation gossip: update cache if message includes reputation data
      if (msg.reputationLedger && Array.isArray(msg.reputationLedger)) {
        for (const entry of msg.reputationLedger) {
          const sum = this.reputationCache.get(entry.peerId) || 0;
          this.reputationCache.set(entry.peerId, sum + entry.delta);
        }
      }
      this.onMessage(msg);
      this._relay(msg, ws); // flood to every other connected peer
    };

    if (isNode) {
      ws.on('close', handleClose);
      ws.on('message', handleMessage);
      ws.on('error', handleClose);
    } else {
      ws.addEventListener('close', handleClose);
      ws.addEventListener('message', handleMessage);
      ws.addEventListener('error', handleClose);
    }
  }

  /** Send a message to every connected peer, marking it seen locally first. */
  broadcast(payload) {
    const msg = { id: randomId(), ...payload };
    this._remember(msg.id);
    this._relay(msg, null);
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
      const msgBody = JSON.stringify(msgCopy);
      const sigBuf = Buffer.from(signature, 'hex');
      return sodium.crypto_sign_verify_detached(sigBuf, Buffer.from(msgBody), publicKeyBuf);
    } catch (e) {
      return false;
    }
  }

  _verifyPoW(soul, pow) {
    // Verify PoW: check that leading_zeros(sha256(soul || nonce)) >= difficulty
    if (!pow || typeof pow.nonce !== 'number' || typeof pow.difficulty !== 'number') return false;
    const crypto = require('crypto');
    const input = soul + ':' + pow.nonce;
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    const leadingZeros = hash.match(/^0*/)[0].length;
    return leadingZeros >= pow.difficulty;
  }

  _getPrefixMatches(soul, peers) {
    // Extract prefix from soul: first 4 hex chars = 16 bits
    if (!this._isKeychainDerived(soul)) return peers; // fallback: flood-fill
    const soulPrefix = soul.substring(0, 4);
    // Return only peers whose peerId matches the prefix (if available)
    return peers; // TODO: implement peer ID tracking for prefix-based routing
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

  _relay(msg, exceptSocket) {
    const sendStart = Date.now() + Math.random() / 1000;
    const data = JSON.stringify(msg);
    // Update adaptive backpressure before relay
    this._updateBackpressure();
    for (const ws of this.sockets) {
      if (ws === exceptSocket) continue;
      const state = isNode ? ws.readyState : ws.readyState;
      if (state === 1 /* OPEN */) {
        try {
          ws.send(data);
          this.metrics.messagesSent++;
          this.metrics.bytesSent += data.length;
          const sendMs = Date.now() + Math.random() / 1000 - sendStart;
          this._recordLatency('send_ms', sendMs);
        } catch {
          // dead socket, will be cleaned up by its own close handler
        }
      }
    }
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

  /** Update peer health score (latency + loss rate). */
  updatePeerHealth(peerId, latency, loss = 0) {
    const existing = this.peerHealthScores.get(peerId) || { latency: 0, loss: 0, count: 0 };
    existing.latency = (existing.latency * existing.count + latency) / (existing.count + 1);
    existing.loss = (existing.loss * existing.count + loss) / (existing.count + 1);
    existing.count++;
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
}

module.exports = { Network, isNode };
