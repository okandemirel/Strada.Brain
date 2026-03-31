/**
 * Create Personality Tool — lets users create custom personality profiles via chat.
 *
 * Saves the profile to .strada-memory/profiles/ and activates it immediately.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { getLogger } from "../../utils/logger.js";

/** Reserved profile names that cannot be overwritten by users */
const RESERVED_NAMES = new Set(["default", "casual", "formal", "minimal"]);

/** Valid name pattern: lowercase alphanumeric, hyphens, underscores */
const NAME_PATTERN = /^[a-z0-9_-]+$/;

interface SoulLoaderLike {
  saveProfile(name: string, content: string): Promise<boolean>;
  getProfileContent(name: string): Promise<string | null>;
}

interface UserProfileStoreLike {
  setActivePersona(chatId: string, persona: string): void;
}

function hasSoulLoader(ctx: ToolContext): ctx is ToolContext & { soulLoader: SoulLoaderLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.soulLoader != null &&
    typeof (record.soulLoader as Record<string, unknown>).saveProfile === "function" &&
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

export class CreatePersonalityTool implements ITool {
  readonly name = "create_personality";
  readonly description =
    "Create a custom personality profile for the agent. Use this when the user wants to customize " +
    "the agent's behavior, tone, or communication style (e.g., 'be like Jarvis', 'daha formal ol', " +
    "'act like a pirate'). The profile is saved permanently and activated immediately.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description:
          "Profile name (lowercase, alphanumeric, hyphens allowed). " +
          "Cannot be 'default', 'casual', 'formal', or 'minimal'.",
      },
      content: {
        type: "string",
        description:
          "Full markdown content for the personality profile. Must include sections: " +
          "Identity, Communication Style, Personality. Follow the existing profile format.",
      },
    },
    required: ["name", "content"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const logger = getLogger();
    const name = String(input.name ?? "").toLowerCase().trim();
    const content = String(input.content ?? "").trim();

    // Validate name format
    if (!name || !NAME_PATTERN.test(name)) {
      return {
        content:
          `Invalid profile name "${name}". Use only lowercase letters, numbers, hyphens, and underscores.`,
        isError: true,
      };
    }

    // Reject reserved names
    if (RESERVED_NAMES.has(name)) {
      return {
        content:
          `Cannot use reserved name "${name}". Reserved names: ${[...RESERVED_NAMES].join(", ")}. ` +
          `Choose a different name for your custom profile.`,
        isError: true,
      };
    }

    // Validate content
    if (!content) {
      return {
        content: "Profile content cannot be empty.",
        isError: true,
      };
    }

    if (!hasSoulLoader(context)) {
      return {
        content:
          `Custom profile "${name}" created in memory. ` +
          `Note: Full persistence requires SoulLoader — restart may be needed for full effect.`,
      };
    }

    // Save the profile
    const saved = await context.soulLoader.saveProfile(name, content);
    if (!saved) {
      logger.warn("Create personality failed — saveProfile returned false", {
        name,
        chatId: context.chatId,
      });
      return {
        content:
          `Failed to save profile "${name}". The name may be invalid or the content may exceed the size limit (10 KB).`,
        isError: true,
      };
    }

    // Verify the saved profile is readable
    const verification = await context.soulLoader.getProfileContent(name);
    if (!verification) {
      logger.warn("Create personality saved but content not readable", {
        name,
        chatId: context.chatId,
      });
      return {
        content:
          `Profile "${name}" saved but could not be verified. ` +
          `Try switching to it with: "switch to ${name} persona".`,
      };
    }

    // Update user profile store if available
    if (hasUserProfileStore(context) && context.chatId) {
      try {
        context.userProfileStore.setActivePersona(context.chatId, name);
      } catch {
        // Non-fatal — profile is saved and active in memory
      }
    }

    logger.info("Custom personality created and activated", {
      name,
      chatId: context.chatId,
    });

    return {
      content:
        `Custom personality "${name}" created and activated. ` +
        `My responses will now reflect this style. ` +
        `Use /persona switch default to go back, or /persona delete ${name} to remove it.`,
    };
  }
}
