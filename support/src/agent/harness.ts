import type { ToolHost } from './tools.js';

// The seam between the conversation (Durable Object, protocol, grant, gate) and the agent runtime (OpenCode, see
// opencode.ts). The conversation only needs: run one turn of the agent with this input, stream what happens, report
// usage. Keeping it this small is what keeps the OpenCode version upgradable.

export type HarnessEvent =
  | { type: 'text.delta'; delta: string }
  | { type: 'tool.start'; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool.end'; callId: string; tool: string; ok: boolean };
/** inputTokens: uncached input plus cache writes; cacheReadTokens: cached input, billed at a tenth. */
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
export type TurnInput = {
  /** What the agent reads as the next user message (the customer's words, or a harness note in brackets). */
  text: string;
  /** Per-turn context the harness adds to the system prompt: <customer>, <context>, channel rules. */
  context: string;
};
export type TurnResult = { text: string; usage: Usage; aborted: boolean; error?: string };

export interface Harness {
  turn(input: TurnInput, tools: ToolHost, onEvent: (event: HarnessEvent) => void, signal: AbortSignal): Promise<TurnResult>;
}
