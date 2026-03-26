import { describe, expect, it } from "vitest";
import {
  applyVisibleResponseContract,
  buildProfileParts,
  detectActivePersonaPreference,
  detectAssistantPersonaPreference,
  detectAssistantPersonalityPreference,
  extractExactResponseLiteral,
  extractNaturalLanguageDirectiveUpdates,
  resolveConversationScope,
  resolveIdentityKey,
  stripVisibleProviderArtifacts,
} from "./orchestrator-text-utils.js";

describe("orchestrator-text-utils", () => {
  it("honors exact response literal contracts", () => {
    const prompt = 'Please reply exactly: "ship it"';

    expect(extractExactResponseLiteral(prompt)).toBe("ship it");
    expect(applyVisibleResponseContract(prompt, "different text")).toBe("ship it");
  });

  it("strips provider reasoning artifacts from visible output", () => {
    const raw = "<reasoning>\ninternal chain of thought\n</reasoning>\n\nVisible answer.";

    expect(stripVisibleProviderArtifacts(raw)).toBe("Visible answer.");
    expect(applyVisibleResponseContract("Explain briefly", raw)).toBe("Visible answer.");
  });

  it("extracts natural language profile and autonomy updates", () => {
    const updates = extractNaturalLanguageDirectiveUpdates({
      latestProfile: {
        displayName: undefined,
        preferences: { communicationStyle: "formal" },
      },
      availablePersonas: ["default", "formal", "casual", "minimal"],
      prompt: "My name is Okan. From now on reply in JSON. Call yourself Atlas. Use the formal persona. Your personality should be calm and precise. Use full autonomy.",
      nowMs: 1_700_000_000_000,
    });

    expect(updates.displayName).toBe("Okan");
    expect(updates.activePersona).toBe("formal");
    expect(updates.preferences).toMatchObject({
      communicationStyle: "formal",
      assistantName: "Atlas",
      assistantPersonality: "calm",
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
        activePersona: "formal",
        preferences: {
          assistantName: "Atlas",
          assistantPersona: "technical mentor",
          assistantPersonality: "calm and challenging",
          ultrathinkMode: true,
        },
      }),
    ).toEqual([
      "Name: Okan",
      "Language: tr",
      "Active Persona Profile: formal",
      'Assistant Identity: When referring to yourself, use the name "Atlas".',
      "Assistant Persona Preference: technical mentor",
      "Assistant Personality Preference: calm and challenging",
      "Reasoning Mode: Use extra-careful, multi-step internal reasoning before answering.",
    ]);

    expect(resolveConversationScope("chat-1", " convo-2 ")).toBe("convo-2");
    expect(resolveIdentityKey("chat-1", undefined, " convo-2 ")).toBe("convo-2");
    expect(resolveIdentityKey("chat-1", " user-3 ", "convo-2")).toBe("user-3");
  });

  it("detects assistant persona, personality, and explicit persona switches", () => {
    expect(
      detectAssistantPersonaPreference("Bundan sonra persona'n teknik mentor gibi olsun."),
    ).toBe("teknik mentor");
    expect(
      detectAssistantPersonalityPreference("Your personality should be calm, warm, and a little playful."),
    ).toBe("calm, warm");
    expect(
      detectActivePersonaPreference("Lütfen formal persona kullan.", ["default", "formal", "casual"]),
    ).toBe("formal");
  });
});
