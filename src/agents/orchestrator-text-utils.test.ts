import { describe, expect, it } from "vitest";
import {
  applyVisibleResponseContract,
  buildProfileParts,
  detectActivePersonaPreference,
  detectAssistantPersonaPreference,
  detectAssistantPersonalityPreference,
  detectLanguageFromText,
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
      prompt: "My name is Okan. From now on reply in JSON. Call yourself Atlas. Use the formal persona. Your personality should be calm and precise. I give you full autonomy.",
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

  // Natural-language autonomy turns write confirmations off for 24 h, is stored
  // in the profile and sends no notice, so only an instruction to the assistant
  // may count. "autonomous mode" / "otonom mod" is also an everyday game-feature
  // name, so a command that carries a game target, a condition or a later
  // position in the message is a feature request, not the switch.
  describe("natural-language autonomy directive", () => {
    const autonomyFor = (prompt: string) =>
      extractNaturalLanguageDirectiveUpdates({ latestProfile: null, prompt, nowMs: 0 }).autonomousMode;

    const mustNotEnable: Record<"en" | "tr", string[]> = {
      en: [
        // questions
        "How does autonomous mode work?",
        "What does autonomous mode do?",
        "Does autonomous mode work with git push?",
        "Can you enable autonomous mode?",
        "Should I turn on autonomous mode for this task?",
        "Enable autonomous mode?",
        "Do you have full authority to delete files?",
        "Why did the autonomous agent stop? Can you make it work again?",
        // explanations
        "Autonomous mode lets the agent skip write confirmations.",
        "Explain how to enable autonomous mode.",
        // negations
        "Don't enable autonomous mode",
        "Please don't enable autonomous mode.",
        "Do not turn on autonomous mode yet.",
        "Never use full autonomy.",
        "Under no circumstances, enable autonomous mode",
        "I don't want you to use full autonomy.",
        // quoted text
        'The button label says "Enable autonomous mode".',
        '"Use full autonomy" is the tooltip text',
        "> Enable autonomous mode",
        // conditions and game features
        "If the build passes, enable autonomous mode.",
        "Make the enemy AI autonomous so it can work without the player",
        "Enemy NPCs should be autonomous and work in squads",
        "The boss has full authority over the minions",
        "Enable autonomous mode for the enemy AI",
        "Activate autonomous mode on the turret after 5 seconds",
        "Start autonomous mode in the RoverController coroutine",
        "Use the autonomous mode toggle in the settings menu",
        "Turn on autonomous mode when the player is idle",
        "Switch to autonomous mode and attack the nearest enemy",
        "Add a drone with patrol and chase states. Switch to autonomous mode when the target is lost.",
        "Add a drone with patrol and chase states. Switch to autonomous mode.",
        "Fix the bug in EnemyAI.cs and enable autonomous mode for the bots",
        "Add a Buy button to the shop. Continue without waiting for confirmation.",
        // A grant with no addressee after the opening is a feature spec.
        "Add a drone with patrol and chase states. Enable full autonomy.",
        "Add an admin role. Enable full authority.",
        "Give the turret an override switch. Activate full autonomy.",
      ],
      tr: [
        // questions
        "otonom mod nedir?",
        "Otonom mod aktif mi?",
        "otonom mod etkin mi",
        "otonom mod nasıl aktif edilir?",
        "Otonom mod nasıl açılır?",
        "otonom mod ne işe yarar",
        "Otonom modu açar mısın?",
        "Commit onay istemeden push edilir mi?",
        "Neden otonom moda geçtin?",
        // negations and other tenses
        "otonom modu açma",
        "Lütfen otonom modu açma",
        "Asla otonom modu açma",
        "Otonom modu açmayın",
        "Otonom modu açmak istemiyorum",
        "Otonom modu açtım",
        // quoted text and explanations
        'Butonun etiketi "otonom modu aç" olsun',
        "Otonom mod açıkken onay sorulmuyor",
        // conditions and game features
        "Düşmanlar otonom çalışsın, oyuncuya ihtiyaç duymasın",
        "otonom çalışan bir düşman yapay zekası yap",
        "Düşman yapay zekası için otonom modu aç",
        "Butona basınca otonom modu aç",
        "Drone hedefi kaybedince otonom moda geç",
        "Oyuncu ölünce düşmanlar otonom çalış",
        "Ayarlar menüsüne otonom modu aç butonu ekle",
        "Otonom modu aç, düşman yapay zekası için",
        "Drone'a devriye ve kovalama durumları ekle. Otonom moda geç.",
        "Mağazaya satın al butonu ekle. Onay beklemeden devam et.",
        "Admin rolü ekle. Tam yetki ver.",
        "Admin rolünü ekledim. Tam yetki verdim.",
        "Moderatör rolü ekle. Tam yetki veriyorum.",
      ],
    };

    const shouldEnable: Record<"en" | "tr", string[]> = {
      en: [
        "Enable autonomous mode",
        "ENABLE AUTONOMOUS MODE",
        "Please enable autonomous mode.",
        "Turn on autonomous mode for this task",
        "Activate autonomous mode now.",
        "Switch to autonomous mode, please",
        "Ok, enter autonomous mode.",
        "Go ahead and enable autonomous mode",
        "From now on, use autonomous mode.",
        "Turn autonomous mode on.",
        "Go autonomous.",
        "Work autonomously from now on.",
        "Use full autonomy.",
        "Enable full autonomy for this session.",
        "You have full autonomy.",
        "I give you full autonomy for this project.",
        "Proceed without asking for approval.",
        "Enable autonomous mode. Then refactor the inventory system.",
        "Hi! Enable autonomous mode for the rest of this session.",
        // A grant addressed to the assistant also counts after other settings.
        "My name is Okan. You have full autonomy.",
        "My name is Okan. I grant you full authority.",
      ],
      tr: [
        "otonom modu aç",
        "OTONOM MODU AÇ",
        "otonom modu ac",
        "otonom modu aktif et",
        "otonom modunu aç",
        "Otonom modu açın",
        "Lütfen otonom moda geç.",
        "Otonom moda geçelim",
        "otonom çalış",
        "otonom çalışabilirsin",
        "Artık otonom çalış",
        "Bundan sonra otonom modda çalış.",
        "Tamam, otonom modu başlat",
        "Şimdi otonom modu etkinleştir",
        "Otonom mod aktif olsun",
        "Bu oturum için otonom modu aç",
        "Bu görev için autonom çalış ve approval sormadan ilerle.",
        "onay sormadan ilerle lütfen",
        "ONAY SORMADAN İLERLE",
        "Onay beklemeden devam et",
        "sana tam yetki veriyorum",
        "Tam yetki veriyorum.",
        "Tam yetkiyle ilerle.",
        "Otonom modu aç. Sonra build hatalarını düzelt.",
        "Adım Okan. Sana tam yetki veriyorum.",
        "Adım Okan. Tam yetkilisin.",
        "Adım Okan. Tam yetkiyle ilerle.",
      ],
    };

    const table = (byLanguage: Record<"en" | "tr", string[]>) =>
      (["en", "tr"] as const).flatMap((language) => byLanguage[language].map((prompt) => [language, prompt] as const));

    it("covers at least 15 phrasings per language and direction", () => {
      for (const byLanguage of [mustNotEnable, shouldEnable]) {
        expect(byLanguage.en.length).toBeGreaterThanOrEqual(15);
        expect(byLanguage.tr.length).toBeGreaterThanOrEqual(15);
      }
    });

    it.each(table(mustNotEnable))("leaves autonomy off for the %s non-directive %j", (_language, prompt) => {
      expect(autonomyFor(prompt)).not.toEqual(expect.objectContaining({ enabled: true }));
    });

    it.each(table(shouldEnable))("enables autonomy for the %s directive %j", (_language, prompt) => {
      expect(autonomyFor(prompt)).toEqual({ enabled: true, expiresAt: 86_400_000 });
    });
  });

  // A persona switch is `/persona switch`, which the owner rule refuses a
  // guest, so a sentence that merely names a persona ("default", "casual")
  // near "use", "set", "mode" or "profile" drew "Refused" on an everyday line.
  describe("natural-language persona switch", () => {
    const PERSONAS = ["default", "formal", "casual", "minimal"];
    const personaFor = (prompt: string) =>
      extractNaturalLanguageDirectiveUpdates({ latestProfile: null, prompt, availablePersonas: PERSONAS }).activePersona;

    it.each([
      "Use the default settings for the build.",
      "Set the default resolution to 1080p.",
      "Add a casual mode for new players.",
      "Implement level 3. Use the default camera profile.",
      "Set up the default scene for level 2.",
      "Use the default profile for new users.",
      "Can you switch to the formal persona?",
      "Oyuna casual mod ekle.",
      "Oyuncu ölünce casual moda geç.",
      "Formal persona kullanma.",
    ])("switches nothing for %j", (prompt) => {
      expect(personaFor(prompt)).toBeUndefined();
    });

    it.each([
      ["Use the formal persona.", "formal"],
      ["Please use the casual persona from now on.", "casual"],
      ["Switch to casual mode.", "casual"],
      ["Switch back to the default persona.", "default"],
      ["Go back to default.", "default"],
      ["Set your persona to minimal.", "minimal"],
      ["My name is Okan. Use the formal persona. Reply briefly.", "formal"],
      ["Formal persona kullan.", "formal"],
      ["Lütfen formal persona kullan.", "formal"],
      ["Casual moda geç.", "casual"],
      ["Kendine Nova de. Formal persona kullan.", "formal"],
    ])("switches %j to %s", (prompt, persona) => {
      expect(personaFor(prompt)).toBe(persona);
    });
  });

  // The detected language is written into the profile and English is never
  // detected, so a stray asset name or localized string must not decide it.
  describe("detectLanguageFromText", () => {
    it.each([
      "Make a Pokémon-style battle system",
      "Rename the Müller NPC",
      "Add a button labeled 決定 to the menu",
      "Add a café scene",
      "Fix the naïve AI",
      "Add an aide-de-camp NPC",
      "use the ile file",
      "Set the label to `Başla` in the menu",
      'Show "Hoş geldin" on the title screen',
    ])("keeps the profile language for the English prompt %j", (prompt) => {
      expect(detectLanguageFromText(prompt)).toBeNull();
      expect(
        extractNaturalLanguageDirectiveUpdates({ latestProfile: null, prompt }).language,
      ).toBeUndefined();
    });

    it.each([
      ["Merhaba", "tr"],
      ["Düşmanları ekle", "tr"],
      ["etmiyor gibi gözüküyor emin misin?", "tr"],
      ["bu dosyayi duzelt", "tr"],
      ["Temp altında `strada_autonomy_smoke.txt` oluştur.", "tr"],
      ["PlayerController.cs içindeki Update metodunu düzelt, Rigidbody velocity hesaplaması yanlış", "tr"],
      ["ボタンを追加して", "ja"],
      ["PlayerController の Update メソッドを修正して", "ja"],
      ["안녕하세요", "ko"],
      ["Hallo, schön dich zu sehen", "de"],
      ["Hola, necesito ayuda con mi proyecto", "es"],
      ["¿Dónde está el botón?", "es"],
      ["Bonjour, aide-moi avec le projet", "fr"],
      ["Le café est fermé", "fr"],
    ])("detects %j as %s", (prompt, language) => {
      expect(detectLanguageFromText(prompt)).toBe(language);
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
