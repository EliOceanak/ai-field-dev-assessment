/**
 * Error contracts: the `-32602` issue mapping, the JSON-RPC envelope builder and
 * the tool-level error/result shapes. No transport involved.
 */
import { describe, expect, it } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DomainError,
  ErrorCode,
  McpToolInputError,
  jsonRpcError,
  mapZodError,
  mcpError,
  toolError,
  toolResult
} from '../../src/protocol/errors.js';
import { getCustomerRecordInputSchema, triggerRefundInputSchema } from '../../src/schemas/customer.js';

function issuesFor(schema: z.ZodType, input: unknown): ReturnType<typeof mapZodError> {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('expected the parse to fail');
  return mapZodError(result.error);
}

describe('mapZodError', () => {
  it('maps a bad customer_id to its field path', () => {
    expect(issuesFor(getCustomerRecordInputSchema, { customer_id: 'nope' })).toEqual([
      {
        path: 'customer_id',
        message: 'customer_id must match CUST-XXXXX (CUST- followed by exactly 5 digits)',
        code: 'invalid_format'
      }
    ]);
  });

  it('maps each bad field of trigger_refund to its own path', () => {
    expect(issuesFor(triggerRefundInputSchema, { customer_id: 'CUST-00001', amount: 0, reason: 'short' })).toEqual([
      { path: 'amount', message: 'amount must be greater than 0', code: 'too_small' },
      { path: 'reason', message: 'reason must be at least 10 characters after trimming', code: 'too_small' }
    ]);
  });

  it('reports the missing fields of an empty argument object', () => {
    expect(issuesFor(triggerRefundInputSchema, {}).map((issue) => issue.path)).toEqual([
      'customer_id',
      'amount',
      'reason'
    ]);
  });

  it('uses the offending key name as the path for unknown keys', () => {
    expect(issuesFor(triggerRefundInputSchema, { customer_id: 'CUST-00001', amount: 1, reason: 'ten chars!', extra: 1 })).toEqual([
      { path: 'extra', message: 'Unrecognized key: "extra"', code: 'unrecognized_keys' }
    ]);
  });

  it('falls back to (root) when an issue has no path', () => {
    const result = z.strictObject({ a: z.string() }).safeParse('not an object');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(mapZodError(result.error)).toEqual([
      { path: '(root)', message: expect.stringContaining('expected object') as unknown as string, code: 'invalid_type' }
    ]);
  });

  it('produces issues that survive a JSON round trip (they are wire data)', () => {
    const issues = issuesFor(getCustomerRecordInputSchema, { customer_id: 42 });
    expect(JSON.parse(JSON.stringify(issues))).toEqual(issues);
  });
});

describe('jsonRpcError', () => {
  it('builds a spec-shaped error envelope without data when none is given', () => {
    expect(jsonRpcError({ id: 7, code: ErrorCode.MethodNotFound, message: 'Method not found' })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Method not found' }
    });
  });

  it('keeps `id: null` and includes data when provided', () => {
    const envelope = jsonRpcError({
      id: null,
      code: ErrorCode.ParseError,
      message: 'Parse error',
      data: { issues: [] }
    });
    expect(envelope.id).toBeNull();
    expect(envelope.error).toEqual({ code: -32700, message: 'Parse error', data: { issues: [] } });
  });

  it('echoes string ids exactly', () => {
    expect(jsonRpcError({ id: 'abc', code: ErrorCode.InvalidRequest, message: 'Invalid Request' }).id).toBe('abc');
  });
});

describe('McpToolInputError', () => {
  it('carries -32602, the exact message and structured issues', () => {
    const error = new McpToolInputError('trigger_refund', 'req-1', [
      { path: 'amount', message: 'amount must be greater than 0', code: 'too_small' }
    ]);

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(ErrorCode.InvalidParams);
    // The SDK would otherwise prefix `MCP error -32602: `.
    expect(error.message).toBe('Invalid params');
    expect(error.data).toEqual({
      tool: 'trigger_refund',
      reqId: 'req-1',
      issues: [{ path: 'amount', message: 'amount must be greater than 0', code: 'too_small' }]
    });
  });
});

describe('mcpError', () => {
  it('keeps the exact message the client reads', () => {
    const error = mcpError(ErrorCode.InternalError, 'Internal error', { reqId: 'req-9' });
    expect(error.message).toBe('Internal error');
    expect(error.code).toBe(-32603);
    expect(error.data).toEqual({ reqId: 'req-9' });
  });
});

describe('tool results', () => {
  const firstTextBlock = (result: { content: Array<{ type: string; text?: string }> }): string => {
    const block = result.content[0];
    if (block === undefined || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('expected a text content block');
    }
    return block.text;
  };

  it('wraps a success payload as readable text plus structuredContent', () => {
    const result = toolResult({ refund_id: 'REF-000001', amount_usd: 25 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ refund_id: 'REF-000001', amount_usd: 25 });
    expect(JSON.parse(firstTextBlock(result))).toEqual({ refund_id: 'REF-000001', amount_usd: 25 });
  });

  it('wraps a domain failure as isError with a machine-readable code and no structuredContent', () => {
    const result = toolError('insufficient_funds', 'Refund exceeds balance', { balance_usd: 10 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(firstTextBlock(result))).toEqual({
      error: { code: 'insufficient_funds', message: 'Refund exceeds balance', balance_usd: 10 }
    });
  });
});

describe('DomainError', () => {
  it('carries a stable code and details for the tool layer', () => {
    const error = new DomainError('customer_not_found', 'No customer record for CUST-09999', {
      customer_id: 'CUST-09999'
    });
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('customer_not_found');
    expect(error.details).toEqual({ customer_id: 'CUST-09999' });
    expect(error).toBeInstanceOf(Error);
  });
});
