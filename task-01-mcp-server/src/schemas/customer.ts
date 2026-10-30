/**
 * Strict Zod input schemas for the two tools.
 *
 * These are the single source of truth for three things:
 *   1. the JSON Schema advertised by `tools/list` (the SDK converts the Zod
 *      object with `zod/v4-mini`'s `toJSONSchema`, so the advertised contract
 *      and the enforced contract cannot drift);
 *   2. the validation performed by `src/protocol/toolCallGuard.ts`;
 *   3. the `data.issues[]` payload of every `-32602` response.
 *
 * Strictness policy (documented in the README): unknown keys are **rejected**,
 * not stripped. The brief asks for "strict input schema validation", and a
 * silently dropped `amount_usd: 25` typo would turn a refund into a
 * "missing amount" error at best and a wrong refund at worst.
 */
import { z } from 'zod';

/** `CUST-` followed by exactly five digits. Anchored — no leading/trailing noise. */
export const CUSTOMER_ID_PATTERN = /^CUST-\d{5}$/;

export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

/**
 * `amount` must be a money value: a finite number, strictly positive, and an
 * exact multiple of `0.01`.
 *
 * The decimal check deliberately inspects the canonical string form instead of
 * multiplying by 100: `1e-9 * 100` is `1e-7`, which is *smaller* than any
 * sensible float tolerance, so a tolerance-based test would accept it. The
 * string form also rejects exponent notation (`1e-9`, `1e21`), which is never a
 * legitimate refund amount.
 */
export function hasAtMostTwoDecimals(value: number): boolean {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) return false;
  const dot = text.indexOf('.');
  return dot === -1 || text.length - dot - 1 <= 2;
}

export const customerIdSchema = z
  .string({ message: 'customer_id must be a string' })
  .regex(CUSTOMER_ID_PATTERN, {
    message: 'customer_id must match CUST-XXXXX (CUST- followed by exactly 5 digits)'
  })
  .describe('Customer identifier: `CUST-` followed by exactly five digits, e.g. `CUST-00001`.');

export const amountSchema = z
  .number({ message: 'amount must be a number' })
  .gt(0, { message: 'amount must be greater than 0' })
  .refine((value) => Number.isFinite(value), { message: 'amount must be a finite number' })
  .refine(hasAtMostTwoDecimals, {
    message: 'amount must be a money value with at most 2 decimal places (multiples of 0.01)'
  })
  .describe('Refund amount in USD: a positive number with at most two decimal places.');

export const reasonSchema = z
  .string({ message: 'reason must be a string' })
  .trim()
  .min(MIN_REASON_LENGTH, {
    message: `reason must be at least ${MIN_REASON_LENGTH} characters after trimming`
  })
  .max(MAX_REASON_LENGTH, {
    message: `reason must be at most ${MAX_REASON_LENGTH} characters`
  })
  .describe(
    `Human-readable justification for the refund (${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters after trimming).`
  );

/** Optional caller-supplied key that makes `trigger_refund` idempotent. */
export const idempotencyKeySchema = z
  .string({ message: 'idempotency_key must be a string' })
  .trim()
  .min(1, { message: 'idempotency_key must not be empty' })
  .max(64, { message: 'idempotency_key must be at most 64 characters' })
  .describe(
    'Optional idempotency key. Re-sending the same key returns the original refund instead of applying a second one.'
  );

export const getCustomerRecordInputSchema = z.strictObject({
  customer_id: customerIdSchema
});

export const triggerRefundInputSchema = z.strictObject({
  customer_id: customerIdSchema,
  amount: amountSchema,
  reason: reasonSchema,
  idempotency_key: idempotencyKeySchema.optional()
});

export type GetCustomerRecordInput = z.infer<typeof getCustomerRecordInputSchema>;
export type TriggerRefundInput = z.infer<typeof triggerRefundInputSchema>;

/** The record shape returned by `get_customer_record` (also its `outputSchema`). */
export const customerRecordSchema = z.strictObject({
  customer_id: customerIdSchema,
  name: z.string().min(1),
  email: z.string().min(3),
  plan: z.enum(['free', 'pro', 'enterprise']),
  balance_usd: z.number(),
  refunds: z.array(
    z.strictObject({
      refund_id: z.string().min(1),
      customer_id: customerIdSchema,
      amount_usd: z.number(),
      reason: z.string(),
      created_at: z.string(),
      balance_after_usd: z.number()
    })
  )
});

export const refundReceiptSchema = z.strictObject({
  refund_id: z.string().min(1),
  customer_id: customerIdSchema,
  amount_usd: z.number(),
  new_balance_usd: z.number(),
  reason: z.string(),
  idempotent_replay: z.boolean()
});

/**
 * JSON Schema for a Zod schema, in the same dialect the SDK advertises.
 *
 * Zod 4 ships `z.toJSONSchema`; the SDK uses the identical implementation
 * (`zod/v4-mini`) when it serialises `inputSchema` for `tools/list`. Tests use
 * this to assert that the advertised schema *is* the enforced schema.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
}
