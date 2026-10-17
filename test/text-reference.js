/**
 * The original per-char RGA (one object per character), kept as the
 * reference the run-based TextCrdt in src/text.js must match exactly.
 * Test-only - not exported by the package.
 */
const refIdKey = (c, s) => `${c}@${s}`;
/** RGA order: higher counter first, then site. @returns {boolean} a sorts after b's position (a > b) */
const refGreater = (a, b) => a.c > b.c || (a.c === b.c && a.s > b.s);

/**
 * The CRDT itself, independent of storage - exported for tests and tools.
 */
export class ReferenceCrdt {
  /** @type {Array<{c: number, s: string, ch: string, del: boolean, rc: number|null, rs: string|null}>} */
  chars = [];
  #byId = new Map();
  #pending = []; // inserts whose reference is not known yet
  #pendingDeletes = new Set();
  clock = 0;

  get size() {
    return this.chars.length;
  }

  /** @returns {string} */
  value() {
    let out = '';
    for (const el of this.chars) if (!el.del) out += el.ch;
    return out;
  }

  /** @returns {boolean} false if its reference is still missing (kept pending) */
  #integrate(el) {
    const key = refIdKey(el.c, el.s);
    if (this.#byId.has(key)) return true;
    let i = 0;
    if (el.rc !== null) {
      const ref = this.#byId.get(refIdKey(el.rc, el.rs));
      if (!ref) return false;
      i = this.chars.indexOf(ref) + 1;
    }
    while (i < this.chars.length && refGreater(this.chars[i], el)) i++;
    if (this.#pendingDeletes.delete(key)) el.del = true;
    this.chars.splice(i, 0, el);
    this.#byId.set(key, el);
    if (el.c > this.clock) this.clock = el.c;
    return true;
  }

  /** Applies one op (from any site). */
  apply(op) {
    if (op[0] === 'i') {
      const [, c, rc, rs, text, site] = op;
      [...text].forEach((ch, k) => {
        const el = { c: c + k, s: site, ch, del: false, rc: k === 0 ? rc : c + k - 1, rs: k === 0 ? rs : site };
        if (!this.#integrate(el)) this.#pending.push(el);
      });
      this.#retry();
    } else if (op[0] === 'd') {
      const [, c, s, n] = op;
      for (let k = 0; k < n; k++) {
        const el = this.#byId.get(refIdKey(c + k, s));
        if (el) el.del = true;
        else this.#pendingDeletes.add(refIdKey(c + k, s));
      }
      if (c + n - 1 > this.clock) this.clock = c + n - 1;
    }
  }

  #retry() {
    let progress = true;
    while (progress && this.#pending.length) {
      progress = false;
      this.#pending = this.#pending.filter((el) => {
        const done = this.#integrate(el);
        if (done) progress = true;
        return !done;
      });
    }
  }

  /** Visible index -> the element there (null past the end). */
  #visible(index) {
    let seen = 0;
    for (const el of this.chars) {
      if (el.del) continue;
      if (seen === index) return el;
      seen++;
    }
    return null;
  }

  /** Local insert. @returns {Array} the op */
  insert(index, text, site) {
    if (!text) return null;
    const left = index > 0 ? this.#visible(index - 1) : null;
    if (index > 0 && !left) throw new RangeError('text: insert position out of range');
    const op = ['i', this.clock + 1, left?.c ?? null, left?.s ?? null, text, site];
    this.apply(op);
    return op;
  }

  /** Local delete. @returns {Array[]} ops, one per run of consecutive ids */
  delete(index, length) {
    const ops = [];
    let seen = 0;
    for (const el of this.chars) {
      if (el.del) continue;
      if (seen >= index + length) break;
      if (seen >= index) {
        el.del = true;
        const last = ops.at(-1);
        if (last && last[2] === el.s && last[1] + last[3] === el.c) last[3]++;
        else ops.push(['d', el.c, el.s, 1]);
      }
      seen++;
    }
    return ops;
  }

  /** A position that survives remote edits: the id of the char at `index` (or the end). */
  anchor(index) {
    const el = this.#visible(index);
    return el ? refIdKey(el.c, el.s) : null;
  }

  /** @returns {number} the visible index of an anchor (a deleted char: where it was) */
  indexOf(anchor) {
    if (anchor === null) return this.value().length;
    let seen = 0;
    for (const el of this.chars) {
      if (refIdKey(el.c, el.s) === anchor) return seen;
      if (!el.del) seen++;
    }
    return seen;
  }

  /** Runs for a snapshot: [c, s, rc, rs, text | deletedLength]. */
  runs() {
    const runs = [];
    for (const el of this.chars) {
      const last = runs.at(-1);
      const chained = last && last[1] === el.s && el.rc === last.end && el.rs === el.s && el.c === last.end + 1 && (typeof last[4] === 'number') === el.del;
      if (chained) {
        if (el.del) last[4]++;
        else last[4] += el.ch;
        last.end = el.c;
      } else {
        const run = [el.c, el.s, el.rc, el.rs, el.del ? 1 : el.ch];
        run.end = el.c;
        runs.push(run);
      }
    }
    return runs.map(([c, s, rc, rs, body]) => [c, s, rc, rs, body]);
  }

  /** Loads runs (a snapshot) - in counter order, like any ops. */
  static opsOfRuns(runs) {
    const ops = [];
    for (const [c, s, rc, rs, body] of runs) {
      const deleted = typeof body === 'number';
      const text = deleted ? '\u0000'.repeat(body) : body;
      ops.push(['i', c, rc, rs, text, s]);
      if (deleted) ops.push(['d', c, s, body]);
    }
    return ops;
  }
}
