import { describe, expect, it } from 'vitest';
import { loadConfig, parseFailoverTriggers } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies the brief\'s defaults: 50 000 tokens / 60 s, 3000 ms primary timeout', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      port: 8791,
      dbPath: './data/router.db',
      sqliteDriver: 'better',
      windowMs: 60_000,
      limitTokens: 50_000,
      maxAttempts: 2,
      logLevel: 'info'
    });
    expect(config.providers.primary).toEqual({
      name: 'primary',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen3.8-turbo',
      timeoutMs: 3_000
    });
    expect(config.providers.secondary.timeoutMs).toBe(10_000);
    expect(config.failoverOn).toEqual([429, 500, 502, 503, 504, 'timeout', 'network']);
    expect(config.estimation).toEqual({ charsPerToken: 4, messageOverheadTokens: 4, toolOverheadTokens: 100 });
  });

  it('reads providers, window geometry and the SQLite path from the environment', () => {
    const config = loadConfig({
      ROUTER_PORT: '9000',
      ROUTER_DB_PATH: '/tmp/router-test.db',
      ROUTER_WINDOW_MS: '10000',
      ROUTER_LIMIT_TOKENS: '1234',
      ROUTER_PRIMARY_BASE_URL: 'http://127.0.0.1:11434/v1',
      ROUTER_PRIMARY_MODEL: 'qwen3:8b',
      ROUTER_PRIMARY_TIMEOUT_MS: '1500',
      ROUTER_SECONDARY_NAME: 'backup',
      ROUTER_SECONDARY_BASE_URL: 'http://127.0.0.1:9999/v1',
      ROUTER_SECONDARY_MODEL: 'backup-model',
      ROUTER_MAX_ATTEMPTS: '1',
      ROUTER_SQLITE_DRIVER: 'node'
    });

    expect(config.port).toBe(9000);
    expect(config.dbPath).toBe('/tmp/router-test.db');
    expect(config.windowMs).toBe(10_000);
    expect(config.limitTokens).toBe(1234);
    expect(config.maxAttempts).toBe(1);
    expect(config.sqliteDriver).toBe('node');
    expect(config.providers.primary).toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', timeoutMs: 1500 });
    expect(config.providers.secondary).toMatchObject({ name: 'backup', model: 'backup-model' });
  });

  it('parses the failover trigger list, mixing status codes and symbolic causes', () => {
    expect(parseFailoverTriggers('429,503,timeout')).toEqual([429, 503, 'timeout']);
    expect(loadConfig({ ROUTER_FAILOVER_ON: '429,timeout' }).failoverOn).toEqual([429, 'timeout']);
  });

  it('rejects an unknown SQLite driver', () => {
    expect(() => loadConfig({ ROUTER_SQLITE_DRIVER: 'postgres' })).toThrow(/sqliteDriver/);
  });

  it('rejects a malformed provider URL', () => {
    expect(() => loadConfig({ ROUTER_PRIMARY_BASE_URL: 'not-a-url' })).toThrow(/providers\.primary\.baseUrl/);
  });

  it('rejects a non-positive token limit', () => {
    expect(() => loadConfig({ ROUTER_LIMIT_TOKENS: '0' })).toThrow(/limitTokens/);
  });

  it('rejects an out-of-range HTTP status in the failover list', () => {
    expect(() => loadConfig({ ROUTER_FAILOVER_ON: '99' })).toThrow(/failoverOn/);
  });
});
