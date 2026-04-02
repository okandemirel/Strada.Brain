import { describe, it, expect } from "vitest";
import { getResilienceMessage } from "./resilience-messages.ts";
import type { MessageKey } from "./resilience-messages.ts";

const ALL_KEYS: MessageKey[] = [
  "provider_slow",
  "provider_failing",
  "provider_backoff",
  "provider_ask_user",
  "provider_abort",
];

const ALL_LANGUAGES = ["en", "tr", "ja", "ko", "zh", "de", "es", "fr"];

describe("getResilienceMessage", () => {
  it("returns English message by default", () => {
    const msg = getResilienceMessage("provider_slow", "en");
    expect(msg).toBe("The AI provider is experiencing delays. Retrying...");
  });

  it("returns Turkish message for TR language", () => {
    const msg = getResilienceMessage("provider_slow", "tr");
    expect(msg).toBe(
      "Yapay zeka sağlayıcısı gecikme yaşıyor. Yeniden deneniyor...",
    );
  });

  it("interpolates parameters (seconds, attempt, max)", () => {
    const msg = getResilienceMessage("provider_failing", "en", {
      seconds: 30,
      attempt: 2,
      max: 5,
    });
    expect(msg).toBe(
      "The AI provider is not responding. Waiting 30s before retry (2/5).",
    );
  });

  it("falls back to English for unknown language", () => {
    const msg = getResilienceMessage("provider_abort", "xx");
    expect(msg).toBe(
      "Unable to complete this task — the AI provider is not responding. Please try again later or switch to a different provider.",
    );
  });

  it("supports all 5 message keys in all 8 languages", () => {
    for (const lang of ALL_LANGUAGES) {
      for (const key of ALL_KEYS) {
        const msg = getResilienceMessage(key, lang);
        expect(msg).toBeTruthy();
        expect(typeof msg).toBe("string");
        expect(msg.length).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates parameters correctly in all languages", () => {
    const languages = ["en", "tr", "ja", "ko", "zh", "de", "es", "fr"];
    for (const lang of languages) {
      const msg = getResilienceMessage("provider_failing", lang, { seconds: 30, attempt: 2, max: 5 });
      expect(msg).not.toContain("{seconds}");
      expect(msg).not.toContain("{attempt}");
      expect(msg).not.toContain("{max}");
    }
  });

  it("handles case-insensitive language codes", () => {
    const upper = getResilienceMessage("provider_slow", "TR");
    const lower = getResilienceMessage("provider_slow", "tr");
    expect(upper).toBe(lower);
  });
});
