import { describe, expect, it } from 'vitest';
import type { Principal } from '../../src/middleware/auth.js';
import type { JsonRpcMessage } from '../../src/middleware/jsonrpc.js';
import {
  decide,
  filterToolListMessage,
  globToRegExp,
  loadPolicyFile,
  matchesAnyGlob,
  privilegedPrefixOf,
  toolNameOf
} from '../../src/policy/toolPolicy.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function principal(role: string): Principal {
  return { role, subject: `${role}-user`, tokenId: 'deadbeef0000' };
}

function call(name: string, id: number | undefined = 1): JsonRpcMessage {
  return id === undefined
    ? { jsonrpc: '2.0', method: 'tools/call', params: { name } }
    : { jsonrpc: '2.0', id, method: 'tools/call', params: { name } };
}

const base = { privilegedPrefixes: ['admin_'] };

describe('decide — the decision table', () => {
  it.each([
    ['admin', 'admin_reset_key', 'allow'],
    ['admin', 'admin_list_tenants', 'allow'],
    ['admin', 'get_customer_record', 'allow'],
    ['admin', 'trigger_refund', 'allow'],
    ['viewer', 'admin_reset_key', 'deny'],
    ['viewer', 'admin_list_tenants', 'deny'],
    ['viewer', 'get_customer_record', 'allow'],
    ['viewer', 'trigger_refund', 'allow'],
    ['auditor', 'admin_reset_key', 'deny'],
    ['auditor', 'get_customer_record', 'allow'],
    ['ADMIN', 'admin_reset_key', 'deny'],
    ['Admin', 'admin_reset_key', 'deny']
  ])('role %s calling %s → %s', (role, tool, expected) => {
    expect(decide(principal(role), call(tool), base).kind).toBe(expected);
  });

  it('always forwards tools/list, whatever the role', () => {
    for (const role of ['admin', 'viewer', 'auditor', '']) {
      const decision = decide(principal(role), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, base);
      expect(decision).toEqual({ kind: 'allow', reason: 'transparent_method' });
    }
  });

  it('forwards unknown methods so the downstream can answer -32601 itself', () => {
    const decision = decide(principal('viewer'), { jsonrpc: '2.0', id: 1, method: 'resources/list' }, base);
    expect(decision).toEqual({ kind: 'allow', reason: 'transparent_method' });
  });

  it('reports the required role and the tool on a denial', () => {
    const decision = decide(principal('viewer'), call('admin_reset_key'), base);
    expect(decision).toEqual({
      kind: 'deny',
      reason: 'insufficient_role',
      requiredRole: 'admin',
      tool: 'admin_reset_key'
    });
  });

  it('refuses a tools/call with no usable tool name instead of forwarding it', () => {
    // Fail closed: a call whose name cannot be read cannot be checked against the policy, so
    // forwarding it would let a caller reach a privileged tool by hiding the name in a type.
    expect(decide(principal('viewer'), { jsonrpc: '2.0', id: 1, method: 'tools/call' }, base)).toMatchObject({
      kind: 'deny',
      reason: 'unnameable_tool',
      code: -32602
    });
    expect(decide(principal('viewer'), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42 } }, base)).toMatchObject({
      kind: 'deny',
      code: -32602
    });
    // …and an admin gets the same answer: this is a malformed request, not a role question.
    expect(decide(principal('admin'), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: {} } }, base)).toMatchObject({
      kind: 'deny',
      code: -32602
    });
    // Other methods stay transparent: only `tools/call` needs a name.
    expect(decide(principal('viewer'), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, base).kind).toBe('allow');
  });

  it('is case-sensitive about the prefix (documented, tested behaviour)', () => {
    expect(decide(principal('viewer'), call('Admin_reset_key'), base).kind).toBe('allow');
  });

  it('honours a custom privileged prefix list', () => {
    const options = { privilegedPrefixes: ['admin_', 'billing_', 'internal.'] };
    expect(decide(principal('viewer'), call('billing_charge'), options).kind).toBe('deny');
    expect(decide(principal('viewer'), call('internal.sweep'), options).kind).toBe('deny');
    expect(decide(principal('admin'), call('billing_charge'), options).kind).toBe('allow');
  });

  it('honours a custom required role', () => {
    const options = { privilegedPrefixes: ['admin_'], requiredRole: 'operator' };
    expect(decide(principal('operator'), call('admin_reset_key'), options).kind).toBe('allow');
    expect(decide(principal('admin'), call('admin_reset_key'), options).kind).toBe('deny');
  });

  it('denies by policy glob whatever the role, even an admin', () => {
    const options = { ...base, denyGlobs: ['admin_*'] };
    expect(decide(principal('admin'), call('admin_reset_key'), options)).toMatchObject({
      kind: 'deny',
      reason: 'denied_by_policy'
    });
  });

  it('never lets an allow glob escalate past the prefix rule', () => {
    const options = { ...base, allowGlobs: ['*'] };
    expect(decide(principal('viewer'), call('admin_reset_key'), options).kind).toBe('deny');
    expect(decide(principal('viewer'), call('get_customer_record'), options)).toEqual({
      kind: 'allow',
      reason: 'allowed_by_policy'
    });
  });

  it('reads the tool name and normalises whitespace', () => {
    expect(toolNameOf(call('admin_reset_key'))).toBe('admin_reset_key');
    expect(toolNameOf(call('  admin_reset_key  '))).toBe('admin_reset_key');
    expect(toolNameOf({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBeUndefined();
    expect(toolNameOf({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: [1] })).toBeUndefined();
  });

  it('matches globs as anchored patterns', () => {
    expect(globToRegExp('admin_*').test('admin_reset_key')).toBe(true);
    expect(globToRegExp('admin_*').test('xadmin_y')).toBe(false);
    expect(globToRegExp('admin.*').test('admin.x')).toBe(true);
    expect(matchesAnyGlob('a.b', ['x*', 'a.b'])).toBe('a.b');
    expect(matchesAnyGlob('zz', ['x*', 'a.b'])).toBeUndefined();
  });

  it('finds the matching privileged prefix', () => {
    expect(privilegedPrefixOf('admin_reset_key', ['admin_'])).toBe('admin_');
    expect(privilegedPrefixOf('get_customer_record', ['admin_'])).toBeUndefined();
  });
});

describe('filterToolListMessage (hardened mode)', () => {
  const options = { privilegedPrefixes: ['admin_'] };
  const toolsList = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        { name: 'get_customer_record' },
        { name: 'admin_reset_key' },
        { name: 'admin_list_tenants' },
        { name: 'trigger_refund' }
      ]
    }
  };

  it('strips privileged tools and reports their names', () => {
    const filtered = filterToolListMessage(toolsList, options);

    expect(filtered.removed).toEqual(['admin_reset_key', 'admin_list_tenants']);
    expect((filtered.value as typeof toolsList).result.tools.map((tool) => tool.name)).toEqual([
      'get_customer_record',
      'trigger_refund'
    ]);
  });

  it('does not mutate the input message', () => {
    filterToolListMessage(toolsList, options);
    expect(toolsList.result.tools).toHaveLength(4);
  });

  it('leaves a message without a tools array untouched', () => {
    expect(filterToolListMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } }, options)).toEqual({
      value: { jsonrpc: '2.0', id: 1, result: { ok: true } },
      removed: []
    });
    expect(filterToolListMessage(null, options).removed).toEqual([]);
    expect(filterToolListMessage([1, 2], options).removed).toEqual([]);
  });

  it('returns an empty tools array rather than dropping the key', () => {
    const filtered = filterToolListMessage({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'admin_x' }] } }, options);
    expect((filtered.value as { result: { tools: unknown[] } }).result.tools).toEqual([]);
  });
});

describe('loadPolicyFile', () => {
  it('reads the shipped example policy', () => {
    const policy = loadPolicyFile(resolve(PACKAGE_ROOT, 'config/policy.example.json'));

    expect(policy.privilegedPrefixes).toEqual(['admin_', 'internal_']);
    expect(policy.requiredRole).toBe('admin');
    expect(policy.denyGlobs).toEqual(['drop_database']);
    expect(policy.allowGlobs).toEqual(['get_*']);
  });

  it('applies the file-driven prefixes through decide()', () => {
    const policy = loadPolicyFile(resolve(PACKAGE_ROOT, 'config/policy.example.json'));

    expect(decide(principal('viewer'), call('internal_sweep'), policy).kind).toBe('deny');
    expect(decide(principal('admin'), call('drop_database'), policy).kind).toBe('deny');
    expect(decide(principal('admin'), call('internal_sweep'), policy).kind).toBe('allow');
  });
});
