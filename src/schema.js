/**
 * SCHEMA (optional plugin) - what may be stored under a path, checked when
 * writing on this device AND when records of other devices arrive. A record
 * that fails is refused (`qu.record.rejected {reason: 'invalid: …'}`), never
 * indexed, never shown - a bug or a hostile client elsewhere cannot feed the
 * app data it does not expect.
 *
 *   qu.use(schema({
 *     chat: 'string',                                           // the value itself
 *     events: { title: 'string', start: 'number', tags: 'string[]?', 'place.city': 'string?' },
 *     'files/': { name: 'string', size: 'number' },             // a trailing / covers every sub-path
 *     scores: (value) => value.points >= 0 || 'points must not be negative',
 *   }))
 *   qu.schema('polls', { question: 'string', options: 'string[]' });   // add rules later
 *
 * A rule is a type, a SHAPE (field -> type; dots reach into nested
 * objects) or a function `(value, record) => true | false | 'reason'`.
 * Types: string, number, boolean, object, array, any; `[]` = array of that
 * type, `?` = may be missing or null. Extra fields are allowed. Paths without
 * a rule are not checked; internal paths (`_…`) and deletions never.
 */

import { isGcPath } from './gc.js';

const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array),
  array: (v) => Array.isArray(v),
  any: () => true,
};

/** @returns {(value: any) => true|string} a check for one type expression, e.g. 'string[]?' */
function typeCheck(expr, where) {
  const optional = expr.endsWith('?');
  const base = optional ? expr.slice(0, -1) : expr;
  const list = base.endsWith('[]');
  const name = list ? base.slice(0, -2) : base;
  const test = TYPES[name];
  if (!test) throw new Error(`schema: unknown type "${expr}" at ${where}`);
  return (v) => {
    if (v === undefined || v === null) return optional || `${where} is missing`;
    if (list) return (Array.isArray(v) && v.every(test)) || `${where} must be ${name}[]`;
    return test(v) || `${where} must be ${name}`;
  };
}

/** Compiles a rule into `(value, record) => true | string`. */
export function compileRule(rule, path = 'value') {
  if (typeof rule === 'function') {
    return (value, record) => {
      const out = rule(value, record);
      return out === true || out === undefined ? true : typeof out === 'string' ? out : `${path}: rejected by its check`;
    };
  }
  if (typeof rule === 'string') return typeCheck(rule, path);
  if (rule && typeof rule === 'object') {
    const fields = Object.entries(rule).map(([field, expr]) => [field.split('.'), typeCheck(expr, field)]);
    return (value) => {
      if (!TYPES.object(value)) return `${path} must be an object`;
      for (const [parts, check] of fields) {
        let v = value;
        for (const p of parts) v = v === null || typeof v !== 'object' ? undefined : v[p];
        const ok = check(v);
        if (ok !== true) return ok;
      }
      return true;
    };
  }
  throw new Error(`schema: a rule for ${path} must be a type, a shape or a function`);
}

/** @param {Record<string, string|object|Function>} [rules] - path (or `prefix/`) -> rule */
export function schema(rules = {}) {
  const plugin = (qu) => {
    const exact = new Map();
    const prefixes = [];
    function add(path, rule) {
      const check = compileRule(rule, path);
      if (path.endsWith('/')) {
        prefixes.push([path, check]);
        prefixes.sort((a, b) => b[0].length - a[0].length); // the most specific prefix wins
      } else exact.set(path, check);
    }
    for (const [path, rule] of Object.entries(rules)) add(path, rule);
    const ruleFor = (path) => exact.get(path) ?? prefixes.find(([p]) => path.startsWith(p))?.[1] ?? null;
    const verdict = (path, value, record) => {
      if (typeof path !== 'string' || path.startsWith('_') || isGcPath(path)) return true; // internal, drop lists
      const check = ruleFor(path);
      return check ? check(value, record) : true;
    };

    // this device: the write fails with a clear error
    qu.bus.on('qu.write.before', (draft) => {
      if (draft.deleted) return;
      const ok = verdict(draft.path, draft.value, draft);
      if (ok !== true) throw Object.assign(new Error(`schema: ${ok}`), { code: 'QU_INVALID', path: draft.path });
    });
    // other devices: refused before it is indexed
    qu.bus.on('qu.accept', (record, ctx) => {
      if (record.deleted) return;
      const ok = verdict(record.path, record.value, record);
      if (ok !== true) {
        ctx.reason = `invalid: ${ok}`;
        ctx.stop();
      }
    });

    qu.schema = add;
    return { add, check: verdict };
  };
  plugin.pluginName = 'schema';
  return plugin;
}
