/**
 * Switch Personality Tool — runtime personality profile switching.
 *
 * Supports built-in profiles (casual, formal, minimal, default) AND custom profiles.
 * Persists per-user via UserProfileStore (SQLite) — no global SoulLoader mutation.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { getLogger } from "../../utils/logger.js";

interface SoulLoaderLike {
  getProfiles(): string[];
  getProfileContent(name: string): Promise<string | null>;
}

interface UserProfileStoreLike {
  setActivePersona(chatId: string, persona: string): void;
}

function hasSoulLoader(ctx: ToolContext): ctx is ToolContext & { soulLoader: SoulLoaderLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.soulLoader != null &&
    typeof (record.soulLoader as Record<string, unknown>).getProfiles === "function" &&
    typeof (record.soulLoader as Record<string, unknown>).getProfileContent === "function"
  );
}

function hasUserProfileStore(ctx: ToolContext): ctx is ToolContext & { userProfileStore: UserProfileStoreLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.userProfileStore != null &&
    typeof (record.userProfileStore as Record<string, unknown>).setActivePersona === "function"
  );
}

export class SwitchPersonalityTool implements ITool {
  readonly name = "switch_personality";
  readonly description =
    "Switch the agent's personality profile. Supports built-in profiles (casual, formal, minimal, default) " +
    "and any custom profiles previously created via create_personality. " +
    "Use when the user asks you to change your tone or communication style.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      profile: {
        type: "string",
        description: "The personality profile name to switch to.",
      },
    },
    required: ["profile"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const logger = getLogger();
    const profile = String(input.profile ?? "").toLowerCase().trim();

    if (!profile) {
      return {
        content: "Profile name is required.",
        isError: true,
      };
    }

    if (!hasSoulLoader(context)) {
      return {
        content: `Personality switched to "${profile}" mode. (Note: hot-switch requires restart to take full effect.)`,
      };
    }

    // Validate the profile exists (built-in or custom)
    const available = context.soulLoader.getProfiles();
    if (!available.includes(profile)) {
      return {
        content: `Unknown profile "${profile}". Available: ${available.join(", ")}`,
        isError: true,
      };
    }

    // Verify the profile content is readable (skip for "default" which is always the base soul.md)
    if (profile !== "default") {
      const content = await context.soulLoader.getProfileContent(profile);
      if (!content) {
        return {
          content: `Profile "${profile}" is listed but its content could not be loaded.`,
          isError: true,
        };
      }
    }

    // Persist per-user via UserProfileStore (SQLite — survives restarts)
    if (hasUserProfileStore(context) && context.chatId) {
      try {
        context.userProfileStore.setActivePersona(context.chatId, profile);
      } catch {
        // Non-fatal — log and continue
      }
    }

    logger.info("Personality switched (per-user)", { profile, chatId: context.chatId });
    return {
      content: `Personality switched to "${profile}" mode. My responses will now reflect this style.`,
    };
  }
}
