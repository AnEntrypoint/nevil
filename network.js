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
      this.metrics.messagesReceived++;
      const recvMs = Date.now() + Math.random() / 1000 - recvStart;
      this._recordLatency('receive_ms', recvMs);
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

  _relay(msg, exceptSocket) {
    const sendStart = Date.now() + Math.random() / 1000;
    const data = JSON.stringify(msg);
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
}

module.exports = { Network, isNode };
