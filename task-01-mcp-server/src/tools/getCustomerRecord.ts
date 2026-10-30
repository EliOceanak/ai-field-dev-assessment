/**
 * `get_customer_record` — read one customer record.
 *
 * Success → `structuredContent` (the machine-readable record) plus a readable
 * text block. An unknown-but-well-formed id is a **domain** outcome, so it
 * returns `isError: true` and never a JSON-RPC error.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolError, toolResult } from '../protocol/errors.js';
import { customerRecordSchema, getCustomerRecordInputSchema } from '../schemas/customer.js';
import type { GetCustomerRecordInput } from '../schemas/customer.js';
import type { ToolContext, ToolDefinition } from './types.js';

export const GET_CUSTOMER_RECORD = 'get_customer_record';

export const getCustomerRecordTool: ToolDefinition<GetCustomerRecordInput> = {
  name: GET_CUSTOMER_RECORD,
  title: 'Get customer record',
  description:
    'Look up a single customer record by id (format `CUST-XXXXX`). Returns name, email, plan, current balance in USD and the refunds already applied to that customer.',
  inputSchema: getCustomerRecordInputSchema,
  outputSchema: customerRecordSchema,
  annotations: { title: 'Get customer record', readOnlyHint: true, destructiveHint: false, openWorldHint: false },

  handler({ customer_id: customerId }, ctx: ToolContext): CallToolResult {
    const customer = ctx.store.getCustomer(customerId);
    if (customer === undefined) {
      ctx.logger.warn('tool_rejected', { reason: 'customer_not_found' });
      return toolError('customer_not_found', `No customer record found for ${customerId}`, {
        customer_id: customerId
      });
    }

    const record = {
      customer_id: customer.customer_id,
      name: customer.name,
      email: customer.email,
      plan: customer.plan,
      balance_usd: customer.balance_usd,
      refunds: customer.refunds
    };

    ctx.logger.info('tool_completed', {
      reason: 'customer_found',
      plan: customer.plan,
      refundCount: customer.refunds.length
    });

    return toolResult(record);
  }
};
