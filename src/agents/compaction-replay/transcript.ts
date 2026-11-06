/**
 * The input of the offline compaction replay: sessions as the agent loop sent
 * them, one entry per provider call.
 *
 * Each turn holds the messages the loop appended to the history since the
 * previous call, never the history itself, so every compaction strategy
 * starts from the same uncompacted sequence and applies its own cuts. Two
 * producers write this shape:
 * - log-skeleton.ts builds it from the daemon log: the sizes are real, the
 *   content is a deterministic placeholder ("shape replay");
 * - a recorded transcript file, read here, carries the real content.
 *
 * Offline only: nothing in the live loop imports this directory
 * (docs/memory/entries/2026-11-04-compaction-must-respect-the-prefix-cache.md).
 */

import { z } from "zod";
import type { ConversationMessage } from "../providers/provider-core.interface.js";

export interface ReplayTurn {
  /** System prompt characters the call carried, before any compaction summary is appended. */
  readonly promptChars: number;
  /** Tool schema characters the call carried. */
  readonly toolChars: number;
  /** What the provider counted for the call, when known. Read for fidelity, never for the arms. */
  readonly inputTokens?: number;
  /**
   * The live loop cut its history before this call (a compaction or a message-cap trim), so from
   * here on the logged input no longer describes the uncompacted history. Read for fidelity only.
   */
  readonly liveCut?: boolean;
  /** Messages appended to the history since the previous call of the session. */
  readonly append: readonly ConversationMessage[];
}

export interface ReplaySession {
  readonly id: string;
  readonly turns: readonly ReplayTurn[];
}

/** Whether the content is real ("transcript") or placeholder text sized from the log ("shape"). */
export type ReplaySource = "shape" | "transcript";

const toolCall = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const contentBlock = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.string(), is_error: z.boolean().optional() }),
  z.object({ type: z.literal("image"), source: z.unknown() }),
]);

const message = z.union([
  z.object({ role: z.literal("user"), content: z.union([z.string(), z.array(contentBlock)]) }),
  z.object({ role: z.literal("assistant"), content: z.string(), tool_calls: z.array(toolCall).optional() }),
]);

const count = z.number().int().nonnegative();

const transcriptFile = z.object({
  version: z.literal(1),
  sessions: z.array(
    z.object({
      id: z.string(),
      turns: z.array(
        z.object({
          promptChars: count,
          toolChars: count,
          inputTokens: count.optional(),
          liveCut: z.boolean().optional(),
          append: z.array(message),
        }),
      ),
    }),
  ),
});

/**
 * Reads a recorded transcript file:
 * `{ "version": 1, "sessions": [{ "id", "turns": [{ "promptChars", "toolChars", "inputTokens"?, "liveCut"?, "append": [messages] }] }] }`.
 * Throws with the first schema error, naming its path, when the file does not match.
 */
export function parseTranscript(json: unknown): ReplaySession[] {
  const parsed = transcriptFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") || "(root)" : "(root)";
    throw new Error(`not a replay transcript: ${where}: ${issue?.message ?? "invalid"}`);
  }
  // The schema mirrors ConversationMessage; zod's inferred record type is wider than JsonObject.
  return parsed.data.sessions as unknown as ReplaySession[];
}
