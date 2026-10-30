#!/usr/bin/env node
/**
 * Mint a gateway bearer token.
 *
 *   node scripts/mint-token.mjs --role admin --ttl 3600
 *   node scripts/mint-token.mjs --role viewer --ttl 60 --subject alice@example.com --json
 *
 * Format (mirrors `src/middleware/auth.ts` exactly):
 *
 *   base64url(JSON.stringify({sub, role, exp, iat})) + '.' + base64url(HMAC-SHA256(secret, payload))
 *
 * `exp`/`iat` are unix **seconds**. The secret comes from `--secret`, else
 * `GATEWAY_TOKEN_SECRET`, else the same development default the config uses.
 *
 * This file is plain JS on purpose (`node scripts/mint-token.mjs`, no `tsx`) so the
 * secret never has to be handed to a build step. `tests/unit/auth.test.ts` spawns it
 * and verifies the output through the real verifier, so the two implementations
 * cannot drift apart unnoticed.
 */
import { createHmac } from 'node:crypto';

const DEFAULTS = { ttl: 3600, secret: 'dev-secret-change-me' };

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [name, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
    } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      flags[name] = argv[index + 1];
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

if (flags.help === true || flags.h === true) {
  process.stdout.write(
    [
      'Usage: node scripts/mint-token.mjs --role <role> [--ttl <seconds>] [--subject <sub>]',
      '                                        [--secret <secret>] [--json]',
      '',
      '  --role     admin | viewer | any string   (required)',
      '  --ttl      seconds of validity           (default 3600, may be negative)',
      '  --subject  caller identity               (default "<role>-user")',
      '  --secret   HMAC secret                   (default $GATEWAY_TOKEN_SECRET)',
      '  --json     print { token, role, sub, exp, iat } instead of the bare token',
      ''
    ].join('\n')
  );
  process.exit(0);
}

const role = typeof flags.role === 'string' ? flags.role : undefined;
if (role === undefined || role.trim() === '') {
  process.stderr.write('mint-token: --role is required (try --help)\n');
  process.exit(1);
}

const ttl = flags.ttl === undefined ? DEFAULTS.ttl : Number(flags.ttl);
if (!Number.isFinite(ttl)) {
  process.stderr.write('mint-token: --ttl must be a number of seconds\n');
  process.exit(1);
}

const secret =
  typeof flags.secret === 'string'
    ? flags.secret
    : (process.env.GATEWAY_TOKEN_SECRET ?? DEFAULTS.secret);
if (secret.length < 8) {
  process.stderr.write('mint-token: the secret must be at least 8 characters\n');
  process.exit(1);
}

const subject = typeof flags.subject === 'string' ? flags.subject : `${role.trim()}-user`;
const issuedAt = Math.floor(Date.now() / 1000);
const payload = { sub: subject, role: role.trim(), exp: issuedAt + Math.round(ttl), iat: issuedAt };

const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const signature = createHmac('sha256', secret).update(segment).digest().toString('base64url');
const token = `${segment}.${signature}`;

if (flags.json === true) {
  process.stdout.write(`${JSON.stringify({ token, ...payload })}\n`);
} else {
  process.stdout.write(`${token}\n`);
}
