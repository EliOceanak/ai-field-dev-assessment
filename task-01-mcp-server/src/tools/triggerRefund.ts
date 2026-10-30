/**
 * `trigger_refund` — validate, then apply a refund against the customer balance.
 *
 * Domain outcomes (unknown customer, refund larger than the balance) are
 * `isError: true` tool results; only schema violations are JSON-RPC errors.
 * Refund ids are deterministic and sequential per process, and an optional
 * `idempotency_key` makes a retried call a replay instead of a double refund.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DomainError, toolError, toolResult } from '../protocol/errors.js';
import { refundReceiptSchema, triggerRefundInputSchema } from '../schemas/customer.js';
import type { TriggerRefundInput } from '../schemas/customer.js';
import type { ToolContext, ToolDefinition } from './types.js';

export const TRIGGER_REFUND = 'trigger_refund';

export const triggerRefundTool: ToolDefinition<TriggerRefundInput> = {
  name: TRIGGER_REFUND,
  title: 'Trigger refund',
  description:
    'Refund an amount (USD, at most 2 decimals) to a customer identified as `CUST-XXXXX`. Requires a reason of at least 10 characters. Returns the refund id, the refunded amount and the resulting balance.',
  inputSchema: triggerRefundInputSchema,
  outputSchema: refundReceiptSchema,
  annotations: {
    title: 'Trigger refund',
    readOnlyHint: false,
    // A refund moves money out of the balance but destroys nothing, and the
    // same arguments do apply a second refund unless an idempotency_key is sent.
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },

  handler({ customer_id: customerId, amount, reason, idempotency_key: idempotencyKey }, ctx: ToolContext): CallToolResult {
    const before = ctx.store.getCustomer(customerId);
    const refundsBefore = ctx.store.listRefunds().length;

    try {
      const refund = ctx.store.applyRefund({
        customerId,
        amount,
        reason,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey })
      });

      const idempotentReplay = ctx.store.listRefunds().length === refundsBefore;
      ctx.logger.info(idempotentReplay ? 'tool_replayed' : 'tool_completed', {
        refundId: refund.refund_id,
        amountUsd: refund.amount_usd,
        balanceBeforeUsd: before?.balance_usd,
        newBalanceUsd: refund.balance_after_usd,
        reasonChars: reason.length,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey })
      });

      return toolResult({
        refund_id: refund.refund_id,
        customer_id: refund.customer_id,
        amount_usd: refund.amount_usd,
        new_balance_usd: refund.balance_after_usd,
        reason: refund.reason,
        idempotent_replay: idempotentReplay
      });
    } catch (error) {
      if (error instanceof DomainError) {
        ctx.logger.warn('tool_rejected', { reason: error.code, ...error.details });
        return toolError(error.code, error.message, error.details);
      }
      throw error;
    }
  }
};
