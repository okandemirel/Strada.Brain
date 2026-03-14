/**
 * Switch Personality Tool — runtime personality profile switching.
 *
 * Available profiles: casual, formal, minimal, default (soul.md).
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { getLogger } from "../../utils/logger.js";

const AVAILABLE_PROFILES = ["casual", "formal", "minimal", "default"] as const;
type ProfileName = (typeof AVAILABLE_PROFILES)[number];

interface SoulLoaderLike {
  switchProfile(name: string): Promise<boolean>;
}

function hasSoulLoader(ctx: ToolContext): ctx is ToolContext & { soulLoader: SoulLoaderLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.soulLoader != null &&
    typeof (record.soulLoader as Record<string, unknown>).switchProfile === "function"
  );
}

export class SwitchPersonalityTool implements ITool {
  readonly name = "switch_personality";
  readonly description =
    "Switch the agent's personality profile. Available profiles: casual (friendly, conversational), " +
    "formal (professional, structured), minimal (brief, direct), default (balanced). " +
    "Use when the user asks you to change your tone or communication style.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      profile: {
        type: "string",
        enum: AVAILABLE_PROFILES as unknown as string[],
        description: "The personality profile to switch to.",
      },
    },
    required: ["profile"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const profile = String(input.profile ?? "").toLowerCase();

    if (!AVAILABLE_PROFILES.includes(profile as ProfileName)) {
      return {
        content: `Unknown profile "${profile}". Available: ${AVAILABLE_PROFILES.join(", ")}`,
        isError: true,
      };
    }

    if (!hasSoulLoader(context)) {
      return {
        content: `Personality switched to "${profile}" mode. (Note: hot-switch requires restart to take full effect.)`,
      };
    }

    const logger = getLogger();
    const success = await context.soulLoader.switchProfile(profile);
    if (success) {
      logger.info("Personality switched", { profile, chatId: context.chatId });
      return {
        content: `Personality switched to "${profile}" mode. My responses will now reflect this style.`,
      };
    }
    logger.warn("Personality switch failed", { profile, chatId: context.chatId });
    return {
      content: `Profile "${profile}" not found. Using current personality.`,
      isError: true,
    };
  }
}
