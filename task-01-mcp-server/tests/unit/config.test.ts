import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadDotEnv } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when no MCP_* variables are set', () => {
    expect(loadConfig({})).toEqual({
      serverName: 'customer-ops-mcp',
      serverVersion: '1.0.0',
      logLevel: 'info'
    });
  });

  it('reads every value from the environment', () => {
    const config = loadConfig({
      MCP_SERVER_NAME: 'billing-mcp',
      MCP_SERVER_VERSION: '2.1.0',
      MCP_LOG_LEVEL: 'debug',
      MCP_SEED_DATA_PATH: '/tmp/customers.json'
    });

    expect(config).toEqual({
      serverName: 'billing-mcp',
      serverVersion: '2.1.0',
      logLevel: 'debug',
      seedDataPath: '/tmp/customers.json'
    });
  });

  it('rejects an unknown log level with a readable message', () => {
    expect(() => loadConfig({ MCP_LOG_LEVEL: 'verbose' })).toThrow(/Invalid MCP server configuration/);
    expect(() => loadConfig({ MCP_LOG_LEVEL: 'verbose' })).toThrow(/logLevel/);
  });

  it('rejects an empty server name', () => {
    expect(() => loadConfig({ MCP_SERVER_NAME: '' })).toThrow(/serverName/);
  });
});

describe('loadDotEnv', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads KEY=value pairs, skips comments, strips quotes and never overrides the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'));
    tempDirs.push(dir);
    const envFile = join(dir, '.env');
    writeFileSync(
      envFile,
      [
        '# a comment',
        '',
        'DOTENV_TEST_PLAIN=from-file',
        'DOTENV_TEST_QUOTED="quoted value"',
        'DOTENV_TEST_PRESET=from-file',
        'not-an-assignment'
      ].join('\n')
    );

    process.env.DOTENV_TEST_PRESET = 'from-process';
    try {
      loadDotEnv([envFile]);

      expect(process.env.DOTENV_TEST_PLAIN).toBe('from-file');
      expect(process.env.DOTENV_TEST_QUOTED).toBe('quoted value');
      expect(process.env.DOTENV_TEST_PRESET).toBe('from-process');
    } finally {
      delete process.env.DOTENV_TEST_PLAIN;
      delete process.env.DOTENV_TEST_QUOTED;
      delete process.env.DOTENV_TEST_PRESET;
    }
  });

  it('ignores missing files', () => {
    expect(() => loadDotEnv(['/definitely/not/here/.env'])).not.toThrow();
  });
});
