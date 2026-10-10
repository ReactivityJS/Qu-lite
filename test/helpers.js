/** Shared test helpers (not a test file). */
import { createQu, records, sync, user, inbox, members, mirror, connectInProcess } from '../src/index.js';

export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, ms = 5000, label = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`until: ${label} not met in time`);
    await settle(10);
  }
}

/** A full client: records, sync, user node, inbox, members. */
export async function fullClient(options = {}) {
  const qu = await createQu(options);
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0 }));
  qu.use(user());
  qu.use(members());
  qu.use(inbox(options.inbox));
  await qu.inbox.ready;
  return qu;
}

export async function mirrorNode() {
  const qu = await createQu();
  qu.use(sync({ role: 'mirror', timeoutMs: 5000, retryMs: 0 }));
  qu.use(mirror());
  await qu.mirror.ready;
  return qu;
}

export const values = async (qu, space, path) => (await qu.query({ space, path })).map((r) => r.value);
export { connectInProcess };
