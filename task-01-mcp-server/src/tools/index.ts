/**
 * The tool registry: exactly two tools, in a stable order.
 *
 * `tools/list` must return exactly these two, so the registry is a frozen tuple
 * rather than a mutable map — a third tool cannot be added by accident.
 */
import { getCustomerRecordTool } from './getCustomerRecord.js';
import { triggerRefundTool } from './triggerRefund.js';
import type { ToolDefinition } from './types.js';

export type { ToolContext, ToolDefinition } from './types.js';

const REGISTERED = [getCustomerRecordTool, triggerRefundTool] as const;

/** The two tools this server exposes, in a stable order. */
export const TOOLS: readonly ToolDefinition[] = REGISTERED;

export type ToolName = (typeof REGISTERED)[number]['name'];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
