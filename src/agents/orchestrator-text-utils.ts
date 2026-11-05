import { redactSensitiveText } from "../security/api-key-redaction.js";

const NATURAL_LANGUAGE_AUTONOMOUS_HOURS = 24;
const NAME_INTRO_RE = /(?:ben\s+|i(?:'|’)m\s+|my name is\s+|ad[ıi]m\s+)([\p{L}]+)/iu;
const EXPLICIT_USER_NAME_RE = /(?:benim\s+ad[ıi]m|ad[ıi]m|my\s+name\s+is|i(?:'|’)m|call\s+me)\s+(?:şu|su|as)?\s*["“]?([\p{L}\p{N}][\p{L}\p{N}\s._-]{0,39})/iu;
const USER_ADDRESS_NAME_RE = /(?:bana|beni)\s+["“]?([\p{L}\p{N}][\p{L}\p{N}\s._-]{0,39})["”]?\s+(?:de|diye\s+(?:çağır|cagir|hitap\s+et)|call\s+me)/iu;
const ASSISTANT_NAME_RE = /(?:bundan\s+sonra\s+)?(?:senin\s+)?(?:ad[ıi]n|ismin|your\s+name\s+(?:should\s+be|is)|call\s+yourself)\s*(?:şu|su|as)?\s*(?:olsun|olacak|be|is|:|-)?\s*["“]?([\p{L}\p{N}][\p{L}\p{N}\s._-]{0,39})/iu;
const ASSISTANT_CALL_NAME_RE = /(?:bundan\s+sonra\s+)?kendine\s+(?:şu|su)?\s*["“]?([\p{L}\p{N}][\p{L}\p{N}\s._-]{0,39})["”]?\s+de/iu;
const ASSISTANT_PERSONA_PATTERNS = [
  /(?:sen(?:in)?|assistant|strada(?:['’]n[ıiuü]n)?|your)\s+(?:persona(?:['’][a-zçğıöşü]+)?\b|role\b|rol(?:['’][a-zçğıöşü]+)?\b|kimli(?:ğ|g)(?:in|i)?)\s*(?:should\s+be|be|olsun|ol(?:acak|sun)?|:|-)?\s*(.+)$/iu,
  /(?:persona(?:['’][a-zçğıöşü]+)?\b|role\b|rol(?:['’][a-zçğıöşü]+)?\b|kimli(?:ğ|g)(?:in|i)?)\s*(?:should\s+be|be|olsun|ol(?:acak|sun)?|:|-)?\s*(.+)$/iu,
  /(?:bundan\s+sonra|from\s+now\s+on)\s+(?:bir\s+|a\s+|an\s+)?(.+?)\s+(?:gibi\s+(?:davran|ol)|act\s+like)\b/iu,
] as const;
const ASSISTANT_PERSONALITY_PATTERNS = [
  /(?:sen(?:in)?|assistant|strada(?:['’]n[ıiuü]n)?|your)\s+(?:personality(?:['’][a-zçğıöşü]+)?\b|kişili(?:ğ|g)(?:in|i)?|character(?:['’][a-zçğıöşü]+)?\b|vibe\b|tone\b|üslup\b|uslup\b)\s*(?:should\s+be|be|olsun|ol(?:acak|sun)?|:|-)?\s*(.+)$/iu,
  /(?:personality(?:['’][a-zçğıöşü]+)?\b|kişili(?:ğ|g)(?:in|i)?|character(?:['’][a-zçğıöşü]+)?\b|vibe\b|tone\b|üslup\b|uslup\b)\s*(?:should\s+be|be|olsun|ol(?:acak|sun)?|:|-)?\s*(.+)$/iu,
] as const;
const RESPONSE_FORMAT_CUSTOM_RE =
  /(?:(?:şu|su|this|following)\s+format(?:ta)?(?:\s+(?:cevap\s+ver|reply|respond))?|(?:cevap|yanıt|reply|respond)(?:ların|ler?n)?\s*(?:şöyle|like\s+this|in\s+this\s+format))(?:\s+ol(?:sun|malı|acak))?\s*[:\-]?\s*(.+)$/iu;
const PROVIDER_REASONING_BLOCK_RE =
  /(?:<reasoning>|<think>)\s*[\r\n][\s\S]*?[\r\n]\s*(?:<\/reasoning>|<\/think>)\s*(?:[\r\n]+)?/giu;
// Natural-language autonomy turns write confirmations off for 24 h and is
// stored in the profile, so it must come from an instruction, not a mention.
// Measured 2026-10-11: "How does autonomous mode work?", "Make the enemy AI
// autonomous so it can work without the player" and "Otonom mod aktif mi?"
// each enabled it — any autonomy word anywhere before "work"/"aktif" counted —
// while "otonom modu aç" did not, because \b is ASCII-only and never closes a
// word after "ç".
//
// A whole sentence must be the directive: a command verb and its target, with
// only courtesy words before ("please", "lütfen", "bu görev için") and only
// scope words after ("for this task", "now"). Anything else — a game target
// ("for the enemy AI", "Düşman yapay zekası için"), a condition ("when the
// target is lost", "Butona basınca"), a negation ("açma", "don't"), a question
// mark or a quote — makes it a feature request or a remark, and only the bare
// imperative counts ("çalışsın"/"çalışan" describe a game object). And
// "autonomous mode" / "otonom mod" is an everyday game-feature name and
// "continue without waiting for confirmation" an everyday purchase-flow spec,
// so those forms only count as the message's opening sentence ("Add a drone.
// Switch to autonomous mode." specifies the drone). So does a grant with no
// addressee: "Add a drone. Enable full autonomy." and "Admin rolünü ekledim.
// Tam yetki verdim." describe the drone and the role. Only a grant addressed
// to the assistant ("you have full autonomy", "sana tam yetki veriyorum",
// "tam yetkilisin", the imperative "tam yetkiyle ilerle") counts as any
// sentence, as it closes a settings message ("My name is Okan. ... I give you
// full autonomy.").
const AUTONOMY_LEAD_SRC = String.raw`(?:please|pls|ok(?:ay)?|alright|yes|hi|hello|hey|now|so|just|also|go\s+ahead\s+and|i\s+want\s+you\s+to|from\s+now\s+on|for\s+(?:this|the\s+rest\s+of\s+(?:this|the))\s+(?:task|session|conversation|chat|project)|l[üu]tfen|art[ıi]k|bundan\s+sonra|[şs]imdi|hemen|tamam|peki|evet|hadi|merhaba|selam|bu\s+(?:(?:g[öo]rev|i[şs]|oturum|konu[şs]ma|proje)\s+i[çc]in|g[öo]revde|oturumda|konu[şs]mada|projede))`;
const AUTONOMY_TAIL_SRC = String.raw`(?:please|now|right\s+now|from\s+now\s+on|for\s+(?:this|the\s+rest\s+of\s+(?:this|the))\s+(?:task|session|conversation|chat|project)|l[üu]tfen|art[ıi]k|hemen|[şs]imdi|bundan\s+sonra|bu\s+(?:g[öo]rev|i[şs]|oturum|konu[şs]ma|proje)\s+i[çc]in)`;
const AUTONOMY_JOIN_SRC = String.raw`(?:\s*,\s*|\s+)(?:and\s+then|and|then|ve|sonra|ard[ıi]ndan)\s+|\s*,\s*`;
const AUTONOMY_GRANT_SRC = String.raw`(?:you\s+have|i\s+give\s+you|i\s+grant\s+you)\s+full\s+(?:autonomy|authority)|sana\s+tam\s+yetki\s+ver(?:iyorum|dim)|tam\s+yetkilisin|tam\s+yetkiyle\s+(?:ilerle(?:yin)?|devam\s+(?:et|edin)|[çc]al[ıi][şs](?:[ıi]n)?)`;
const AUTONOMY_MODE_SRC = String.raw`(?:enable|activate|turn\s+on|switch\s+to|use|take)\s+full\s+(?:autonomy|authority)|tam\s+yetki\s+ver(?:iyorum|dim)|(?:enable|activate|turn\s+on|switch\s+on|switch\s+to|go\s+into|enter|use|start)\s+(?:the\s+)?(?:autonomous\s+mode|autonomy(?:\s+mode)?)|(?:turn|switch)\s+(?:the\s+)?autonomous\s+mode\s+on|go\s+(?:fully\s+)?autonomous|(?:work|proceed|continue)\s+(?:fully\s+)?autonomously|(?:otonom|autonom)(?:\s+(?:mod(?:u|unu|una|a|da|unda)?|olarak))?\s+(?:a[çc](?:[ıi]n)?|aktif\s+(?:et|edin)|aktifle[şs]tir(?:in)?|etkinle[şs]tir(?:in)?|ba[şs]lat(?:[ıi]n)?|ge[çc](?:in|elim)?|[çc]al[ıi][şs](?:[ıi]n|al[ıi]m|abilirsin(?:iz)?)?|ilerle(?:yin|yelim|yebilirsin(?:iz)?)?|devam\s+(?:et|edin))|(?:otonom|autonom)\s+mod(?:u|unu)?\s+(?:aktif|etkin|a[çc][ıi]k)\s+olsun|(?:proceed|continue|keep\s+going|go\s+ahead)\s+without\s+(?:asking(?:\s+me)?\s+for|waiting\s+for)\s+(?:approval|confirmation|permission)|(?:onay|approval|izin)\s+(?:sormadan|istemeden|beklemeden)\s+(?:ilerle(?:yin)?|devam\s+(?:et|edin)|[çc]al[ıi][şs](?:[ıi]n)?)`;
const autonomySentenceRe = (directive: string): RegExp => {
  const segment = String.raw`(?:${AUTONOMY_LEAD_SRC}[\s,]+)*(?:${directive})(?:,?\s+${AUTONOMY_TAIL_SRC})*`;
  return new RegExp(String.raw`^${segment}(?:(?:${AUTONOMY_JOIN_SRC})${segment})*$`, "iu");
};
const AUTONOMY_OPENING_SENTENCE_RE = autonomySentenceRe(`${AUTONOMY_GRANT_SRC}|${AUTONOMY_MODE_SRC}`);
const AUTONOMY_GRANT_SENTENCE_RE = autonomySentenceRe(AUTONOMY_GRANT_SRC);
// "Hi!" or "Tamam." before the directive does not move it off the opening.
const AUTONOMY_LEAD_ONLY_RE = new RegExp(String.raw`^${AUTONOMY_LEAD_SRC}(?:[\s,]+${AUTONOMY_LEAD_SRC})*$`, "iu");
// The directive is one short sentence. The anchored patterns backtrack
// quadratically on long comma/space runs (a 64 KB pasted sentence took ~2 s),
// so longer sentences are never directives and are not matched at all.
const AUTONOMY_SENTENCE_MAX_CHARS = 200;
const AUTONOMY_DISABLE_RE =
  /(?:\b(?:autonom|otonom|autonomous)\b.*\b(?:kapat|kapa|disable|turn\s+off|devre\s+dışı|devre\s+disi|çalışma|calisma)\b|\b(?:onay|approval)\b.*\b(?:sor|iste|ask\s+first|require)\b)/iu;
const ULTRATHINK_ENABLE_RE =
  /(?:\bultrathink\b|\bultra\s+think\b|\bdeep(?:er)?\s+think(?:ing)?\b|\bderin\s+düş(?:ün|un)\b|\bçok\s+derin\s+düş(?:ün|un)\b)/iu;
const ULTRATHINK_DISABLE_RE =
  /(?:\bultrathink\b|\bultra\s+think\b).*\b(?:kapat|kapa|disable|turn\s+off|off|devre\s+dışı|devre\s+disi)\b/iu;
const EXACT_RESPONSE_LITERAL_PATTERNS = [
  /\b(?:say|write|reply|respond|answer|output)\s+exactly\s*[:\-]\s*["“]?([^"\n]+?)["”]?\s*$/iu,
  /\b(?:reply|respond|answer|output|write)\s+(?:with\s+)?only\s*[:\-]\s*["“]?([^"\n]+?)["”]?\s*$/iu,
  /\b(?:yalnızca|yalnizca|sadece)\s*[:\-]\s*["“]?([^"\n]+?)["”]?\s*(?:yaz|söyle|soyle|cevap\s+ver|yanıtla)?\s*$/iu,
] as const;

export const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: "English",
  tr: "Turkish",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  de: "German",
  es: "Spanish",
  fr: "French",
};

export interface NaturalLanguageDirectiveUpdates {
  language?: string;
  displayName?: string;
  activePersona?: string;
  preferences?: Record<string, unknown>;
  autonomousMode?: {
    enabled: boolean;
    expiresAt?: number;
  };
}

interface NaturalLanguageDirectiveProfile {
  displayName?: string;
  preferences: Record<string, unknown>;
}

/** Strip markdown control characters from user-supplied display names. */
export function sanitizeDisplayName(raw: string): string {
  return raw.replace(/[*[\]()#`>!\\<&\r\n]/g, "").trim();
}

export function sanitizePreferenceText(raw: string, maxLength = 160): string {
  return redactSensitiveText(raw)
    .replace(/[*[\]()#`>!\\<&]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function trimDirectiveTail(raw: string): string {
  const firstLine = raw.split(/[\r\n]/u, 1)[0] ?? "";
  const firstSentence = firstLine.split(/[.!?]/u, 1)[0] ?? firstLine;
  const firstClause = firstSentence.split(/\s+(?:ve|and|ama|but|lütfen|please|çünkü|because)\b/iu, 1)[0] ?? firstSentence;
  return firstClause
    .replace(/["“”'`]+/g, "")
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\b(?:olsun|olacak|be|is)\s*$/iu, "")
    .replace(/\b(?:gibi|like)\s*$/iu, "")
    .trim();
}

function extractDirectivePreference(
  text: string,
  patterns: readonly RegExp[],
  maxLength = 160,
): string | undefined {
  for (const segment of buildDirectiveSegments(text)) {
    for (const pattern of patterns) {
      const captured = segment.match(pattern)?.[1];
      if (!captured) {
        continue;
      }
      const trimmed = sanitizePreferenceText(trimDirectiveTail(captured), maxLength);
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function buildDirectiveSegments(text: string): string[] {
  return [
    text,
    ...text
      .split(/[\r\n.!?]+/u)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0),
  ];
}

export function extractExactResponseLiteral(prompt: string): string | undefined {
  for (const pattern of EXACT_RESPONSE_LITERAL_PATTERNS) {
    const captured = prompt.match(pattern)?.[1];
    if (!captured) {
      continue;
    }
    const literal = sanitizePreferenceText(captured, 120)
      .replace(/^["“”'`]+|["“”'`]+$/g, "")
      .trim();
    if (literal.length > 0) {
      return literal;
    }
  }
  return undefined;
}

export function buildExactResponseDirective(prompt: string): string {
  const literal = extractExactResponseLiteral(prompt);
  if (!literal) {
    return "";
  }
  return [
    "",
    "## STRICT RESPONSE CONTRACT",
    `The user requested an exact output literal: "${literal}"`,
    "- The visible final answer must be exactly that literal.",
    "- Do not add extra words, quotes, markdown, prefixes, suffixes, or explanations.",
    "",
  ].join("\n");
}

export function stripVisibleProviderArtifacts(responseText: string): string {
  return responseText.replace(PROVIDER_REASONING_BLOCK_RE, "").trim();
}

export function applyVisibleResponseContract(prompt: string, responseText: string): string {
  const literal = extractExactResponseLiteral(prompt);
  return literal ?? stripVisibleProviderArtifacts(responseText);
}

export function getStringPreference(
  preferences: Record<string, unknown>,
  key: string,
  maxLength = 160,
): string | undefined {
  const value = preferences[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const sanitized = sanitizePreferenceText(value, maxLength);
  return sanitized.length > 0 ? sanitized : undefined;
}

export function getBooleanPreference(preferences: Record<string, unknown>, key: string): boolean | undefined {
  const value = preferences[key];
  return typeof value === "boolean" ? value : undefined;
}

export function resolveConversationScope(chatId: string, conversationId?: string): string {
  const normalizedConversationId = conversationId?.trim();
  return normalizedConversationId ? normalizedConversationId : chatId;
}

/**
 * The person a chat's stored conversation belongs to (memory-user-scope), or
 * undefined when it belongs to the chat alone. The web channel names each
 * conversation after the browser's profile (conversationId === userId) while
 * every connection gets a fresh chatId, so a summary owned by the chat alone
 * was lost to its person on reconnect. Only a conversation the channel keyed to
 * the person is theirs; a group or thread conversation stays its chat's, so it
 * never follows one member into another chat.
 */
export function resolveConversationOwner(userId?: string, conversationId?: string): string | undefined {
  const speakerId = userId?.trim();
  return speakerId && conversationId?.trim() === speakerId ? speakerId : undefined;
}

interface IdentityLinkResolver {
  resolveLinkedIdentity: (channelType: string, channelUserId: string) => string | null;
}

export function resolveIdentityKey(
  chatId: string,
  userId?: string,
  conversationId?: string,
  profileStore?: IdentityLinkResolver,
  channelType?: string,
): string {
  // Try cross-channel identity resolution first
  if (profileStore && channelType && userId) {
    const unified = profileStore.resolveLinkedIdentity(channelType, userId);
    if (unified) return unified;
  }
  const normalizedUserId = userId?.trim();
  if (normalizedUserId) return normalizedUserId;
  return resolveConversationScope(chatId, conversationId);
}

export function detectVerbosityPreference(text: string): string | undefined {
  const responseIntent = /\b(cevap|yanıt|yaz|reply|respond|answer|açıkla|acikla|anlat|explain)\b/iu.test(text);
  if (/\b(kısa|kisa|brief|concise|short)\b/iu.test(text) && /\b(cevap|yanıt|yaz|reply|respond|answer|açıkla|acikla)\b/iu.test(text)) {
    return "brief";
  }
  if (responseIntent && /\b(detaylı|detayli|ayrıntılı|ayrintili|thorough|detailed|long-form|deep-dive)\b/iu.test(text)) {
    return "detailed";
  }
  if (responseIntent && /\b(orta|normal|balanced|moderate)\b/iu.test(text)) {
    return "moderate";
  }
  return undefined;
}

export function detectCommunicationStylePreference(text: string): string | undefined {
  const styleIntent = /\b(cevap|yanıt|reply|respond|answer|üslup|uslup|ton|tone|style)\b/iu.test(text);
  if (!styleIntent) return undefined;
  if (/\b(resmi|formal)\b/iu.test(text)) return "formal";
  if (/\b(samimi|gündelik|gundelik|casual|friendly)\b/iu.test(text)) return "casual";
  if (/\b(minimal|yalın|yalin|plain|minimalist)\b/iu.test(text)) return "minimal";
  return undefined;
}

export function detectResponseFormatPreference(text: string): { format?: string; instruction?: string } {
  const customMatch = text.match(RESPONSE_FORMAT_CUSTOM_RE);
  const instruction = customMatch?.[1]
    ? sanitizePreferenceText(customMatch[1].split(/[.!?]/u, 1)[0] ?? customMatch[1], 220)
    : undefined;
  const formatIntent = /\b(cevap|yanıt|reply|respond|answer|format)\b/iu.test(text) || Boolean(instruction);

  if (formatIntent && /\bjson\b/iu.test(text)) {
    return { format: "json", instruction };
  }
  if (formatIntent && /\b(madde\s+madde|bullet\s+points?|bullets?)\b/iu.test(text)) {
    return { format: "bullet points", instruction };
  }
  if (formatIntent && /\b(tablo|table)\b/iu.test(text)) {
    return { format: "table", instruction };
  }
  if (formatIntent && /\b(tek\s+paragraf|single\s+paragraph)\b/iu.test(text)) {
    return { format: "single paragraph", instruction };
  }

  if (instruction) {
    return { instruction };
  }

  return {};
}

export function detectAssistantPersonaPreference(text: string): string | undefined {
  for (const segment of buildDirectiveSegments(text)) {
    const candidate = extractDirectivePreference(segment, ASSISTANT_PERSONA_PATTERNS, 120);
    if (!candidate) {
      continue;
    }
    if (/^(?:formal|casual|minimal|default|brief|detailed|moderate|use|kullan|switch|activate|set|geç|gec|dön|don)$/iu.test(candidate)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

export function detectAssistantPersonalityPreference(text: string): string | undefined {
  for (const segment of buildDirectiveSegments(text)) {
    const candidate = extractDirectivePreference(segment, ASSISTANT_PERSONALITY_PATTERNS, 180);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

// A persona switch is `/persona switch`, which the owner rule refuses a guest,
// so like an autonomy directive it must be a whole sentence: a switch verb and
// the persona, with only courtesy words before and scope words after. Any
// sentence holding a persona name within 40 characters of "use", "set",
// "mode" or "profile" used to count, and the built-in names are everyday
// words: "Use the default settings for the build.", "Set the default
// resolution to 1080p." and "Add a casual mode for new players." each
// switched the persona, or drew "Refused" for a guest.
const PERSONA_NOUN_SRC = String.raw`(?:persona|personality|profile)`;
const PERSONA_ARTICLE_SRC = String.raw`(?:(?:the|your|my|a)\s+)?`;
const PERSONA_TR_VERB_SRC = String.raw`(?:geri\s+)?(?:kullan(?:[ıi]n|al[ıi]m)?|ge[çc](?:in|elim)?|se[çc](?:in)?|d[öo]n(?:[üu]n|elim)?|aktif\s+et(?:in)?|etkinle[şs]tir(?:in)?)`;
const personaSwitchSentenceRe = (persona: string): RegExp => {
  const name = escapeRegExp(persona);
  return autonomySentenceRe([
    // "Switch to casual mode", "Go back to default"
    String.raw`(?:switch|change|go|revert|return)\s+(?:back\s+)?to\s+${PERSONA_ARTICLE_SRC}${name}(?:\s+(?:${PERSONA_NOUN_SRC}|mode))?`,
    // "Use the formal persona"
    String.raw`(?:use|activate|enable|select|choose|pick|apply|load|adopt)\s+${PERSONA_ARTICLE_SRC}${name}\s+${PERSONA_NOUN_SRC}`,
    // "Set your persona to minimal"
    String.raw`(?:set|change|switch)\s+${PERSONA_ARTICLE_SRC}${PERSONA_NOUN_SRC}\s+to\s+${PERSONA_ARTICLE_SRC}${name}`,
    // "Formal persona kullan", "Casual moda geç"
    String.raw`${name}\s+(?:persona|profil|mod)[\p{L}'’]*\s+${PERSONA_TR_VERB_SRC}`,
  ].join("|"));
};

export function detectActivePersonaPreference(
  text: string,
  availablePersonas: string[] = [],
): string | undefined {
  const uniquePersonas = Array.from(new Set(
    availablePersonas
      .map((persona) => persona.trim())
      .filter((persona) => /^[a-z0-9_-]{1,40}$/i.test(persona)),
  ));
  if (uniquePersonas.length === 0) {
    return undefined;
  }

  // "İ" has no simple case folding, so /i never matches it to "i".
  const normalized = text.normalize("NFC").replace(/İ/gu, "i");
  const lowered = normalized.toLowerCase();
  const sentences = (normalized.match(/[^.!?\n]+[.!?]*/gu) ?? [])
    .filter((sentence) => sentence.length <= AUTONOMY_SENTENCE_MAX_CHARS)
    // A trailing "?" stays and fails the match: a question never switches.
    .map((sentence) => sentence.trim().replace(/[\s.!…]+$/u, ""));
  const ordered = [...uniquePersonas].sort((left, right) => right.length - left.length);
  for (const persona of ordered) {
    if (!lowered.includes(persona.toLowerCase())) {
      continue;
    }
    const directiveRe = personaSwitchSentenceRe(persona);
    if (sentences.some((sentence) => directiveRe.test(sentence))) {
      return persona;
    }
  }

  return undefined;
}

/** Build a list of profile attribute lines for system prompt injection. */
export function buildProfileParts(profile: {
  displayName?: string;
  language: string;
  activePersona: string;
  preferences: unknown;
}): string[] {
  const parts: string[] = [];
  const preferences = profile.preferences as Record<string, unknown>;
  if (profile.displayName) parts.push(`Name: ${profile.displayName}`);
  parts.push(`Language: ${profile.language}`);
  if (profile.activePersona !== "default") parts.push(`Active Persona Profile: ${profile.activePersona}`);
  const assistantName = getStringPreference(preferences, "assistantName", 80);
  if (assistantName) parts.push(`Assistant Identity: When referring to yourself, use the name "${assistantName}".`);
  const assistantPersona = getStringPreference(preferences, "assistantPersona", 120);
  if (assistantPersona) parts.push(`Assistant Persona Preference: ${assistantPersona}`);
  const assistantPersonality = getStringPreference(preferences, "assistantPersonality", 180);
  if (assistantPersonality) parts.push(`Assistant Personality Preference: ${assistantPersonality}`);
  const communicationStyle = getStringPreference(preferences, "communicationStyle", 60);
  if (communicationStyle) parts.push(`Reply Style: ${communicationStyle}`);
  const verbosity = getStringPreference(preferences, "verbosity", 40);
  if (verbosity) parts.push(`Detail Level: ${verbosity}`);
  const responseFormat = getStringPreference(preferences, "responseFormat", 80);
  if (responseFormat) parts.push(`Response Format Preference: ${responseFormat}`);
  const responseFormatInstruction = getStringPreference(preferences, "responseFormatInstruction", 220);
  if (responseFormatInstruction) parts.push(`Response Format Instruction: ${responseFormatInstruction}`);
  if (getBooleanPreference(preferences, "ultrathinkMode") === true) {
    parts.push("Reasoning Mode: Use extra-careful, multi-step internal reasoning before answering.");
  }
  return parts;
}

function isAutonomyEnableDirective(text: string): boolean {
  // "İ" has no simple case folding, so /i never matches it to "i".
  const normalized = text.normalize("NFC").replace(/İ/gu, "i");
  let opening = true;
  for (const rawSentence of normalized.match(/[^.!?\n]+[.!?]*/gu) ?? []) {
    if (rawSentence.length > AUTONOMY_SENTENCE_MAX_CHARS) {
      opening = false;
      continue;
    }
    // A trailing "?" stays and fails the match: a question never counts.
    const sentence = rawSentence.trim().replace(/[\s.!…]+$/u, "");
    const directiveRe = opening ? AUTONOMY_OPENING_SENTENCE_RE : AUTONOMY_GRANT_SENTENCE_RE;
    if (directiveRe.test(sentence)) return true;
    if (!AUTONOMY_LEAD_ONLY_RE.test(sentence)) opening = false;
  }
  return false;
}

// ASCII-typed Turkish carries no special letters, so its common words count.
const LANGUAGE_FUNCTION_WORDS = new Map<string, string>([
  ...[
    "merhaba", "selam", "nasıl", "nasil", "proje", "yardım", "yardim", "bir", "ile", "için", "icin",
    "bu", "şu", "ve", "gibi", "daha", "çok", "cok", "şimdi", "simdi", "sonra", "lütfen", "lutfen",
    "tamam", "evet", "hayır", "hayir", "değil", "degil", "olarak", "nedir", "neden", "artık", "artik",
    "misin", "mısın", "musun", "müsün",
  ].map((word) => [word, "tr"] as const),
  ...["hallo", "projekt", "hilfe"].map((word) => [word, "de"] as const),
  ...["hola", "proyecto", "ayuda"].map((word) => [word, "es"] as const),
  ...["bonjour", "projet", "aide"].map((word) => [word, "fr"] as const),
]);
const LANGUAGE_SKIPPED_SPAN_RE = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/gu;
const CJK_RUN_RE = /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]+/gu;
const LANGUAGE_WORD_RE = /[¡¿]?\p{L}+(?:['’]\p{L}+)*/gu;

/**
 * Heuristic language detection from text content; null means "no evidence".
 *
 * The result is written into the user's profile and English is never
 * detected, so a false hit sticks. Measured 2026-10-11: one character used to
 * decide — "Make a Pokémon-style battle system" read as French, "Rename the
 * Müller NPC" as Turkish, "Add a button labeled 決定" as Japanese — and asset
 * names and localized strings are everyday text in a game project. A language
 * now has to carry a third of the words, by a unique letter or word or by two
 * shared ones; ç/ö/ü are shared by Turkish, German and French, so they never
 * decide alone. Code and double-quoted spans are skipped; single quotes are
 * Turkish suffix apostrophes ("Unity'de").
 */
export function detectLanguageFromText(text: string): string | null {
  const scanned = text.normalize("NFC").replace(LANGUAGE_SKIPPED_SPAN_RE, " ");
  const strong = new Map<string, number>();
  const weak = new Map<string, number>();
  const add = (counts: Map<string, number>, lang: string, by = 1) => counts.set(lang, (counts.get(lang) ?? 0) + by);
  let units = 0;

  // CJK has no spaces between words; two characters stand in for one word.
  for (const run of scanned.match(CJK_RUN_RE) ?? []) {
    const runUnits = Math.ceil(run.length / 2);
    units += runUnits;
    add(strong, /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/u.test(run) ? "ja" : /[\uAC00-\uD7AF]/u.test(run) ? "ko" : "zh", runUnits);
  }
  for (const word of scanned.replace(CJK_RUN_RE, " ").match(LANGUAGE_WORD_RE) ?? []) {
    units += 1;
    // "İ".toLowerCase() leaves a combining dot that no list entry carries.
    const lower = word.toLowerCase().replace(/\u0307/gu, "");
    const functionWordLang = LANGUAGE_FUNCTION_WORDS.get(lower.replace(/^[¡¿]/u, ""));
    if (functionWordLang) add(strong, functionWordLang);
    else if (/[ğışĞİŞ]/u.test(word)) add(strong, "tr");
    else if (/[äß]/u.test(lower)) add(strong, "de");
    else if (/[ñ¡¿]/u.test(lower)) add(strong, "es");
    else {
      if (/[çöü]/u.test(lower)) add(weak, "tr");
      if (/[öü]/u.test(lower)) add(weak, "de");
      if (/[àâæçéèêëïîôœùûüÿ]/u.test(lower)) add(weak, "fr");
      if (/[áíóú]/u.test(lower)) add(weak, "es");
    }
  }

  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const lang of new Set([...strong.keys(), ...weak.keys()])) {
    const score = (strong.get(lang) ?? 0) + (weak.get(lang) ?? 0);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  if (!best || tied || bestScore * 3 < units) return null;
  if (!strong.has(best) && bestScore < 2) return null;
  return best;
}

export function extractNaturalLanguageDirectiveUpdates(params: {
  latestProfile: NaturalLanguageDirectiveProfile | null;
  prompt: string;
  availablePersonas?: string[];
  nowMs?: number;
  autonomousHours?: number;
}): NaturalLanguageDirectiveUpdates {
  const updates: NaturalLanguageDirectiveUpdates = {};
  const trimmed = params.prompt.trim();
  const autonomyWindowMs = (params.autonomousHours ?? NATURAL_LANGUAGE_AUTONOMOUS_HOURS) * 3600_000;

  const langFromMsg = detectLanguageFromText(params.prompt);
  if (langFromMsg) {
    updates.language = langFromMsg;
  }

  const isSingleWord = trimmed.split(/\s+/).length <= 2 && /^[\p{L}]{2,20}$/u.test(trimmed);
  const nameMatch = trimmed.match(EXPLICIT_USER_NAME_RE)
    ?? trimmed.match(USER_ADDRESS_NAME_RE)
    ?? trimmed.match(NAME_INTRO_RE)
    ?? (isSingleWord ? [, trimmed] : null);
  const displayName = nameMatch?.[1] ? sanitizeDisplayName(trimDirectiveTail(nameMatch[1])) : "";
  if (displayName && (!params.latestProfile?.displayName || trimmed.match(EXPLICIT_USER_NAME_RE))) {
    updates.displayName = displayName;
  }

  const preferenceUpdates: Record<string, unknown> = {};

  const assistantNameMatch = trimmed.match(ASSISTANT_NAME_RE)
    ?? trimmed.match(ASSISTANT_CALL_NAME_RE);
  const assistantName = assistantNameMatch?.[1]
    ? sanitizeDisplayName(trimDirectiveTail(assistantNameMatch[1])).slice(0, 40)
    : "";
  if (assistantName) {
    preferenceUpdates.assistantName = assistantName;
  }

  const assistantPersona = detectAssistantPersonaPreference(trimmed);
  if (assistantPersona) {
    preferenceUpdates.assistantPersona = assistantPersona;
  }

  const assistantPersonality = detectAssistantPersonalityPreference(trimmed);
  if (assistantPersonality) {
    preferenceUpdates.assistantPersonality = assistantPersonality;
  }

  const verbosity = detectVerbosityPreference(trimmed);
  if (verbosity) {
    preferenceUpdates.verbosity = verbosity;
  }

  const communicationStyle = detectCommunicationStylePreference(trimmed);
  if (communicationStyle) {
    preferenceUpdates.communicationStyle = communicationStyle;
  }

  const responseFormat = detectResponseFormatPreference(trimmed);
  if (responseFormat.format) {
    preferenceUpdates.responseFormat = responseFormat.format;
  }
  if (responseFormat.instruction) {
    preferenceUpdates.responseFormatInstruction = responseFormat.instruction;
  }

  if (ULTRATHINK_DISABLE_RE.test(trimmed)) {
    preferenceUpdates.ultrathinkMode = false;
  } else if (ULTRATHINK_ENABLE_RE.test(trimmed)) {
    preferenceUpdates.ultrathinkMode = true;
  }

  const fromNowOnMatch = trimmed.match(/(?:bundan\s+sonra|from\s+now\s+on|her\s+zaman|always)\s+(.+)$/iu);
  const directiveTail = fromNowOnMatch?.[1]
    ? sanitizePreferenceText(fromNowOnMatch[1].split(/[.!?]/u, 1)[0] ?? fromNowOnMatch[1], 220)
    : undefined;
  if (!responseFormat.instruction && directiveTail && /\b(cevap|yanıt|reply|respond|format|style|üslup|uslup|ton|tone|json|bullet|madde|tablo|table)\b/iu.test(directiveTail)) {
    preferenceUpdates.responseFormatInstruction = directiveTail;
  }

  if (AUTONOMY_DISABLE_RE.test(trimmed)) {
    updates.autonomousMode = { enabled: false };
  } else if (isAutonomyEnableDirective(trimmed)) {
    updates.autonomousMode = {
      enabled: true,
      expiresAt: (params.nowMs ?? Date.now()) + autonomyWindowMs,
    };
  }

  const activePersona = detectActivePersonaPreference(trimmed, params.availablePersonas);
  if (activePersona) {
    updates.activePersona = activePersona;
  }

  if (Object.keys(preferenceUpdates).length > 0) {
    updates.preferences = {
      ...(params.latestProfile?.preferences ?? {}),
      ...preferenceUpdates,
    };
  }

  return updates;
}
