## 2026-07-09 — nevil "transcendences" were phantom; fixed via audit + fan-out

Goal (G): enumerate and fix all real limitations in the `nevil` project (GUN-like
graph DB: graph + keychain + crypto + storage + network + query).

What drifted / what went wrong:
- AGENTS.md and README claimed "zero limitations / all four transcendences fully
  implemented & witnessed / Residuals: None." A code audit proved otherwise:
  1. DHT routing delivered to ZERO peers by default (empty `peerHealthScores`,
     `_relay` filtered by socket peerKey that never matched the health-map keys).
  2. Lamport clock was decorative — HAM resolved purely on wall-clock `Date.now()`.
  3. Reputation ledger was disconnected — `nevil` kept a SECOND separate ledger
     that was never fed; the network ledger stayed at 0 -> throttle always 'accept'.
  4. `BTreeIndex` was dead code — never imported by `storage.js`/`nevil.js`; the
     real index was a plain `Set` (SoulIndex).
- The "witness" scripts passed only because they HAND-FED state the system never
  produced (manual `updatePeerHealth`, manual reputation), and one integration test
  ASSERTED THE BUG (signature drop) rather than the fix.
- Two real source bugs surfaced during verification: (a) signature signed the body
  BEFORE `broadcast()` injected `id`/`lamportClock`, so receiver rebuilt body in a
  different key order -> verify failed; (b) `_lamportClock` never advanced on plain
  writes, so gossiped messages (clock 0) were dropped by the replay gate.

Fix / resolution:
- DHT: health auto-populated from real socket traffic; routing over connected
  peers via geohash bucket + K-healthiest + L-adjacent + flood-fill fallback;
  reconnect on close.
- Lamport: clock threaded into HAM (clock > ts > canonical value); nevil passes
  remote clock on apply and auto-advances per local write.
- Reputation: single network ledger, auto-fed by malformed/replay/bad-sig drops,
  gossiped; throttle now live.
- B-tree: `BTreeIndex` wired as the real `Storage` index; `get` binary-searches
  SSTable ranges.
- Signing: canonical (sorted-key) JSON on both sides; clock auto-advances.
- Rewrote all five witness scripts to exercise REAL loopback-socket delivery,
  convergence, in-flow throttle, and B-tree-in-storage; all pass under `node`.

Generalizes to: in this project, treat AGENTS.md/README "implemented & witnessed"
claims as HYPOTHESES — verify by reading the actual code path and running a real
execution, never by the prose. The gm spool boot is unreliable here (network-
blocked `plugkit-wasm` extract on version drift, repeated abort) — fall back to
native `node tools/*.js` / file tools when the spool is dead. Watch for "witness"
tests that hand-feed internal state: they validate isolated methods, not the
integrated path, and can hide exactly the phantom work they claim to rule out.

## 2026-07-12 -- gm-plugkit watcher dies mid-index-rebuild (installed wrapper stale)
Goal (G): Execute the 41-row cross-repo minimal-code destructive plan across gm/rs-plugkit/rs-search/rs-codeinsight/rs-exec/nevil/wireweave/anentrypoint, minimal code max impact, gm improved via workflow-forge, all pushed to main as lanmower with CI green.
What drifted / what went wrong: The gm-plugkit spool watcher dies ~1-2 min after every boot on this Windows box. Root cause isolated by process-of-elimination: supervisor.js:342-354 kills the watcher when status heartbeat age > STATUS_STALE_MS (30s) UNLESS status.busy_until > now. The synchronous code-index embed rebuild (17 deferred files x 133MB BAAI/bge model) blocks the heartbeat for >30s. The REPO wrapper (gm/gm-plugkit/plugkit-wasm-wrapper.js:4405 MAX_WARMUP_PASSES loop) refreshes busy_until each pass to survive this; the INSTALLED wrapper (~/.gm-tools, bundled from gm-plugkit@2.0.1867, mtime older) lacks/underuses that loop, so busy_until lapses and the supervisor kills it. Repo and installed wrappers differ by ~10k lines (installed is a bundled/transpiled build, NOT a copy of the source) so you CANNOT just cp the repo source over the installed bundle.
Fix / resolution: Do not fight the spool for the mission. Drive all real work (multi-agent Workflow tool + direct Edit/Bash/cargo/node/git) natively per the prior lesson; treat gm PRD verbs as best-effort. The proper wrapper fix is a clean reinstall of the gm-plugkit build that includes the warmup loop (part of the plugkit-warmup-loop-fix row), landed via the gm-repo execution group, not manual bundle surgery.
Generalizes to: On this machine, a fresh nevil spool triggers a full code-index re-embed that can outlast the 30s heartbeat window and get the watcher supervisor-killed. Native tools are the reliable execution surface; the spool is optional bookkeeping. When the watcher dies repeatedly, check installed-vs-repo wrapper drift and busy_until lapse before assuming a crash.
