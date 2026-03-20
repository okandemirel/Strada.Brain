import { describe, expect, it } from "vitest";
import {
  applyVisibleResponseContract,
  buildProfileParts,
  extractExactResponseLiteral,
  extractNaturalLanguageDirectiveUpdates,
  resolveConversationScope,
  resolveIdentityKey,
} from "./orchestrator-text-utils.js";

describe("orchestrator-text-utils", () => {
  it("honors exact response literal contracts", () => {
    const prompt = 'Please reply exactly: "ship it"';

    expect(extractExactResponseLiteral(prompt)).toBe("ship it");
    expect(applyVisibleResponseContract(prompt, "different text")).toBe("ship it");
  });

  it("extracts natural language profile and autonomy updates", () => {
    const updates = extractNaturalLanguageDirectiveUpdates({
      latestProfile: {
        displayName: undefined,
        preferences: { communicationStyle: "formal" },
      },
      prompt: 'My name is Okan. From now on reply in JSON. Call yourself Atlas. Use full autonomy.',
      nowMs: 1_700_000_000_000,
    });

    expect(updates.displayName).toBe("Okan");
    expect(updates.preferences).toMatchObject({
      communicationStyle: "formal",
      assistantName: "Atlas",
      responseFormat: "json",
    });
    expect(updates.autonomousMode).toEqual({
      enabled: true,
      expiresAt: 1_700_086_400_000,
    });
  });

  it("builds prompt profile parts and resolves scope keys", () => {
    expect(
      buildProfileParts({
        displayName: "Okan",
        language: "tr",
        activePersona: "default",
        preferences: {
          assistantName: "Atlas",
          ultrathinkMode: true,
        },
      }),
    ).toEqual([
      "Name: Okan",
      "Language: tr",
      'Assistant Identity: When referring to yourself, use the name "Atlas".',
      "Reasoning Mode: Use extra-careful, multi-step internal reasoning before answering.",
    ]);

    expect(resolveConversationScope("chat-1", " convo-2 ")).toBe("convo-2");
    expect(resolveIdentityKey("chat-1", undefined, " convo-2 ")).toBe("convo-2");
    expect(resolveIdentityKey("chat-1", " user-3 ", "convo-2")).toBe("user-3");
  });
});
