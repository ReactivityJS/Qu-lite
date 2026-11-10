/**
 * LIVE QUERIES (optional plugin) - a query that answers again whenever its
 * result may have changed. A thin wrapper around `qu.query()` and the record
 * events, for reactive UIs (React, Vue, Svelte, plain DOM):
 *
 *   qu.use(live())                      // or createClient({ extra: ['live'] })
 *   const stop = qu.live({ space, path: 'chat', limit: 50, reverse: true }, (rows) => render(rows));
 *   const stop2 = qu.live({ space, path: 'events', where: { start: { gte: monday } }, orderBy: 'start' }, show);
 *   stop();                             // unsubscribe
 *
 * `render(rows)` runs once at the start and again after a record of that
 * space and path arrives, changes, is deleted or dropped - coalesced (a burst
 * of 100 records is one re-run) and only if the result really differs (ids
 * and versions). Queries with `where`/`orderBy` use the in-memory field index,
 * so a re-run costs about a millisecond. Errors go to `onError` (default:
 * bus.error); the subscription stays.
 */

/** @param {{delayMs?: number}} [options] - coalescing window (default 16 ms, one frame) */
export function live({ delayMs = 16 } = {}) {
  const plugin = (qu) => {
    const subs = new Set();

    /**
     * @param {object} query - as for `qu.query()`
     * @param {(rows: object[]) => void} render
     * @param {{onError?: (error: Error) => void}} [options]
     * @returns {() => void} stop
     */
    function subscribe(query, render, { onError = (error) => qu.bus.error(error, 'live') } = {}) {
      const sid = typeof query.space === 'string' ? query.space : query.space?.id;
      if (!sid || typeof query.path !== 'string') throw new Error('live: needs {space, path}');
      let timer = null;
      let running = false;
      let again = false;
      let last = null;
      let stopped = false;

      async function run() {
        if (stopped) return;
        if (running) {
          again = true; // one more run after this one, not one per event
          return;
        }
        running = true;
        try {
          const rows = await qu.query(query);
          const signature = rows.map((r) => `${r.id}@${r.hlc}`).join(',');
          if (!stopped && signature !== last) {
            last = signature;
            render(rows);
          }
        } catch (error) {
          onError(error);
        } finally {
          running = false;
          if (again && !stopped) {
            again = false;
            schedule();
          }
        }
      }
      function schedule() {
        if (timer || stopped) return;
        timer = setTimeout(() => {
          timer = null;
          run();
        }, delayMs);
      }
      // new or changed records of this path; leaving versions (superseded, deleted, dropped)
      const offs = [
        qu.bus.on(`qu.record.${sid}`, (record) => (record?.path === query.path ? schedule() : undefined)),
        qu.bus.on('qu.record.superseded', ({ space } = {}) => (space === sid ? schedule() : undefined)),
        qu.bus.on('qu.record.deleted', ({ space } = {}) => (space === sid ? schedule() : undefined)),
      ];
      const sub = () => {
        stopped = true;
        clearTimeout(timer);
        for (const off of offs) off?.();
        subs.delete(sub);
      };
      subs.add(sub);
      run();
      return sub;
    }

    qu.onClose?.(() => {
      for (const stop of [...subs]) stop();
    });
    qu.live = subscribe;
    return { live: subscribe, size: () => subs.size };
  };
  plugin.pluginName = 'live';
  return plugin;
}
