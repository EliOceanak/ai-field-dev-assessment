/**
 * Request validation.
 *
 * Two rules shape this file:
 *  1. **Loose objects.** A gateway must not silently drop provider-specific fields (`tools`,
 *     `stream_options`, `reasoning_effort`, `response_format`), so unknown keys pass through and
 *     the *original* parsed body — not the Zod output — is what gets forwarded upstream.
 *  2. **No values in error detail.** `toIssues()` keeps only the dotted field path and the stable
 *     Zod issue code. A validation error therefore cannot echo a prompt back to the caller.
 */
import { z } from 'zod';
import type { FieldIssue } from '../errors/gatewayErrors.js';

const messageSchema = z.looseObject({
  role: z.string().min(1),
  content: z.unknown().optional(),
  name: z.string().optional()
});

export const chatCompletionSchema = z.looseObject({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: z.unknown().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional()
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionSchema> & Record<string, unknown>;

/** Field paths and issue codes only — a validation error must never echo a value back. */
export function toIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
}

export interface ValidationOutcome {
  ok: boolean;
  request?: ChatCompletionRequest;
  issues: FieldIssue[];
}

export function validateChatCompletion(body: unknown): ValidationOutcome {
  const parsed = chatCompletionSchema.safeParse(body);
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };
  // The raw body is forwarded upstream; validation only decides whether we accept the request.
  return { ok: true, request: (typeof body === 'object' && body !== null ? body : parsed.data) as ChatCompletionRequest, issues: [] };
}
