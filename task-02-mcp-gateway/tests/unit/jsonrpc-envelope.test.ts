import { describe, expect, it } from 'vitest';
import {
  findDuplicateKey,
  isNotification,
  parseJsonRpcBody,
  requestIdOf,
  serializeMessages
} from '../../src/middleware/jsonrpc.js';
import { JsonRpcErrorCode, httpStatusFor, jsonRpcError, sanitizeMessage } from '../../src/errors/gatewayErrors.js';

function expectError(body: ReturnType<typeof parseJsonRpcBody>): {
  status: number;
  error: { code: number; message: string; data?: unknown };
} {
  if (body.kind !== 'error') throw new Error(`expected an error body, got ${body.kind}`);
  return { status: body.status, error: body.error.error };
}

describe('parseJsonRpcBody', () => {
  it('parses a single request and keeps the raw text for byte-identical forwarding', () => {
    const text = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
    const body = parseJsonRpcBody(text);

    expect(body.kind).toBe('single');
    if (body.kind !== 'single') return;
    expect(body.message).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(body.text).toBe(text);
    expect(isNotification(body.message)).toBe(false);
  });

  it('parses a batch into indexed entries', () => {
    const body = parseJsonRpcBody(
      '[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","method":"notifications/initialized"}]'
    );

    expect(body.kind).toBe('batch');
    if (body.kind !== 'batch') return;
    expect(body.total).toBe(2);
    expect(body.entries.map((entry) => entry.index)).toEqual([0, 1]);
    expect(body.messages).toHaveLength(2);
    expect(body.invalid).toHaveLength(0);
    expect(isNotification(body.messages[1]!)).toBe(true);
  });

  it('treats a message without an id as a notification', () => {
    const body = parseJsonRpcBody('{"jsonrpc":"2.0","method":"notifications/initialized"}');

    expect(body.kind).toBe('single');
    if (body.kind !== 'single') return;
    expect(isNotification(body.message)).toBe(true);
    expect(requestIdOf(body.message)).toBeUndefined();
  });

  it.each([
    ['number', 42],
    ['zero', 0],
    ['string', 'abc'],
    ['empty string', ''],
    ['null', null]
  ])('preserves an id of type %s exactly', (_label, id) => {
    const body = parseJsonRpcBody(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }));

    expect(body.kind).toBe('single');
    if (body.kind !== 'single') return;
    expect(requestIdOf(body.message)).toBe(id);
  });

  it('leaves params absent when the request has none', () => {
    const body = parseJsonRpcBody('{"jsonrpc":"2.0","id":1,"method":"ping"}');

    expect(body.kind).toBe('single');
    if (body.kind !== 'single') return;
    expect('params' in body.message).toBe(false);
  });

  it('accepts positional (array) params untouched', () => {
    const body = parseJsonRpcBody('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":[1,2]}');

    expect(body.kind).toBe('single');
    if (body.kind !== 'single') return;
    expect(body.message.params).toEqual([1, 2]);
  });

  it('rejects a body that is not JSON with -32700 and id null', () => {
    const result = expectError(parseJsonRpcBody('{"jsonrpc": "2.0",'));

    expect(result.status).toBe(400);
    expect(result.error.code).toBe(JsonRpcErrorCode.ParseError);
    expect(result.error.message).toBe('Parse error');
  });

  it('rejects an empty body with -32700', () => {
    expect(expectError(parseJsonRpcBody('')).error.code).toBe(JsonRpcErrorCode.ParseError);
  });

  it.each([
    ['missing jsonrpc', '{"id":1,"method":"tools/list"}'],
    ['wrong jsonrpc version', '{"jsonrpc":"1.0","id":1,"method":"tools/list"}'],
    ['numeric jsonrpc', '{"jsonrpc":2.0,"id":1,"method":"tools/list"}'],
    ['non-string method', '{"jsonrpc":"2.0","id":1,"method":42}'],
    ['empty method', '{"jsonrpc":"2.0","id":1,"method":""}'],
    ['object id', '{"jsonrpc":"2.0","id":{"nested":true},"method":"tools/list"}'],
    ['boolean id', '{"jsonrpc":"2.0","id":true,"method":"tools/list"}'],
    ['primitive params', '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":"x"}'],
    ['bare array element', '[1]'],
    ['null body', 'null'],
    ['scalar body', '42'],
    ['string body', '"hello"']
  ])('rejects %s with -32600', (_label, text) => {
    const result = expectError(parseJsonRpcBody(text));

    expect(result.status).toBe(400);
    expect(result.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(result.error.message).toBe('Invalid request');
  });

  it('echoes the id on an envelope violation when the id itself is well-formed', () => {
    const result = expectError(parseJsonRpcBody('{"jsonrpc":"1.0","id":"keep-me","method":"tools/list"}'));

    expect(result.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    const body = parseJsonRpcBody('{"jsonrpc":"1.0","id":"keep-me","method":"tools/list"}');
    expect(body.kind === 'error' ? body.error.id : undefined).toBe('keep-me');
    expect(result.status).toBe(400);
  });

  it('rejects an empty batch with a single -32600 object', () => {
    const body = parseJsonRpcBody('[]');

    expect(body.kind).toBe('error');
    if (body.kind !== 'error') return;
    expect(body.error.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(body.error.id).toBeNull();
    expect(body.status).toBe(400);
  });

  it('collects per-element errors in a mixed batch and keeps the positions', () => {
    const body = parseJsonRpcBody(
      '[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"1.0"},{"jsonrpc":"2.0","id":3,"method":"ping"}]'
    );

    expect(body.kind).toBe('batch');
    if (body.kind !== 'batch') return;
    expect(body.total).toBe(3);
    expect(body.messages.map((message) => message.method)).toEqual(['tools/list', 'ping']);
    expect(body.entries.map((entry) => entry.index)).toEqual([0, 2]);
    expect(body.invalid.map((element) => element.index)).toEqual([1]);
    expect(body.invalid[0]?.error.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it('fails a batch where every element is invalid', () => {
    const body = parseJsonRpcBody('[{"jsonrpc":"1.0"},7]');

    expect(body.kind).toBe('error');
    if (body.kind !== 'error') return;
    expect(body.status).toBe(400);
  });

  it('serializes a modified batch back to JSON-RPC', () => {
    const text = serializeMessages([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);

    expect(JSON.parse(text)).toEqual([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  });

  it('refuses a body with a duplicate key with -32600 and id null, even inside a batch', () => {
    for (const text of [
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"tools/list","params":{"name":"admin_reset_key"}}',
      '[{"jsonrpc":"2.0","id":1,"method":"tools/list"},' +
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x","name":"y"}}]'
    ]) {
      const { status, error } = expectError(parseJsonRpcBody(text));
      expect(status).toBe(400);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error.data).toMatchObject({ reason: 'duplicate_key' });
    }
  });
});

describe('findDuplicateKey', () => {
  it('finds a key repeated in the same object, at any depth', () => {
    expect(findDuplicateKey('{"a":1,"a":2}')).toBe('a');
    expect(findDuplicateKey('{"params":{"name":"x","arguments":{},"name":"y"}}')).toBe('name');
    expect(findDuplicateKey('[{"ok":1},{"id":1,"x":{"k":[{"v":1,"v":2}]}}]')).toBe('v');
  });

  it('compares keys after unescaping, the way JSON.parse does', () => {
    expect(findDuplicateKey('{"method":"tools/call","m\\u0065thod":"tools/list"}')).toBe('method');
  });

  it('accepts the same key in different objects, and keys that only appear as values', () => {
    expect(findDuplicateKey('[{"id":1,"method":"a"},{"id":2,"method":"b"}]')).toBeUndefined();
    expect(findDuplicateKey('{"a":{"b":1},"b":{"a":1}}')).toBeUndefined();
    expect(findDuplicateKey('{"name":"name","list":["name","name"]}')).toBeUndefined();
  });

  it('is not fooled by braces, quotes, commas or colons inside strings', () => {
    expect(findDuplicateKey('{"a":"},{\\"a\\":1,","b":"[\\"a\\":"}')).toBeUndefined();
    expect(findDuplicateKey('{"a\\"":1,"a":2}')).toBeUndefined();
    expect(findDuplicateKey('{"k":"\\\\","k":1}')).toBe('k');
  });

  it('returns undefined for scalars, empty containers and ordinary requests', () => {
    expect(findDuplicateKey('42')).toBeUndefined();
    expect(findDuplicateKey('{}')).toBeUndefined();
    expect(findDuplicateKey('[]')).toBeUndefined();
    const call = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t","arguments":{"a":[1,{"b":2}]}}}';
    expect(findDuplicateKey(call)).toBeUndefined();
  });
});

describe('gatewayErrors', () => {
  it('omits data entirely when none is supplied', () => {
    expect(jsonRpcError({ id: 1, code: -32600, message: 'Invalid request' })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid request' }
    });
  });

  it('maps codes onto the documented HTTP statuses', () => {
    expect(httpStatusFor(-32700)).toBe(400);
    expect(httpStatusFor(-32600)).toBe(400);
    expect(httpStatusFor(-32602)).toBe(400);
    expect(httpStatusFor(-32601)).toBe(404);
    expect(httpStatusFor(-32603)).toBe(500);
    // The one that matters: a policy denial is an answer, not a transport failure.
    expect(httpStatusFor(-32001)).toBe(200);
  });

  it('keeps short, safe messages and replaces anything that could leak', () => {
    expect(sanitizeMessage(new Error('socket closed'))).toBe('socket closed');
    expect(sanitizeMessage(new Error('connect ECONNREFUSED 127.0.0.1:8788'))).toBe('Internal error');
    expect(sanitizeMessage(new Error('failed to reach http://internal.example/mcp'))).toBe('Internal error');
    expect(sanitizeMessage(new Error('at foo (/srv/app/src/server.ts:12:3)'))).toBe('Internal error');
    expect(sanitizeMessage(new Error('Bearer eyJhbGciOiJIUzI1NiJ9.payload'))).toBe('Internal error');
    expect(sanitizeMessage(new Error('x'.repeat(500)))).toBe('Internal error');
    expect(sanitizeMessage(undefined)).toBe('Internal error');
  });
});
