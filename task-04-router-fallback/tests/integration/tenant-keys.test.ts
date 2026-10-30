/**
 * Who gets a window.
 *
 * The default is permissive on purpose (any bearer string becomes its own tenant), which is convenient
 * for a demo and wrong for production: rotating the key mints a fresh 50 000-token window. Setting
 * `ROUTER_TENANT_KEYS` turns that into an allow-list, and the permissive default announces itself in
 * the log instead of being silent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../helpers/mockProvider.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { postCompletion, simpleBody, startHarness, TEST_TENANT_KEY, type Harness } from '../helpers/gateway.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function scenario(env: Record<string, string>): Promise<{ provider: MockProvider; harness: Harness; test: TestDb }> {
  const provider = await startMockProvider({ behaviour: 'ok' });
  cleanups.push(() => void provider.close());
  const test = createTestDb();
  cleanups.push(test.cleanup);
  const harness = await startHarness({
    primaryUrl: provider.url,
    secondaryUrl: provider.url,
    db: test.db,
    captureLogs: true,
    env
  });
  cleanups.push(() => void harness.close());
  return { provider, harness, test };
}

function tenantRows(test: TestDb): number {
  return test.db.prepare('SELECT COUNT(*) AS n FROM tenants').get<{ n: number }>()?.n ?? -1;
}

describe('tenant keys', () => {
  it('rejects an unlisted key and creates no tenant when an allow-list is configured', async () => {
    const { harness, test, provider } = await scenario({ ROUTER_TENANT_KEYS: `${TEST_TENANT_KEY},other-key` });

    const rejected = await postCompletion(harness.url, simpleBody(), { key: 'rotated-key-9000' });
    const payload = (await rejected.json()) as { error: { code: string } };

    expect(rejected.status).toBe(401);
    expect(payload.error.code).toBe('gateway_unauthorized');
    expect(tenantRows(test)).toBe(0); // no window was minted for the unknown key
    expect(provider.callCount()).toBe(0);
    expect(harness.metrics.snapshot().counters.tenants_rejected).toBe(1);
  });

  it('accepts a listed key', async () => {
    const { harness, test } = await scenario({ ROUTER_TENANT_KEYS: `${TEST_TENANT_KEY},other-key` });

    const accepted = await postCompletion(harness.url, simpleBody(), { key: TEST_TENANT_KEY });
    await accepted.text();

    expect(accepted.status).toBe(200);
    expect(tenantRows(test)).toBe(1);
  });

  it('still auto-provisions when no allow-list is set, and says so at boot', async () => {
    const { harness, test } = await scenario({});

    expect((await postCompletion(harness.url, simpleBody(), { key: 'any-key-at-all' })).status).toBe(200);
    expect((await postCompletion(harness.url, simpleBody(), { key: 'a-different-key' })).status).toBe(200);

    expect(tenantRows(test)).toBe(2);
    const warning = harness.logLines().find((line) => line.event === 'tenant_autoprovision_enabled');
    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warn');
  });

  it('reports which tenant mode is active on /healthz', async () => {
    const strict = await scenario({ ROUTER_TENANT_KEYS: TEST_TENANT_KEY });
    const open = await scenario({});

    const strictHealth = (await (await fetch(`${strict.harness.url}/healthz`)).json()) as Record<string, unknown>;
    const openHealth = (await (await fetch(`${open.harness.url}/healthz`)).json()) as Record<string, unknown>;

    expect(strictHealth.tenantMode).toBe('allow-list');
    expect(openHealth.tenantMode).toBe('auto-provision');
  });

  it('resolves the same tenant for the same key regardless of how it is presented', async () => {
    const { harness, test } = await scenario({ ROUTER_TENANT_KEYS: TEST_TENANT_KEY });

    await (await postCompletion(harness.url, simpleBody(), { key: TEST_TENANT_KEY })).text();
    await (
      await fetch(`${harness.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': TEST_TENANT_KEY },
        body: JSON.stringify(simpleBody())
      })
    ).text();

    expect(tenantRows(test)).toBe(1);
    expect(test.db.prepare('SELECT COUNT(*) AS n FROM token_events').get<{ n: number }>()?.n).toBe(2);
  });
});
