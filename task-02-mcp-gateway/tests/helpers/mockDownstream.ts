/**
 * Test helper: the mock downstream, re-exported under `tests/helpers/`.
 *
 * The implementation lives in `mock/downstream.ts` (it is also a runnable server,
 * `npm run mock`) so tests and the demo exercise exactly the same server. What
 * matters here is the `calls` recorder: every authorization test asserts on
 * **call counts**, not only on response shapes.
 */
export { startMockDownstream } from '../../mock/downstream.js';
export type { MockDownstream, MockDownstreamOptions, RecordedCall } from '../../mock/downstream.js';
