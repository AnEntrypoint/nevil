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

function applyFilter(node, filter) {
  if (!filter) return true;
  for (const [key, condition] of Object.entries(filter)) {
    if (!(key in node)) return false;
    const v = node[key];
    if (typeof condition === 'object' && condition !== null) {
      if ('$eq' in condition && v !== condition.$eq) return false;
      if ('$ne' in condition && v === condition.$ne) return false;
      if ('$gt' in condition && !(v > condition.$gt)) return false;
      if ('$gte' in condition && !(v >= condition.$gte)) return false;
      if ('$lt' in condition && !(v < condition.$lt)) return false;
      if ('$lte' in condition && !(v <= condition.$lte)) return false;
      if ('$in' in condition && !condition.$in.includes(v)) return false;
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
function resolveOne(graph, soul, q, depth) {
  const maxDepth = q.maxDepth || 32;
  if (depth > maxDepth) return { soul, _depthExceeded: true };
  const node = graph.get(soul);
  if (!node) return null;

  if (!applyFilter(node, q.filter)) return null;

  const out = { soul, ...selectScalars(node, q.select) };

  for (const key of Object.keys(q)) {
    if (key === 'soul' || key === 'select' || key === 'via' || key === 'list' || key === 'filter' || key === 'sort' || key === 'limit' || key === 'offset') continue;
    const sub = q[key];
    if (!sub || typeof sub !== 'object') continue;

    const fieldName = sub.via || key;
    const raw = node[fieldName];

    if (sub.list) {
      const refs = Array.isArray(raw) ? raw : [];
      let resolved = refs
        .map((r) => (isRef(r) ? resolveOne(graph, r['#'], sub, depth + 1) : null))
        .filter((v) => v !== null);

      if (sub.sort) {
        const [sortKey, sortOrder] = Array.isArray(sub.sort) ? sub.sort : [sub.sort, 'asc'];
        resolved.sort((a, b) => {
          const av = a[sortKey];
          const bv = b[sortKey];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return sortOrder === 'desc' ? -cmp : cmp;
        });
      }

      if (sub.offset != null) resolved = resolved.slice(sub.offset);
      if (sub.limit != null) resolved = resolved.slice(0, sub.limit);

      out[key] = resolved;
    } else if (isRef(raw)) {
      out[key] = resolveOne(graph, raw['#'], sub, depth + 1);
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
    results = q.souls.map((soul) => resolveOne(graph, soul, q, 0)).filter((r) => r !== null);

    if (q.sort) {
      const [sortKey, sortOrder] = Array.isArray(q.sort) ? q.sort : [q.sort, 'asc'];
      results.sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortOrder === 'desc' ? -cmp : cmp;
      });
    }

    if (q.offset != null) results = results.slice(q.offset);
    if (q.limit != null) results = results.slice(0, q.limit);

    if (q.mapToRows) {
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

  if (q.mapToRows && result) {
    const row = { ...result };
    delete row.soul;
    return row;
  }

  return result;
}

module.exports = { query };
