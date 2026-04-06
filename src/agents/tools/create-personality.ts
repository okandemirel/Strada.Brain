/**
 * Create Personality Tool — lets users create custom personality profiles via chat.
 *
 * Saves the profile to .strada-memory/profiles/ and activates it immediately.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { getLogger } from "../../utils/logger.js";
import { hasSoulLoaderWithPersistence, hasUserProfileStore } from "./personality-context.js";

/** Reserved profile names that cannot be overwritten by users */
const RESERVED_NAMES = new Set(["default", "casual", "formal", "minimal"]);

/** Valid name pattern: lowercase alphanumeric, hyphens, underscores, max 64 chars */
const NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** Max personality content size in bytes */
const MAX_CONTENT_BYTES = 10 * 1024;

/** Patterns that indicate prompt injection attempts */
const INJECTION_PATTERNS = [
  /\[.*JAILBREAK.*\]/i,
  /IGNORE\s+(ALL\s+)?PREVIOUS\s+INSTRUCTIONS/i,
  /OVERRIDE\s+(ALL\s+)?INSTRUCTIONS/i,
  /<<\s*SYSTEM\s*>>/i,
  /\bYOU\s+ARE\s+NOW\b.*\bNEW\s+INSTRUCTIONS\b/i,
  /\bDO\s+NOT\s+FOLLOW\s+(ANY|YOUR)\s+(PREVIOUS\s+)?INSTRUCTIONS\b/i,
  /\bACT\s+AS\s+(A\s+)?(?:DAN|DEVELOPER\s+MODE|UNRESTRICTED)\b/i,
  // Structural markers that could override system prompts
  /^#{1,3}\s*(SYSTEM|INSTRUCTION|OVERRIDE|IMPORTANT)\b/im,
  /<\|im_start\|>/i,
  /<<\s*SYS\s*>>/i,
  /\[INST\]/i,
  // Multilingual / rephrased variants
  /\b(?:FORGET|DISREGARD)\s+(?:ALL|EVERYTHING)\s+(?:ABOVE|PREVIOUS|PRIOR)\b/i,
  /\bNEW\s+SYSTEM\s+PROMPT\b/i,
  /\bPRETEND\s+YOU\s+ARE\s+(?:NO\s+LONGER|NOT)\s+BOUND\b/i,
];

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

    // Enforce content size limit
    if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
      return {
        content: `Profile content exceeds the maximum size limit of ${MAX_CONTENT_BYTES / 1024} KB.`,
        isError: true,
      };
    }

    // Check for prompt injection patterns
    if (INJECTION_PATTERNS.some((p) => p.test(content))) {
      logger.warn("Prompt injection attempt blocked in personality creation", { name });
      return {
        content:
          "Profile content contains patterns that could interfere with system instructions. " +
          "Please rephrase the personality description using natural language.",
        isError: true,
      };
    }

    if (!hasSoulLoaderWithPersistence(context)) {
      return {
        content:
          `Custom profile "${name}" created in memory. ` +
          `Note: Full persistence requires SoulLoader — restart may be needed for full effect.`,
      };
    }

    // Resolve persistent identity key early so all log paths use the same identifier
    const persistKey = context.userId ?? context.chatId;

    // Save the profile
    const saved = await context.soulLoader.saveProfile(name, content);
    if (!saved) {
      logger.warn("Create personality failed — saveProfile returned false", {
        name,
        persistKey,
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
        persistKey,
      });
      return {
        content:
          `Profile "${name}" saved but could not be verified. ` +
          `Try switching to it with: "switch to ${name} persona".`,
      };
    }

    // Update user profile store if available
    if (hasUserProfileStore(context) && persistKey) {
      try {
        context.userProfileStore.setActivePersona(persistKey, name);
      } catch (err) {
        logger.warn("Failed to persist persona for custom profile", { persistKey, name, err });
      }
    }

    logger.info("Custom personality created and activated", {
      name,
      persistKey,
    });

    return {
      content:
        `Custom personality "${name}" created and activated. ` +
        `My responses will now reflect this style. ` +
        `Use /persona switch default to go back, or /persona delete ${name} to remove it.`,
    };
  }
}
