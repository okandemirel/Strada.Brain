/**
 * Switch Personality Tool — runtime personality profile switching.
 *
 * Supports built-in profiles (casual, formal, minimal, default) AND custom profiles.
 * Persists per-user via UserProfileStore (SQLite) — no global SoulLoader mutation.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { getLogger } from "../../utils/logger.js";
import { hasSoulLoader, hasUserProfileStore } from "./personality-context.js";

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

    // Persist per-user via UserProfileStore (SQLite — survives restarts)
    // Use userId (persistent profileId) over chatId (transient WebSocket session)
    const persistKey = context.userId ?? context.chatId;
    if (hasUserProfileStore(context) && persistKey) {
      try {
        context.userProfileStore.setActivePersona(persistKey, profile);
      } catch (err) {
        logger.warn("Failed to persist persona switch", { persistKey, profile, err });
      }
    }

    logger.info("Personality switched (per-user)", { profile, persistKey });
    return {
      content: `Personality switched to "${profile}" mode. My responses will now reflect this style.`,
    };
  }
}
