/**
 * TEXT - collaborative plain text on top of records: an RGA sequence CRDT
 * (Lamport-ordered character ids), so concurrent edits from any number of
 * members - online or offline - converge to the same text without a server.
 *
 *   const doc = await qu.text(space, 'notes/main')
 *   doc.insert(5, 'Hallo'); doc.delete(0, 3); doc.value()
 *   doc.on(({ text, remote }) => ...)
 *
 * Records (all private, padded, synced like any other record):
 *
 *   <path>           log entries: one BATCH of ops per `batchMs` of typing
 *                    {v: 1, site, ops: [['i', c, rc, rs, text], ['d', c, s, n]]}
 *                      'i': insert `text` after char (rc, rs) (null = start);
 *                           its chars get ids (c, site), (c+1, site), ...
 *                      'd': delete the chars (c..c+n-1, s)
 *   <path>/_snap     keyed by the AUTHOR's alias (others can't write that
 *                    key): the author's full state as runs, with tombstones
 *                    but without deleted text (applying ops twice is harmless:
 *                    ids are deduplicated, deletes idempotent)
 *
 * Positions (insert/delete indexes, anchors) count Unicode code points.
 *
 * A char id is (counter, site); site = the author's alias prefix + a random
 * per-session suffix (one identity on two devices must not collide), and
 * every op of a batch must carry its author's site - forgeries are ignored.
 * Insertion follows RGA: after its reference char, skipping every char with
 * a greater id. Applying ops in counter order (refs always have smaller
 * counters) gives the same result on every peer. In memory, chars live in
 * runs (see TextCrdt), so a long note costs as much as its edit history,
 * not one object per char.
 *
 * Compaction: snapshots are unions of ops (each char keeps its reference),
 * so any set of them merges. Each member snapshots its OWN state and then
 * drops its OWN covered batches (drop lists, gc.js) - nothing can be lost,
 * whoever compacts when. Older own snapshots are superseded and compacted
 * like any keyed entry (compaction.js auto).
 */
const SNAP = '_snap';
const idKey = (c, s) => `${c}@${s}`;
/** RGA order: higher counter first, then site. @returns {boolean} a sorts after b's position (a > b) */
const greater = (a, b) => a.c > b.c || (a.c === b.c && a.s > b.s);
/** Code-point length and slicing (positions count code points, so an emoji is one char). */
const cpLength = (str) => {
  let n = 0;
  for (let i = 0; i < str.length; i++) if ((str.charCodeAt(i) & 0xfc00) !== 0xdc00) n++;
  return n;
};
const cpSlice = (str, from, to) => (str.length === cpLength(str) ? str.slice(from, to) : [...str].slice(from, to).join(''));

/**
 * The CRDT itself, independent of storage - exported for tests and tools.
 *
 * Chars are kept as RUNS (like Yjs items): one node per stretch of chars of
 * one site with consecutive counters, each char referencing the one before
 * - which is what typing produces. A node is split only where an edit lands
 * inside it, and extended in place when its author keeps typing at its end,
 * so memory and every scan grow with the number of edits, not of chars.
 * The order is exactly the per-char RGA order: a node's later chars have
 * greater ids than its first, so "skip every greater id" skips whole nodes.
 * Deleted nodes keep their ids (tombstones) but drop their text.
 *
 *   node: {c, s, len, text (null when deleted), rc, rs}   (rc, rs) = reference of its first char
 */
export class TextCrdt {
  /** @type {Array<{c: number, s: string, len: number, text: string|null, rc: number|null, rs: string|null}>} document order */
  nodes = [];
  /** @type {Map<string, Array<object>>} site -> its nodes, sorted by counter */
  #bySite = new Map();
  #pending = []; // runs whose reference is not known yet
  #pendingDeletes = []; // [c, s, n] of chars not known yet
  #cache = '';
  #dirty = false;
  clock = 0;
  /** chars including tombstones */
  size = 0;

  /** @returns {string} */
  value() {
    if (this.#dirty) {
      let out = '';
      for (const node of this.nodes) if (node.text !== null) out += node.text;
      this.#cache = out;
      this.#dirty = false;
    }
    return this.#cache;
  }

  /** The node holding char (c, s), or undefined. */
  #find(c, s) {
    const list = this.#bySite.get(s);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const node = list[mid];
      if (c < node.c) hi = mid - 1;
      else if (c >= node.c + node.len) lo = mid + 1;
      else return node;
    }
    return undefined;
  }

  /** First node of site `s` with a counter above `c` (to measure gaps), or undefined. */
  #next(c, s) {
    const list = this.#bySite.get(s) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].c <= c) lo = mid + 1;
      else hi = mid;
    }
    return list[lo];
  }

  #addToSite(node) {
    if (!this.#bySite.has(node.s)) this.#bySite.set(node.s, []);
    const list = this.#bySite.get(node.s);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].c < node.c) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, node);
  }

  /** Splits `node` before its char at offset k (0 < k < len). @returns {object} the right part */
  #split(node, k) {
    const right = { c: node.c + k, s: node.s, len: node.len - k, text: node.text === null ? null : cpSlice(node.text, k), rc: node.c + k - 1, rs: node.s };
    node.len = k;
    if (node.text !== null) node.text = cpSlice(node.text, 0, k);
    this.nodes.splice(this.nodes.indexOf(node) + 1, 0, right);
    this.#addToSite(right);
    return right;
  }

  /** @returns {boolean} false if its reference is still missing (kept pending) */
  #integrate(run) {
    let { c, s, len, text, rc, rs } = run;
    // a run whose prefix is known already (a snapshot overlapping batches): keep only the new tail
    for (let known = this.#find(c, s); known && len > 0; known = this.#find(c, s)) {
      const skip = Math.min(known.c + known.len - c, len);
      text = cpSlice(text, skip);
      c += skip;
      len -= skip;
      rc = c - 1;
      rs = s;
    }
    if (len === 0) return true;
    let i = 0;
    let ref = null;
    if (rc !== null) {
      ref = this.#find(rc, rs);
      if (!ref) return false;
      if (rc < ref.c + ref.len - 1) this.#split(ref, rc - ref.c + 1);
      i = this.nodes.indexOf(ref) + 1;
    }
    const el = { c, s };
    const start = i;
    while (i < this.nodes.length && greater(this.nodes[i], el)) i++;
    if (ref && i === start && ref.s === s && rs === s && ref.c + ref.len === c && ref.text !== null) {
      ref.text += text; // the author kept typing at the end of its own run
      ref.len += len;
    } else {
      const node = { c, s, len, text, rc, rs };
      this.nodes.splice(i, 0, node);
      this.#addToSite(node);
    }
    this.size += len;
    if (c + len - 1 > this.clock) this.clock = c + len - 1;
    this.#dirty = true;
    if (this.#pendingDeletes.length) {
      const waiting = this.#pendingDeletes;
      this.#pendingDeletes = [];
      for (const [dc, ds, dn] of waiting) this.#delete(dc, ds, dn);
    }
    return true;
  }

  /** Marks chars (c..c+n-1, s) deleted; unknown ones are remembered until they arrive. */
  #delete(c, s, n) {
    while (n > 0) {
      let node = this.#find(c, s);
      if (!node) {
        const next = this.#next(c, s);
        const gap = next ? Math.min(n, next.c - c) : n;
        this.#pendingDeletes.push([c, s, gap]);
        c += gap;
        n -= gap;
        continue;
      }
      if (c > node.c) node = this.#split(node, c - node.c);
      if (n < node.len) this.#split(node, n);
      if (node.text !== null) {
        node.text = null;
        this.#dirty = true;
      }
      c += node.len;
      n -= node.len;
    }
  }

  /** Applies one op (from any site). */
  apply(op) {
    if (op[0] === 'i') {
      const [, c, rc, rs, text, site] = op;
      const run = { c, s: site, len: cpLength(text), text, rc, rs };
      if (run.len && !this.#integrate(run)) this.#pending.push(run);
      else this.#retry();
    } else if (op[0] === 'd') {
      const [, c, s, n] = op;
      this.#delete(c, s, n);
      if (c + n - 1 > this.clock) this.clock = c + n - 1;
    }
  }

  #retry() {
    let progress = true;
    while (progress && this.#pending.length) {
      progress = false;
      this.#pending = this.#pending.filter((run) => {
        const done = this.#integrate(run);
        if (done) progress = true;
        return !done;
      });
    }
  }

  /** Visible index -> {node, off} (null past the end). */
  #visible(index) {
    for (const node of this.nodes) {
      if (node.text === null) continue;
      if (index < node.len) return { node, off: index };
      index -= node.len;
    }
    return null;
  }

  /** Local insert. @returns {Array} the op */
  insert(index, text, site) {
    if (!text) return null;
    const left = index > 0 ? this.#visible(index - 1) : null;
    if (index > 0 && !left) throw new RangeError('text: insert position out of range');
    const op = ['i', this.clock + 1, left ? left.node.c + left.off : null, left?.node.s ?? null, text, site];
    this.apply(op);
    return op;
  }

  /** Local delete. @returns {Array[]} ops, one per run of consecutive ids */
  delete(index, length) {
    const ops = [];
    let seen = 0;
    for (const node of this.nodes) {
      if (seen >= index + length) break;
      if (node.text === null) continue;
      const from = Math.max(0, index - seen);
      const to = Math.min(node.len, index + length - seen);
      seen += node.len;
      if (from >= to) continue;
      const last = ops.at(-1);
      if (last && last[2] === node.s && last[1] + last[3] === node.c + from) last[3] += to - from;
      else ops.push(['d', node.c + from, node.s, to - from]);
    }
    for (const [, c, s, n] of ops) this.#delete(c, s, n);
    return ops;
  }

  /** A position that survives remote edits: the id of the char at `index` (or the end). */
  anchor(index) {
    const at = this.#visible(index);
    return at ? idKey(at.node.c + at.off, at.node.s) : null;
  }

  /** @returns {number} the visible index of an anchor (a deleted char: where it was) */
  indexOf(anchor) {
    if (anchor === null) return cpLength(this.value());
    const split = anchor.indexOf('@');
    const c = Number(anchor.slice(0, split));
    const target = this.#find(c, anchor.slice(split + 1));
    let seen = 0;
    for (const node of this.nodes) {
      if (node === target) return seen + (node.text === null ? 0 : c - node.c);
      if (node.text !== null) seen += node.len;
    }
    return seen;
  }

  /** Runs for a snapshot: [c, s, rc, rs, text | deletedLength]. */
  runs() {
    const runs = [];
    let end = null;
    for (const node of this.nodes) {
      const last = runs.at(-1);
      const deleted = node.text === null;
      const chained = last && last[1] === node.s && node.rc === end && node.rs === node.s && node.c === end + 1 && (typeof last[4] === 'number') === deleted;
      if (chained) last[4] = deleted ? last[4] + node.len : last[4] + node.text;
      else runs.push([node.c, node.s, node.rc, node.rs, deleted ? node.len : node.text]);
      end = node.c + node.len - 1;
    }
    return runs;
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

const opsOf = (value) => (value?.v === 1 && Array.isArray(value.ops) ? value.ops : []);
const siteOk = (site, author) => typeof site === 'string' && site.startsWith(author.slice(0, 12) + '.');

/**
 * @param {{batchMs?: number, snapshotEvery?: number}} [options]
 *   `batchMs`: local edits within this window become one record.
 *   `snapshotEvery`: own batches after which `compact()` runs by itself (0: never).
 */
export function text({ batchMs = 300, snapshotEvery = 200 } = {}) {
  return (qu) => {
    if (!qu.records) throw new Error('text(): install records() first');
    if (qu.text) return qu.text;
    const { bus } = qu;
    const records = qu.records;
    /** @type {Map<string, Promise<object>>} */
    const docs = new Map();

    // nobody may write another member's snapshot key (it would supersede theirs)
    bus.on('qu.accept', (record, ctx) => {
      if (record.path?.endsWith(`/${SNAP}`) && record.key !== record.author) {
        ctx.reason = 'not your snapshot';
        ctx.stop();
      }
    });

    async function open(spaceRef, path) {
      const space = records.spaceOf(spaceRef);
      if (path.split('/').includes(SNAP)) throw new Error(`text: ${SNAP} is reserved`);
      const me = await records.authorOf(space);
      const site = `${me.slice(0, 12)}.${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
      const crdt = new TextCrdt();
      const applied = new Set(); // batch record ids folded in
      const listeners = new Set();
      let queue = [];
      let timer = null;
      let ownSinceSnapshot = [];
      let closed = false;

      const emit = (remote) => {
        const value = crdt.value();
        for (const fn of listeners) fn({ text: value, remote });
      };

      /** Ops of a batch or snapshot record - only those its author may have written. */
      function applyRecord(record, ops) {
        const valid = ops.filter((op) => (op[0] === 'i' ? siteOk(op[5], record.author) : op[0] === 'd'));
        valid.sort((a, b) => a[1] - b[1]);
        for (const op of valid) crdt.apply(op);
      }
      const batchOps = (record) => opsOf(record.value).map((op) => (op[0] === 'i' ? [...op.slice(0, 5), record.value.site] : op));

      // initial state: every member's snapshot, then the batches they don't cover - all in counter order
      const snapshots = await qu.query({ space, path: `${path}/${SNAP}` });
      const batches = await qu.query({ space, path });
      const all = [];
      for (const snap of snapshots) {
        if (snap.key !== snap.author || !Array.isArray(snap.value?.runs)) continue;
        // a snapshot may hold anyone's chars (it is its author's full state) - but deletes and
        // inserts only as they came in, so its inserts are taken as they are
        all.push(...TextCrdt.opsOfRuns(snap.value.runs));
      }
      for (const batch of batches) {
        if (!siteOk(batch.value?.site, batch.author)) continue;
        applied.add(batch.id);
        all.push(...batchOps(batch));
        if (batch.author === me) ownSinceSnapshot.push(batch);
      }
      all.sort((a, b) => a[1] - b[1] || (a[0] === 'i' ? -1 : 1));
      for (const op of all) crdt.apply(op);

      const offRecord = bus.on(`qu.record.${space.id}`, (record) => {
        if (record.local || closed) return;
        if (record.path === path) {
          if (applied.has(record.id) || !siteOk(record.value?.site, record.author)) return;
          applied.add(record.id);
          applyRecord(record, batchOps(record));
          emit(true);
        } else if (record.path === `${path}/${SNAP}` && record.key === record.author && Array.isArray(record.value?.runs)) {
          const before = crdt.value();
          for (const op of TextCrdt.opsOfRuns(record.value.runs)) crdt.apply(op);
          if (crdt.value() !== before) emit(true);
        }
      });
      const unwatch = typeof qu.watch === 'function' ? await qu.watch({ space, path }).catch(() => null) : null;

      async function flush() {
        clearTimeout(timer);
        timer = null;
        if (!queue.length) return;
        const ops = queue.map((op) => (op[0] === 'i' ? op.slice(0, 5) : op));
        queue = [];
        const record = await records.write(space, path, { v: 1, site, ops });
        applied.add(record.id);
        ownSinceSnapshot.push(record);
        if (snapshotEvery > 0 && ownSinceSnapshot.length >= snapshotEvery) await compact();
      }

      const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => flush().catch((error) => bus.error?.(error)), batchMs);
        timer.unref?.();
      };

      /**
       * Writes my snapshot (everything I know) and drops my own batches it
       * covers. Others' batches stay until they compact (or an admin does).
       */
      async function compact() {
        await flush();
        const mine = ownSinceSnapshot;
        ownSinceSnapshot = [];
        await records.write(space, `${path}/${SNAP}`, { v: 1, runs: crdt.runs() }, { key: me });
        // my snapshot holds every op of my batches: they can go, everywhere
        if (mine.length) await records.dropList(space, mine.map((r) => ({ id: r.id, path: r.path, ts: r.ts, author: r.author })));
        return { dropped: mine.length, chars: crdt.size };
      }

      const doc = {
        path,
        site,
        value: () => crdt.value(),
        insert(index, str) {
          const op = crdt.insert(index, str, site);
          if (op) {
            queue.push(op);
            schedule();
            emit(false);
          }
        },
        delete(index, length) {
          const ops = crdt.delete(index, length);
          if (ops.length) {
            queue.push(...ops);
            schedule();
            emit(false);
          }
        },
        /** Replaces the whole text by `next`, as the smallest single edit (common prefix/suffix kept). */
        set(text) {
          const prev = [...crdt.value()]; // positions are code points
          const next = [...text];
          let start = 0;
          while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
          let end = 0;
          while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
          if (prev.length - start - end > 0) doc.delete(start, prev.length - start - end);
          if (next.length - start - end > 0) doc.insert(start, next.slice(start, next.length - end).join(''));
        },
        anchor: (index) => crdt.anchor(index),
        indexOf: (anchor) => crdt.indexOf(anchor),
        /** @param {(change: {text: string, remote: boolean}) => void} fn @returns {() => void} */
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        flush,
        compact,
        stats: () => ({ chars: crdt.size, batches: applied.size, pendingOps: queue.length }),
        async close() {
          await flush();
          closed = true;
          offRecord();
          unwatch?.();
          docs.delete(`${space.id}/${path}`);
        },
      };
      return doc;
    }

    /**
     * Opens (once per space and path) a collaborative text.
     * @param {import('./space.js').Space|string} space
     * @param {string} path
     */
    function textDoc(space, path) {
      const key = `${typeof space === 'string' ? space : space.id}/${path}`;
      if (!docs.has(key)) docs.set(key, open(space, path).catch((error) => (docs.delete(key), Promise.reject(error))));
      return docs.get(key);
    }

    qu.text = textDoc;
    return textDoc;
  };
}
