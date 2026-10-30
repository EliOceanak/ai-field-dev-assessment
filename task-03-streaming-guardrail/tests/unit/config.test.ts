import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      port: 8790,
      upstreamBaseUrl: 'http://127.0.0.1:8080/v1',
      upstreamTimeoutMs: 120_000,
      maxHoldbackBytes: 512,
      logLevel: 'info'
    });
    expect(config.redaction).toEqual({
      replacement: '[REDACTED]',
      typedPlaceholders: false,
      customPatterns: []
    });
  });

  it('reads the upstream and redaction settings from the environment', () => {
    const config = loadConfig({
      GUARDRAIL_UPSTREAM_BASE_URL: 'http://127.0.0.1:11434/v1',
      GUARDRAIL_REDACTION_REPLACEMENT: '***',
      GUARDRAIL_TYPED_PLACEHOLDERS: 'true',
      GUARDRAIL_MAX_HOLDBACK_BYTES: '1024'
    });

    expect(config.upstreamBaseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.redaction.replacement).toBe('***');
    expect(config.redaction.typedPlaceholders).toBe(true);
    expect(config.maxHoldbackBytes).toBe(1024);
  });

  it('parses custom patterns from JSON', () => {
    const config = loadConfig({
      GUARDRAIL_CUSTOM_PATTERNS: '[{"name":"employee_id","pattern":"EMP-\\\\d{6}"}]'
    });

    expect(config.redaction.customPatterns).toEqual([{ name: 'employee_id', pattern: 'EMP-\\d{6}' }]);
  });

  it('rejects an invalid custom pattern with a readable message', () => {
    expect(() => loadConfig({ GUARDRAIL_CUSTOM_PATTERNS: '[{"name":"broken","pattern":"([a-z"}]' })).toThrow(
      /customPatterns/
    );
  });

  it('rejects malformed custom-pattern JSON', () => {
    expect(() => loadConfig({ GUARDRAIL_CUSTOM_PATTERNS: 'not json' })).toThrow();
  });

  it('rejects a non-URL upstream base', () => {
    expect(() => loadConfig({ GUARDRAIL_UPSTREAM_BASE_URL: 'localhost:8080' })).toThrow(/upstreamBaseUrl/);
  });

  it('treats the string "false" as false (a z.coerce.boolean trap)', () => {
    // `.env.example` ships GUARDRAIL_TYPED_PLACEHOLDERS=false; `Boolean("false")` is `true`.
    expect(loadConfig({ GUARDRAIL_TYPED_PLACEHOLDERS: 'false' }).redaction.typedPlaceholders).toBe(false);
    expect(loadConfig({ GUARDRAIL_TYPED_PLACEHOLDERS: '0' }).redaction.typedPlaceholders).toBe(false);
    expect(loadConfig({ GUARDRAIL_TYPED_PLACEHOLDERS: '' }).redaction.typedPlaceholders).toBe(false);
    expect(loadConfig({ GUARDRAIL_TYPED_PLACEHOLDERS: 'TRUE' }).redaction.typedPlaceholders).toBe(true);
    expect(loadConfig({ GUARDRAIL_TYPED_PLACEHOLDERS: '1' }).redaction.typedPlaceholders).toBe(true);
  });
});
