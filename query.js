/**
 * query.js — a GraphQL-shaped query surface over the graph.
 *
 * WHY THIS SHAPE:
 * The whole point of "as familiar as existing databases, or GraphQL" is
 * that once souls are addressable (a plain field) or references
 * ({'#': soul}), the graph already has the exact shape GraphQL queries
 * traverse: start at a root node, select some scalar fields, and
 * recursively select fields on linked nodes. This module is a small,
 * synchronous "resolver" that walks a plain-object query description and
 * returns a plain-object result — no schema, no separate query language
 * to parse, because the graph's own soul-references already encode the
 * traversal paths a GraphQL schema would otherwise have to declare.
 *
 * Query shape:
 *   {
 *     soul: 'abcd...',              // required: where to start
 *     select: ['title', 'body'],    // scalar fields to return
 *     author: { via: 'author', select: ['name'] },       // -> one link
 *     comments: { via: 'comments', list: true, select: ['text'] } // -> many
 *   }
 *
 * - `select` lists plain scalar fields to copy through as-is.
 * - Any other key becomes a nested selection: `via` names the field on
 *   the current node holding a soul-reference (or an array of them, if
 *   `list: true`), and the nested object is itself a query (minus
 *   `soul`, since it's implied by the reference).
 * - Field aliasing works the same way GraphQL aliases do: the key you
 *   use in the query object is the key you get back in the result,
 *   regardless of what `via` points at.
 */

'use strict';

const { isRef } = require('./graph');

function selectScalars(node, fields) {
  const out = {};
  for (const f of fields || []) {
    if (node && f in node) out[f] = node[f];
  }
  return out;
}

/**
 * Sort comparator that pushes missing/undefined sort keys to the end
 * regardless of direction, instead of treating undefined===undefined as
 * equal-to-everything (which silently misordered results with mixed field
 * presence, since a present value could compare either way against an
 * absent one depending on array position).
 */
function compareSortKeys(av, bv, sortOrder) {
  const aMissing = av === undefined;
  const bMissing = bv === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1; // missing always sorts last
  if (bMissing) return -1;
  const cmp = av < bv ? -1 : av > bv ? 1 : 0;
  return sortOrder === 'desc' ? -cmp : cmp;
}

const FILTER_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in']);

// A nested-selection alias is always a plain object carrying `via` and/or
// `select`/`list`/etc — none of the reserved query directives' real values
// (filter conditions, sort specs, numbers, arrays, strings, booleans) are ever
// shaped like that. Used to tell "caller's directive value" apart from "a
// same-named field the caller chose as a nested-selection alias key" wherever
// a reserved key's value is consulted, not just in the alias-skip loop.
function isAliasShaped(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ('via' in v || 'select' in v || 'list' in v);
}

function applyFilter(node, filter) {
  if (!filter) return true;
  if (!node) return false;
  for (const [key, condition] of Object.entries(filter)) {
    if (!(key in node)) return false;
    const v = node[key];
    if (typeof condition === 'object' && condition !== null) {
      // An unrecognized operator key (e.g. a misspelled `$regex`) was
      // previously silently ignored — every condition using it degraded to
      // "no constraint", giving false-positive matches instead of surfacing
      // the mistake. A structurally-valid condition object must use only
      // known operators.
      for (const opKey of Object.keys(condition)) {
        if (!FILTER_OPERATORS.has(opKey)) {
          throw new Error(`query filter: unrecognized operator "${opKey}" on field "${key}"`);
        }
      }
      if ('$eq' in condition && v !== condition.$eq) return false;
      if ('$ne' in condition && v === condition.$ne) return false;
      if ('$gt' in condition && !(v > condition.$gt)) return false;
      if ('$gte' in condition && !(v >= condition.$gte)) return false;
      if ('$lt' in condition && !(v < condition.$lt)) return false;
      if ('$lte' in condition && !(v <= condition.$lte)) return false;
      if ('$in' in condition) {
        if (!Array.isArray(condition.$in)) return false;
        const matches = Array.isArray(v) ? v.some((item) => condition.$in.includes(item)) : condition.$in.includes(v);
        if (!matches) return false;
      }
    } else if (v !== condition) return false;
  }
  return true;
}

/**
 * Recursion depth is bounded (default 32, override via `q.maxDepth`) so a
 * cyclic graph can't stack-overflow. A cycle degrades to a truncated
 * sub-tree marker instead of throwing — one deep/cyclic branch shouldn't
 * fail the whole query when the rest of the result is perfectly valid.
 */
function resolveOne(graph, soul, q, depth, maxDepth) {
  // maxDepth is threaded explicitly from the ROOT query call, not re-read
  // per sub-query object: a nested selection with no maxDepth of its own
  // must inherit the caller's configured bound, not silently reset to the
  // 32 default (which would defeat a caller's intent to cap total depth).
  if (maxDepth === undefined) {
    // A non-numeric q.maxDepth (e.g. an object used as a nested-selection
    // alias, or a typo'd non-number) must not silently defeat the cutoff by
    // making `depth > maxDepth` compare against NaN (always false) — fall
    // back to the 32 default instead of trusting an invalid override.
    maxDepth = typeof q.maxDepth === 'number' && q.maxDepth >= 0 ? q.maxDepth : 32;
  }
  const node = graph.get(soul);
  if (depth > maxDepth) {
    // A node that the active filter would exclude must still be excluded at
    // the depth cutoff — returning the _depthExceeded stub before filtering
    // let a filtered-out node leak into results exactly at the maxDepth
    // boundary, since applyFilter was previously only reached in the
    // non-cutoff branch below.
    if (!isAliasShaped(q.filter) && !applyFilter(node, q.filter)) return null;
    // Include the node's own requested scalar fields at the cutoff so a
    // caller can't misread "field omitted" as "field is empty" — only
    // further nested traversal is actually truncated here. selectScalars is
    // spread FIRST so the engine's own soul/_depthExceeded control fields
    // always win over a same-named field in the node's own data.
    return { ...selectScalars(node, q.select), soul, _depthExceeded: true };
  }
  if (!node) return null;

  if (!isAliasShaped(q.filter) && !applyFilter(node, q.filter)) return null;

  // selectScalars spread first: the true soul identifier must win over a
  // node field literally named `soul` included in q.select, never be
  // silently overwritten by it. q.select itself may be alias-shaped (used as
  // a nested-selection key rather than the scalar-fields directive), in which
  // case there is no real select list to apply here.
  const out = { ...selectScalars(node, isAliasShaped(q.select) ? undefined : q.select), soul };

  for (const key of Object.keys(q)) {
    // Reserved query-directive keys, not resolvable as a nested-selection alias
    // UNLESS the value at that key doesn't match the directive's own expected
    // shape — in which case a caller-chosen nested field of the same name is a
    // legitimate alias and must still resolve. Each directive's expected shape:
    // `souls`/`select` -> array, `filter`/`sort` -> plain non-alias object or
    // string, `via` -> string, `list` -> boolean, `limit`/`offset`/`maxDepth`
    // -> number, `mapToRows` -> boolean.
    if (key === 'soul') continue;
    if (key === 'souls' && Array.isArray(q.souls)) continue;
    if (key === 'select' && Array.isArray(q.select)) continue;
    if (key === 'via' && typeof q.via === 'string') continue;
    if (key === 'list' && typeof q.list === 'boolean') continue;
    if (key === 'filter' && !isAliasShaped(q.filter)) continue;
    if (key === 'sort' && !isAliasShaped(q.sort)) continue;
    if (key === 'limit' && typeof q.limit === 'number') continue;
    if (key === 'offset' && typeof q.offset === 'number') continue;
    if (key === 'maxDepth' && typeof q.maxDepth === 'number') continue;
    if (key === 'mapToRows' && typeof q.mapToRows === 'boolean') continue;
    const sub = q[key];
    if (!sub || typeof sub !== 'object') continue;

    const fieldName = sub.via || key;
    const raw = node[fieldName];

    if (sub.list) {
      const refs = Array.isArray(raw) ? raw : [];
      const seenSouls = new Set();
      let resolved = refs
        .filter((r) => {
          if (!isRef(r)) return false;
          if (seenSouls.has(r['#'])) return false; // a node listing the same soul twice must not duplicate rows
          seenSouls.add(r['#']);
          return true;
        })
        .map((r) => resolveOne(graph, r['#'], sub, depth + 1, maxDepth))
        .filter((v) => v !== null);

      if (sub.sort) {
        const [sortKey, sortOrder] = Array.isArray(sub.sort) ? sub.sort : [sub.sort, 'asc'];
        resolved.sort((a, b) => compareSortKeys(a[sortKey], b[sortKey], sortOrder));
      }

      if (sub.offset != null) {
        if (sub.offset < 0) throw new Error('query offset must not be negative');
        resolved = resolved.slice(sub.offset);
      }
      if (sub.limit != null) {
        if (sub.limit < 0) throw new Error('query limit must not be negative');
        resolved = resolved.slice(0, sub.limit);
      }

      out[key] = resolved;
    } else if (isRef(raw)) {
      out[key] = resolveOne(graph, raw['#'], sub, depth + 1, maxDepth);
    } else {
      out[key] = null;
    }
  }

  return out;
}

/**
 * Run a query. `q.soul` can be a single soul string, or `q.souls` can be
 * an array of souls to run the same selection against (returns an array).
 *
 * Enhanced syntax (SQL/GraphQL compatible):
 * - filter: { key: value } or { key: { $eq, $ne, $gt, $gte, $lt, $lte, $in } }
 * - sort: 'fieldName' or ['fieldName', 'desc'] (default 'asc')
 * - limit: N (max results)
 * - offset: N (skip N results)
 * - mapToRows: boolean (if true, strips 'soul' and returns { row1: v1, row2: v2, ... })
 */
function query(graph, q) {
  let results;
  if (Array.isArray(q.souls)) {
    // Dedup duplicate souls in the input array — the nested `list`-selection
    // path in resolveOne already dedupes via `seenSouls`; this top-level
    // multi-soul path previously didn't, so `{ souls: ['a','a','b'] }`
    // returned soul 'a' twice while the equivalent nested case wouldn't.
    const seenSouls = new Set();
    const dedupedSouls = q.souls.filter((s) => {
      if (seenSouls.has(s)) return false;
      seenSouls.add(s);
      return true;
    });
    results = dedupedSouls.map((soul) => resolveOne(graph, soul, q, 0)).filter((r) => r !== null);

    if (q.sort) {
      const [sortKey, sortOrder] = Array.isArray(q.sort) ? q.sort : [q.sort, 'asc'];
      results.sort((a, b) => compareSortKeys(a[sortKey], b[sortKey], sortOrder));
    }

    if (q.offset != null) {
      if (q.offset < 0) throw new Error('query offset must not be negative');
      results = results.slice(q.offset);
    }
    if (q.limit != null) {
      if (q.limit < 0) throw new Error('query limit must not be negative');
      results = results.slice(0, q.limit);
    }

    if (q.mapToRows === true) {
      return results.map((r) => {
        const row = { ...r };
        delete row.soul;
        return row;
      });
    }

    return results;
  }
  if (!q.soul) throw new Error('query requires either `soul` or `souls`');
  const result = resolveOne(graph, q.soul, q, 0);
  if (result === null) return null;

  if (q.mapToRows === true) {
    const row = { ...result };
    delete row.soul;
    return row;
  }

  return result;
}

module.exports = { query };
