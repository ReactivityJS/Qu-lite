/**
 * TOPOLOGY - which connections a peer keeps open. The sync protocol is
 * symmetric (a mirror is just a peer), so mesh vs. star is only this choice:
 *
 *   star   mirrors only
 *   mesh   mirrors + every known peer
 *   auto   mesh while the group is small (known peers + self <= maxMesh),
 *          otherwise mirrors + `fanout` peers (already-open links preferred,
 *          so switching modes doesn't churn connections)
 *
 * `connect(endpoint)` must return something with `close()` (e.g. connectWs);
 * duplicates are harmless - records are deduplicated by id.
 */
export function topology({ mode = 'auto', mirrors = [], peers = [], maxMesh = 8, fanout = 3, connect } = {}) {
  if (typeof connect !== 'function') throw new Error('topology: `connect(endpoint)` is required');
  return (qu) => {
    const links = new Map();
    const state = { mode, mirrors: [...mirrors], peers: [...peers] };

    const effective = () => (state.mode === 'auto' ? (state.peers.length + 1 <= maxMesh ? 'mesh' : 'star+') : state.mode);

    function targets() {
      const m = effective();
      if (m === 'star') return [...state.mirrors];
      if (m === 'mesh') return [...state.mirrors, ...state.peers];
      const open = state.peers.filter((p) => links.has(p));
      const rest = state.peers.filter((p) => !links.has(p));
      return [...state.mirrors, ...[...open, ...rest].slice(0, fanout)];
    }

    function apply() {
      const want = new Set(targets());
      for (const [endpoint, link] of links) {
        if (!want.has(endpoint)) {
          link.close();
          links.delete(endpoint);
        }
      }
      for (const endpoint of want) if (!links.has(endpoint)) links.set(endpoint, connect(endpoint));
      qu.bus.notify('net.topology', { mode: state.mode, effective: effective(), endpoints: [...links.keys()] });
    }

    const api = {
      /** @param {string[]} list - currently known peer endpoints (e.g. from presence). */
      setPeers(list) {
        state.peers = [...new Set(list)];
        apply();
      },
      /** @param {'star'|'mesh'|'auto'} next */
      setMode(next) {
        state.mode = next;
        apply();
      },
      get effective() {
        return effective();
      },
      endpoints: () => [...links.keys()],
      close() {
        for (const link of links.values()) link.close();
        links.clear();
      },
    };
    apply();
    qu.topology = api;
    return api;
  };
}
