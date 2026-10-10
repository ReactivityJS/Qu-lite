/**
 * BUS - the one event mechanism of Qu Lite: dot-namespaced topics, a trie
 * for dispatch, wildcards `*` (one segment) and `**` (rest, last segment
 * only). Processes and hooks are built from four ways to fire a topic:
 *
 *   emit(topic, payload, ctx?)  handlers in order, awaited one by one;
 *                               ctx = {topic, stop(), stopped, ...} - a hook
 *                               can veto with ctx.stop() or annotate ctx
 *   notify(topic, payload)      handlers in parallel, side effects only;
 *                               handlers get {topic}
 *   run(topic, payload)         transform chain: a handler's returned object
 *                               is merged into the payload for the next one
 *   collect(topic, payload)     gathers every handler's return value
 *
 * A throwing handler never breaks the others; it is reported on
 * `bus.error` (and the console if nobody listens). `run()` is the
 * exception: a throw aborts the chain (that is how a hook vetoes a write).
 */

class Node {
  literal = new Map();
  star = null;
  handlers = [];
  globstar = [];

  child(segment) {
    if (segment === '*') return (this.star ??= new Node());
    if (!this.literal.has(segment)) this.literal.set(segment, new Node());
    return this.literal.get(segment);
  }

  collect(segments, i, out) {
    out.push(...this.globstar);
    if (i === segments.length) {
      out.push(...this.handlers);
      return;
    }
    this.literal.get(segments[i])?.collect(segments, i + 1, out);
    this.star?.collect(segments, i + 1, out);
  }
}

const split = (topic) => {
  if (!topic || typeof topic !== 'string') throw new Error(`bus: topic must be a non-empty string, got ${JSON.stringify(topic)}`);
  return topic.split('.');
};

export class Bus {
  #root = new Node();
  #seq = 0;

  /**
   * @param {string} pattern
   * @param {(payload: *, ctx: object) => *} handler
   * @param {{order?: number}} [options] - lower runs first (default 0)
   * @returns {() => void} unsubscribe
   */
  on(pattern, handler, { order = 0 } = {}) {
    const segments = split(pattern);
    let node = this.#root;
    let list = null;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === '**') {
        if (i !== segments.length - 1) throw new Error(`bus: "**" must be the last segment (got "${pattern}")`);
        list = node.globstar;
        break;
      }
      node = node.child(segments[i]);
    }
    list ??= node.handlers;
    const entry = { handler, order, seq: this.#seq++ };
    list.push(entry);
    return () => {
      const at = list.indexOf(entry);
      if (at !== -1) list.splice(at, 1);
    };
  }

  /** Like on(), removed after the first call. */
  once(pattern, handler, options) {
    const off = this.on(pattern, (payload, ctx) => (off(), handler(payload, ctx)), options);
    return off;
  }

  #match(topic) {
    const out = [];
    this.#root.collect(split(topic), 0, out);
    return out.sort((a, b) => a.order - b.order || a.seq - b.seq);
  }

  #fail(topic, error) {
    if (topic !== 'bus.error' && this.#match('bus.error').length) this.notify('bus.error', { topic, error });
    else console.error(`[bus] handler for "${topic}" threw:`, error);
  }

  /** @returns {Promise<object>} the context (`stopped`, plus whatever handlers set on it) */
  async emit(topic, payload, ctx = {}) {
    ctx.topic = topic;
    ctx.stopped = false;
    ctx.stop = () => {
      ctx.stopped = true;
    };
    for (const { handler } of this.#match(topic)) {
      if (ctx.stopped) break;
      try {
        await handler(payload, ctx);
      } catch (error) {
        this.#fail(topic, error);
      }
    }
    return ctx;
  }

  async notify(topic, payload) {
    const ctx = { topic };
    await Promise.all(
      this.#match(topic).map(async ({ handler }) => {
        try {
          await handler(payload, ctx);
        } catch (error) {
          this.#fail(topic, error);
        }
      })
    );
  }

  /** @returns {Promise<*>} the transformed payload */
  async run(topic, payload) {
    let current = payload;
    for (const { handler } of this.#match(topic)) {
      const patch = await handler(current, { topic });
      if (patch !== undefined) current = { ...current, ...patch };
    }
    return current;
  }

  /** @returns {Promise<Array>} every handler's (non-undefined) result, flattened */
  async collect(topic, payload) {
    const out = [];
    for (const { handler } of this.#match(topic)) {
      try {
        const result = await handler(payload, { topic });
        if (result !== undefined) out.push(...[].concat(result));
      } catch (error) {
        this.#fail(topic, error);
      }
    }
    return out;
  }

  /** @param {string} topic @returns {number} */
  listenerCount(topic) {
    return this.#match(topic).length;
  }
}
