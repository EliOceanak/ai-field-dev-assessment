import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      port: 8787,
      downstreamUrl: 'http://127.0.0.1:8788/mcp',
      upstreamTimeoutMs: 10_000,
      filterToolList: false,
      forwardClientAuth: false,
      privilegedPrefixes: ['admin_'],
      logLevel: 'info'
    });
    expect(config.devTokens).toEqual({ admin: 'admin-dev-token', viewer: 'viewer-dev-token' });
  });

  it('parses the dev-token list from the environment', () => {
    const config = loadConfig({ GATEWAY_DEV_TOKENS: 'admin:a-token, viewer:v-token,,broken' });
    expect(config.devTokens).toEqual({ admin: 'a-token', viewer: 'v-token' });
  });

  it('coerces numeric and boolean values from strings', () => {
    const config = loadConfig({
      GATEWAY_PORT: '9999',
      GATEWAY_UPSTREAM_TIMEOUT_MS: '250',
      GATEWAY_FILTER_TOOL_LIST: 'true'
    });

    expect(config.port).toBe(9999);
    expect(config.upstreamTimeoutMs).toBe(250);
    expect(config.filterToolList).toBe(true);
  });

  it('treats the string "false" as false (z.coerce.boolean() would not)', () => {
    expect(loadConfig({ GATEWAY_FILTER_TOOL_LIST: 'false' }).filterToolList).toBe(false);
    expect(loadConfig({ GATEWAY_FILTER_TOOL_LIST: 'no' }).filterToolList).toBe(false);
    expect(loadConfig({ GATEWAY_FORWARD_CLIENT_AUTH: 'false' }).forwardClientAuth).toBe(false);
    expect(loadConfig({ GATEWAY_FORWARD_CLIENT_AUTH: 'on' }).forwardClientAuth).toBe(true);
    expect(loadConfig({ GATEWAY_FILTER_TOOL_LIST: '' }).filterToolList).toBe(false);
  });

  it('rejects a malformed downstream URL with a readable message', () => {
    expect(() => loadConfig({ GATEWAY_DOWNSTREAM_URL: 'not-a-url' })).toThrow(/downstreamUrl/);
  });

  it('rejects a too-short token secret', () => {
    expect(() => loadConfig({ GATEWAY_TOKEN_SECRET: 'short' })).toThrow(/tokenSecret/);
  });
});
