/**
 * What a delegated sub-agent is told: its type's system prompt, the task, and
 * the caller's context. The calling model writes the task and the context, so
 * this text is the delegate's whole brief, not a user's message.
 */

import type { DelegationTypeConfig } from "./delegation-types.js";

export function delegationBrief(
  typeConfig: DelegationTypeConfig,
  task: string,
  context: string | undefined,
): string {
  const systemPrompt =
    typeConfig.systemPrompt ??
    `You are a specialized sub-agent for ${typeConfig.name.replace(/_/g, " ")} tasks. Complete the assigned task concisely and return the result. Do not delegate further.`;
  return context
    ? `${systemPrompt}\n\nTask: ${task}\n\nContext: ${context}`
    : `${systemPrompt}\n\nTask: ${task}`;
}
