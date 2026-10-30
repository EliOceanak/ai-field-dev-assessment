import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WWW_AUTHENTICATE,
  authenticate,
  base64UrlEncode,
  parseBearerHeader,
  signToken,
  tokenId,
  verifySignedToken
} from '../../src/middleware/auth.js';
import { FIXED_NOW, TEST_SECRET, expiredToken, mintToken, tamperPayload } from '../helpers/tokens.js';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const options = { tokenSecret: TEST_SECRET, now: () => FIXED_NOW };

function header(value: string): { headers: Record<string, string> } {
  return { headers: { authorization: value } };
}

describe('signed bearer tokens', () => {
  it('accepts a token signed with the configured secret', () => {
    const token = mintToken('admin', { subject: 'alice' });
    const result = authenticate(header(`Bearer ${token}`), options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toEqual({ role: 'admin', subject: 'alice', tokenId: tokenId(token) });
  });

  it('rejects a tampered payload even though the signature is well-formed', () => {
    const result = authenticate(header(`Bearer ${tamperPayload(mintToken('viewer'))}`), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects a token signed with a different secret', () => {
    const result = authenticate(header(`Bearer ${mintToken('admin', { secret: 'another-secret' })}`), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects an expired token', () => {
    const result = authenticate(header(`Bearer ${expiredToken('admin')}`), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('expired');
  });

  it('accepts a token that is still valid one second before expiry', () => {
    const result = authenticate(header(`Bearer ${mintToken('admin', { ttlSeconds: 1 })}`), options);
    expect(result.ok).toBe(true);
  });

  it('accepts an unknown role and keeps it verbatim (least privilege downstream)', () => {
    const result = authenticate(header(`Bearer ${mintToken('auditor')}`), options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.role).toBe('auditor');
  });

  it('rejects a token with no signature segment', () => {
    const result = authenticate(header('Bearer abc123'), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_token');
  });

  it('rejects a signature that is not base64url', () => {
    const [payload] = mintToken('admin').split('.');
    const result = authenticate(header(`Bearer ${payload}.!!not-base64!!`), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_token');
  });

  it('checks the signature before the payload structure', () => {
    const segment = base64UrlEncode(JSON.stringify({ hello: 'world' }));
    const result = verifySignedToken(`${segment}.${base64UrlEncode('irrelevant')}`, TEST_SECRET, FIXED_NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects a correctly signed but structurally invalid payload', () => {
    const token = signToken({ sub: '', role: 'admin', exp: 9e9, iat: 0 }, TEST_SECRET);
    const result = verifySignedToken(token, TEST_SECRET, FIXED_NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_token');
  });

  it('never returns the raw token in the principal', () => {
    const token = mintToken('admin');
    const result = authenticate(header(`Bearer ${token}`), options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.principal)).not.toContain(token);
    expect(result.principal.tokenId).not.toBe(token);
    expect(result.principal.tokenId).toHaveLength(12);
  });
});

describe('Authorization header parsing', () => {
  it('requires the Bearer scheme', () => {
    expect(parseBearerHeader(undefined)).toMatchObject({ ok: false, reason: 'missing_header' });
    expect(parseBearerHeader('')).toMatchObject({ ok: false, reason: 'missing_header' });
    expect(parseBearerHeader('   ')).toMatchObject({ ok: false, reason: 'missing_header' });
    expect(parseBearerHeader('Basic dXNlcjpwYXNz')).toMatchObject({ ok: false, reason: 'malformed_header' });
    expect(parseBearerHeader('Bearer')).toMatchObject({ ok: false, reason: 'malformed_header' });
    expect(parseBearerHeader('Bearer ')).toMatchObject({ ok: false, reason: 'malformed_header' });
  });

  it.each([['Bearer'], ['bearer'], ['BEARER'], ['BeArEr']])(
    'matches the %s scheme case-insensitively',
    (scheme) => {
      expect(parseBearerHeader(`${scheme} tok`)).toEqual({ ok: true, token: 'tok' });
    }
  );

  it('tolerates surrounding whitespace', () => {
    expect(parseBearerHeader('  Bearer\ttok  ')).toEqual({ ok: true, token: 'tok' });
  });

  it('uses the first value when the header repeats', () => {
    expect(parseBearerHeader(['Bearer first', 'Bearer second'])).toEqual({ ok: true, token: 'first' });
  });

  it('advertises exactly the documented challenge', () => {
    expect(WWW_AUTHENTICATE).toBe('Bearer realm="mcp-gateway", error="invalid_token"');
  });
});

describe('static dev tokens', () => {
  const devOptions = { ...options, devTokens: { admin: 'admin-dev-token', viewer: 'viewer-dev-token' } };

  it('resolves a dev token to its role', () => {
    const result = authenticate(header('Bearer viewer-dev-token'), devOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toMatchObject({ role: 'viewer', subject: 'dev:viewer' });
  });

  it('rejects a dev token that is not configured', () => {
    const result = authenticate(header('Bearer nope-dev-token'), devOptions);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not `<payload>.<signature>` at all, so it never reaches the dev-token map.
    expect(result.reason).toBe('malformed_token');
  });

  it('rejects a well-formed but unknown signed token', () => {
    const result = authenticate(header(`Bearer ${mintToken('admin', { secret: 'other-secret' })}`), devOptions);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_signature');
  });

  it('prefers a valid signed token over an identical dev-map entry', () => {
    const signed = mintToken('admin');
    const result = authenticate(header(`Bearer ${signed}`), { ...devOptions, devTokens: { admin: signed } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.subject).toBe('admin-user');
  });
});

describe('scripts/mint-token.mjs', () => {
  it('mints a token the gateway verifier accepts (no drift between CLI and middleware)', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        resolve(PACKAGE_ROOT, 'scripts/mint-token.mjs'),
        '--role',
        'admin',
        '--ttl',
        '600',
        '--subject',
        'cli-user',
        '--json'
      ],
      { cwd: PACKAGE_ROOT, env: { ...process.env, GATEWAY_TOKEN_SECRET: TEST_SECRET } }
    );

    const parsed = JSON.parse(stdout) as { token: string; role: string; sub: string; exp: number; iat: number };
    expect(parsed.role).toBe('admin');
    expect(parsed.sub).toBe('cli-user');

    const atIssueTime = new Date(parsed.iat * 1000);
    const verified = verifySignedToken(parsed.token, TEST_SECRET, atIssueTime);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload).toEqual({ sub: 'cli-user', role: 'admin', exp: parsed.exp, iat: parsed.iat });

    const result = authenticate(header(`Bearer ${parsed.token}`), {
      tokenSecret: TEST_SECRET,
      now: () => atIssueTime
    });
    expect(result.ok).toBe(true);
  });

  it('exits non-zero without --role', async () => {
    await expect(
      execFileAsync(process.execPath, [resolve(PACKAGE_ROOT, 'scripts/mint-token.mjs')], { cwd: PACKAGE_ROOT })
    ).rejects.toMatchObject({ code: 1 });
  });
});

