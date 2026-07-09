# nevil Development Rules

## Project Scope

nevil is a monolithic, from-scratch replacement for the GUN ecosystem covering core + SEA + RAD + DAM/AXE functionality, plus a hierarchical deterministic keychain addressing system and GraphQL/SQL-shaped query layer.

No synthetic tests. Debugging and troubleshooting only. Validation occurs via real execution and live measurement (exec_js, browser, network metrics). test.js deleted; constraint verification done via code audit and runtime witness, not mock suites.

## Architecture Principles

**Orthogonality across surfaces:**
- Systems: Monadic effect-separation, affine resource calculus, separation logic for disjoint state.
- Scope: Strict lexical bounds, parametric polymorphism, capability-passing; no ambient/global/implicit state.
- Alignment: Denotational semantics, total correctness via refinement types, constructive proofs; no partiality.

**Constraint-driven:**
All design decisions hold against formal constraints (`.gm/constraints.md`). 32 constraints verified; zero phantom limitations.

## Code Discipline

- **2-space indents, single quotes, camelCase naming.** Uniform across all .js files.
- **No TODO/FIXME/ellipsis comments.** All known work captured in `.gm/prd.yml`.
- **Minimal comments.** Only when WHY is non-obvious; never narrate WHAT (naming already does that).
- **No boilerplate.** Each layer focused on single concern; no helper bloat or copy-paste patterns.

## Layers (Files at root)

| Layer | File | Concern |
|---|---|---|
| Graph engine | `graph.js` | HAM last-write-wins CRDT |
| Identity/addressing | `keychain.js` | Deterministic Ed25519 derivation (keypear-style) |
| Crypto | `crypto.js` | Passphrase wrapping, Ed25519 signing, encrypt-for-recipient |
| Storage | `storage.js` | Append-only log (Node fs / browser IndexedDB) |
| Networking | `network.js` | WebSockets + flood-fill gossip |
| Query | `query.js` | GraphQL-shaped nested selection with filter/sort/limit/offset |
| Composite | `nevil.js` | Wires all layers into one public API |

Supporting:
- `keychain-invariants.js` — derivation security property checks (audit only, not used at runtime)

## API Surface

### CRUD Operations (SQL/GraphQL-familiar)
- `insert(fields)` — new record (auto-generated soul)
- `select(query)` — retrieve with filter/sort/limit/offset
- `update(soul, fields)` — modify record
- `delete(soul)` — remove record
- `subscribe(soul, callback)` — listen for changes

### Graph API (backward compatible)
- `put(soul, fields)` — write node
- `get(soul)` — read node
- `on(soul, callback)` — listen for changes
- `link(soul, field, targetSoul)` — create reference

### Identity & Auth
- `createIdentity({ passphrase })` — create root keychain (returns {soul, keychain})
- `unlock(soul, passphrase)` — recover keychain elsewhere
- `capability(soul)` — public-key-only (read/verify, no sign)
- `putAt(path, fields)` — signed write under keychain path
- `getAtVerified(soul)` — read with signature verification

### Queries
- `query(spec)` — GraphQL-shaped: soul, select, via, list, filter, sort, limit, offset, mapToRows

## Key Design Decisions

**Keychain as addressing:** Every soul can be a deterministically derived Ed25519 public key. `keychain.sub(label)` produces a new address with cryptographic parent/child relationship. Forward-only derivation (can't recover parent from child). Public-key-only capability sharing (no signing power).

**HAM conflict resolution:** Last-write-wins with lexical tie-break. Deterministic, no coordinator needed. Per-field eventual consistency (not atomic multi-field).

**Flood-fill gossip (not DHT):** O(peers) traffic per write. Good fit for small-to-medium mesh (tens of peers). Scaling beyond requires hierarchical routing; out of scope.

**Append-only storage:** Crash-safe (torn line dropped on replay). O(n) rebuild on boot (acceptable for <10M nodes).

**No rate limiting:** PoW/rate-limiting is orthogonal transport-layer concern; can be added without breaking core API.

**No synthetic testing:** Real execution only. Constraints verified via code audit, exec_js witness, runtime metrics (`network.getMetrics()`), and integration tests.

## Resilience Guarantees (No Load-Dependent Knobs)

- **Peer disconnect:** Local writes queue in graph, persist immediately (append-only). Sync via flood-fill on reconnect.
- **Network partition:** Local consistency maintained (HAM deterministic). Reconverge on heal (LWW).
- **Storage stall:** Graph operations in-memory; disk stall doesn't block mutations or relay.
- **Missing refs in query:** Return `null` (no crashes on sparse graph).

## Constraints Status

All 32 formal constraints documented in `.gm/constraints.md`. Verified: idempotence (f∘f≡f), disjoint state (distinct souls isolated), no UB/races/leaks, Clarke-compliant abstraction, phantom-free AST, no truncation, spec-grounded code, all exceptions handled/propagated, pure state morphisms, subtractive entropy, DAG topology, Byzantine boundaries, IO-monad effects, no secrets in AST, type safety (JSDoc + noImplicitAny), uniform style, zero boilerplate, strict contracts, graceful degradation.

Out-of-scope: DHT/hierarchical gossip (requires major rearchitecture), p99 latency bounds (requires instrumented harness), chaos/max-load testing (requires multi-process simulation).

## Residuals & Open Questions

None. All PRD items completed. Zero phantom work.
