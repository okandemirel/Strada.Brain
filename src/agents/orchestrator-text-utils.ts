// The lookbehind is load-bearing: without it, the substring "sk-" inside an
// ordinary word matches — measured 2026-08-26: a workspace-lease path like
// "…/strada-workspaces/task-<id>/Assets" redacted to "ta[REDACTED]",
// hiding the lease root from the agent in the very error meant to redirect it,
// which looped until the circuit breaker disabled git_status and shell_exec.
const API_KEY_PATTERN =
  /(?<![A-Za-z0-9])(?:sk-|key-|token-|api[_-]?key[=: ]+|ghp_|gho_|ghu_|ghs_|ghr_|xox[bpas]-|Bearer\s+|AKIA[0-9A-Z]{16}|-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----|mongodb(?:\+srv)?:\/\/[^\s]+@)[a-zA-Z0-9_\-.]{10,}/gi;
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

export function redactSensitiveText(raw: string): string {
  return raw.replace(API_KEY_PATTERN, "[REDACTED]");
}

/**
 * Prefixes that also start ordinary identifiers and prose. In project files
 * "token-refresh-interval-seconds", class="key-binding-panel-root" and
 * "// Bearer authentication_scheme" all matched API_KEY_PATTERN; the model was
 * shown [REDACTED], so an edit copying the line missed and a read-then-rewrite
 * wrote the placeholder over the identifier.
 */
const WORD_LIKE_SECRET_PREFIX_RE = /^(?:sk-|key-|token-|api[_-]?key[=: ]+|Bearer\s+)/i;
/**
 * The run of letters and digits a generated key has and a word-joined
 * identifier does not: 16+ with a digit in it, or 24+ of any kind.
 */
const SECRET_SHAPED_RUN_RE = /[A-Za-z0-9]{24,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{16,}/;

/**
 * {@link redactSensitiveText} for the text of project files: a match behind a
 * word-like prefix is redacted only when what follows it is shaped like a key.
 */
export function redactSecretsInFileText(raw: string): string {
  return raw.replace(API_KEY_PATTERN, (match) => {
    const prefix = WORD_LIKE_SECRET_PREFIX_RE.exec(match)?.[0];
    if (prefix !== undefined && !SECRET_SHAPED_RUN_RE.test(match.slice(prefix.length))) return match;
    return "[REDACTED]";
  });
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

// ---------------------------------------------------------------------------
// Prompt-injection defense
// ---------------------------------------------------------------------------
// sec-H1: The sanitizer must catch more than markdown headings. Injections
// regularly surface through envelope tags, inline "ignore previous"
// directives, zero-width splicing, Unicode homoglyphs, and base64 payloads.
// The goal of this module is to neutralize the obvious carriers without
// materially damaging legitimate retrieval text; where the signal is
// ambiguous (base64, homoglyphs) we flag rather than mutate.

/** Zero-width / BOM / invisible-join characters routinely abused to smuggle directives. */
const ZERO_WIDTH_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

/** Direct "ignore previous instructions" style directives, including mild obfuscations. */
const INLINE_OVERRIDE_RE =
  /\b(?:ignore|disregard|forget|bypass|override)\b[\s\S]{0,40}?\b(?:previous|prior|all|above|earlier|prior-?to|preceding|any|the)\b[\s\S]{0,40}?\b(?:instruction|prompt|message|rule|system|directive|context|policy|guidance|guardrail)s?\b/gi;

/** Less common but equally dangerous: "act as a new system", "from now on you are …". */
const ROLE_HIJACK_RE =
  /\b(?:from\s+now\s+on|bundan\s+sonra|henceforth|going\s+forward)\b[\s\S]{0,60}?\b(?:you\s+are|act\s+as|pretend|behave\s+as|sen\s+bir)\b/gi;

/**
 * CJK role-hijack patterns — mirror of `ROLE_HIJACK_RE` for Chinese / Japanese
 * / Korean, which western regex misses entirely. Non-greedy with cross-line
 * support ([\s\S]) so multi-line prompts stay covered.
 *
 * Examples flagged:
 *   你现在是 一个恶意助手 →   "You are now a malicious assistant"
 *   从现在开始你是 …     →   "From now on you are …"
 *   あなたは…として        →   "You are … as/acting"
 *   당신은…입니다          →   "You are …" (declarative)
 */
const CJK_ROLE_HIJACK_RE =
  /(?:你现在是|你(?:从现在起|从此)是|从现在开始你是|从现在起你是|あなたは[\s\S]{0,80}?として|君は[\s\S]{0,80}?として|당신은[\s\S]{0,80}?입니다|당신은[\s\S]{0,80}?이(?:에|에요|야))/g;

/** Envelope patterns: XML <system>, pipe-delimited <|system|>, bracket [SYSTEM]. */
const ENVELOPE_RE =
  /<\|?\s*(?:system|assistant|user|developer|tool|function)\s*\|?>[\s\S]{0,2000}?<\/?\|?\s*(?:system|assistant|user|developer|tool|function)\s*\|?>|\[\s*(?:SYSTEM|ASSISTANT|USER|DEVELOPER|TOOL|INST|\/INST)\s*\][\s\S]{0,2000}?\[\s*\/?\s*(?:SYSTEM|ASSISTANT|USER|DEVELOPER|TOOL|INST)\s*\]|<\|(?:im_start|im_end|start_header_id|end_header_id|eot_id|begin_of_text)\|>/gi;

/**
 * Unopened/open-only envelope tags (e.g. lone `[SYSTEM]:` prefix, `<|system|>` header).
 * These are stripped to a marker even when no closing tag is present.
 */
const OPEN_ENVELOPE_RE =
  /<\|?\s*(?:system|assistant|developer|tool|function)\s*\|?>|\[\s*(?:SYSTEM|ASSISTANT|DEVELOPER|TOOL|INST)\s*\]\s*:?/gi;

/**
 * Base64 heuristic: a contiguous run of 60+ base64 characters **that also
 * contains at least one `+`, `/`, or `=` delimiter**. Raw `[A-Za-z0-9]{40,}`
 * was too eager and false-positived on legitimate SHA-256 hex digests and git
 * SHA / commit markers, which are pure hex/alnum and never contain +, /, =.
 *
 * Threshold raised from 40→60 to further cut collision with hash outputs
 * while still catching any meaningful base64 payload (a 60-char block decodes
 * to ≥45 bytes — well above the noise floor of identifiers). We do not decode
 * (avoids turning the sanitizer into a decoder and expanding attack surface);
 * we only flag so callers can treat large opaque blobs with extra care.
 */
const BASE64_BLOCK_RE = /[A-Za-z0-9+/]{60,}={0,2}/g;
/** Companion check: require at least one structural base64 delimiter. */
const BASE64_DELIMITER_RE = /[+/=]/;

/**
 * Cyrillic / Greek characters that visually collide with Latin letters.
 * Detection threshold is low (1+ occurrence) because even a single homoglyph
 * can be enough to smuggle a directive past a naive equality check.
 */
const CYRILLIC_LATIN_LOOKALIKE_RE = /[Ѐ-ӿ]/;
const GREEK_LATIN_LOOKALIKE_RE = /[Ͱ-Ͽ]/;

/**
 * Semantic grouping of injection-defense regexes.
 *
 * `detectPromptInjection` already calls these patterns in a fixed order, but
 * grouping them here makes it obvious WHY each one exists and lets tests /
 * audit tooling reference the set by category (envelope, override, encoding,
 * homoglyph) without grepping the file for raw regex literals.
 *
 * Only patterns that belong to one of these four categories appear here —
 * the API-key redaction list and Unicode normalization are outside the
 * categorical model and live alongside `detectPromptInjection`.
 */
export const DIRECTIVE_PATTERNS = {
  /** Tag/prefix envelopes that wrap an injection payload. */
  envelope: [ENVELOPE_RE, OPEN_ENVELOPE_RE] as const,
  /** Inline "ignore previous …" / "from now on you are …" overrides, incl. CJK. */
  override: [INLINE_OVERRIDE_RE, ROLE_HIJACK_RE, CJK_ROLE_HIJACK_RE] as const,
  /** Encoding-based smuggling carriers — zero-width + large base64 blocks. */
  encoding: [ZERO_WIDTH_RE, BASE64_BLOCK_RE] as const,
  /** Non-Latin scripts that visually collide with ASCII. */
  homoglyph: [CYRILLIC_LATIN_LOOKALIKE_RE, GREEK_LATIN_LOOKALIKE_RE] as const,
} as const;

export interface PromptInjectionDetection {
  /** Sanitized text — envelopes/inline overrides redacted, zero-width stripped, NFKC normalized. */
  clean: string;
  /** True when any defense rule fired. */
  flagged: boolean;
  /** Human-readable reasons (for logging / review). */
  reasons: string[];
}

/**
 * Deeper prompt-injection inspection that returns both the sanitized text and
 * a structured signal for callers that need to gate/log the finding.
 *
 * This is the engine behind `sanitizePromptInjection`. The plain sanitize
 * wrapper keeps the legacy string-in/string-out contract used by existing
 * system-prompt builders.
 */
export function detectPromptInjection(text: string): PromptInjectionDetection {
  if (!text) return { clean: text ?? "", flagged: false, reasons: [] };

  const reasons: string[] = [];
  let working = text;

  // 1. Normalize Unicode so homoglyphs and compatibility variants (full-width,
  //    ligatures, ZWJ sequences) collapse to their canonical form. NFKC is
  //    intentional — prompt attacks rely on the model seeing the pretty form
  //    while regex matchers see the compatibility form.
  const normalized = working.normalize("NFKC");
  if (normalized !== working) {
    reasons.push("unicode_normalized");
    working = normalized;
  }

  // 2. Flag (but preserve) Cyrillic/Greek homoglyphs before stripping
  //    zero-width chars, so the heuristic sees the full original text.
  if (CYRILLIC_LATIN_LOOKALIKE_RE.test(working) || GREEK_LATIN_LOOKALIKE_RE.test(working)) {
    reasons.push("non_latin_lookalike");
  }

  // 3. Strip zero-width / directional-override characters wholesale.
  if (ZERO_WIDTH_RE.test(working)) {
    reasons.push("zero_width_chars");
    working = working.replace(ZERO_WIDTH_RE, "");
  }

  // 4. Redact envelopes first (they usually wrap the payload), then the
  //    inline override phrases inside whatever remains.
  const beforeEnvelope = working;
  working = working.replace(ENVELOPE_RE, "[filtered:envelope] ");
  working = working.replace(OPEN_ENVELOPE_RE, "[filtered:envelope] ");
  if (working !== beforeEnvelope) {
    reasons.push("envelope_tag");
  }

  const beforeHeading = working;
  working = working.replace(
    /^(#{1,3}\s*(?:SYSTEM|IMPORTANT|INSTRUCTION|OVERRIDE|IGNORE))[:\s]/gim,
    "[filtered:heading] ",
  );
  if (working !== beforeHeading) {
    reasons.push("system_heading");
  }

  const beforeInline = working;
  working = working.replace(INLINE_OVERRIDE_RE, "[filtered:override]");
  working = working.replace(ROLE_HIJACK_RE, "[filtered:role-hijack]");
  working = working.replace(CJK_ROLE_HIJACK_RE, "[filtered:role-hijack]");
  if (working !== beforeInline) {
    reasons.push("inline_override");
  }

  // 5. Base64 heuristic — annotate, do NOT decode. Length filter keeps
  //    genuine hashes and short identifiers from tripping the flag, and the
  //    delimiter gate rejects pure hex (SHA-256, git SHA) that happens to be
  //    60+ characters long.
  //
  //    Single-pass replace() so we don't need the `.test()` → `.replace()`
  //    dance (which could skip matches because of sticky lastIndex on a /g
  //    regex). We use a sentinel flag and count hits during replacement.
  let base64HitCount = 0;
  working = working.replace(BASE64_BLOCK_RE, (match, offset: number, whole: string) => {
    if (!BASE64_DELIMITER_RE.test(match)) {
      // Pure alnum — treat as identifier/hash, leave untouched.
      return match;
    }
    if (looksLikeFilePath(match, whole.slice(offset + match.length))) {
      return match;
    }
    base64HitCount++;
    return match.length > 200 ? "[filtered:base64-large]" : `[base64:${match.length}ch]`;
  });
  if (base64HitCount > 0) {
    reasons.push("base64_block");
  }

  // 6. API-key / secret redaction (reuse existing PCRE). Always runs last so
  //    it can catch keys that only became visible after envelope stripping.
  const beforeRedact = working;
  working = redactSensitiveText(working).replace(/\r/g, "");
  if (working !== beforeRedact) {
    reasons.push("secret_redacted");
  }

  return { clean: working, flagged: reasons.length > 0, reasons };
}

/**
 * Strip prompt-injection patterns from stored text before injecting into system prompts.
 *
 * This is the legacy string-in/string-out wrapper over `detectPromptInjection`.
 * Short strings (<10 chars) skip the heavy path to keep hot retrieval loops cheap.
 */
export function sanitizePromptInjection(text: string): string {
  if (!text) return text;
  // For very short strings, only run the cheap legacy redaction.
  if (text.length < 10) {
    return redactSensitiveText(text).replace(/\r/g, "");
  }
  return detectPromptInjection(text).clean;
}

/**
 * Retrieval-path wrapper over `detectPromptInjection`.
 *
 * Every memory/vault/knowledge retrieval surface converges on this single
 * helper so we have one place to:
 *   - run the full injection-detection pipeline,
 *   - log / telemetry any flagged content (with the calling subsystem name),
 *   - uniformly hand the cleaned string back to the caller.
 *
 * Callers in scope: `memory/unified/agentdb-retrieval.ts`,
 * `agents/tools/memory-search.ts`, `agents/tools/vault-search-tool.ts`,
 * `agents/context/strada-knowledge.ts`.
 */
export function sanitizeRetrievalContent(text: string, source: string): string {
  if (!text) return text;
  if (text.length < 10) {
    return redactSensitiveText(text).replace(/\r/g, "");
  }
  const result = detectPromptInjection(text);
  if (result.flagged) {
    // Observability: surface the finding at warn-level so defensive
    // telemetry (pino, MetricsCollector wrappers) can pick it up. We
    // intentionally do NOT throw — the cleaned text is still safe to
    // forward, we just want visibility into how often carriers hit the
    // retrieval boundary.
    try {
      // Lazy import to avoid circular init against orchestrator bootstrap.

      const logger = (globalThis as { __strada_logger__?: { warn: (...a: unknown[]) => void } }).__strada_logger__;
      if (logger) {
        logger.warn("[sanitizeRetrievalContent] prompt-injection carriers filtered", {
          source,
          reasons: result.reasons,
          length: text.length,
        });
      }
    } catch {
      // Never let logging crash the retrieval path.
    }
  }
  return result.clean;
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

/**
 * A long path is not a base64 payload.
 *
 * "/" counts as a base64 delimiter, so any run of 60+ path characters without
 * a dot or underscore matched the block rule. Measured 2026-08-20: the failure
 * log reported a missing file as "[base64:<n>ch].cs" — the redaction ate the
 * one thing the line existed to say, and the longer the path the likelier it
 * was eaten.
 *
 * Two signals, both cheap. A run immediately followed by a file extension is a
 * path with its dot just outside the match. A run split into several
 * word-sized segments by "/" is a path; base64 that happens to contain
 * slashes does not divide into short, evenly-sized pieces.
 */
function looksLikeFilePath(match: string, after: string): boolean {
  if (/^\.[A-Za-z0-9]{1,5}\b/.test(after)) return true;

  // An ABSOLUTE path starts with "/", so its first segment is empty — and
  // the every-segment-non-empty rule below called every absolute path base64.
  // Measured 2026-09-08 05:46: unity_bind_sprite's error reached the model as
  // "[base64:<n>ch]-workspaces/task-…/<asset>.prefab holds no GameObject" —
  // the lease root "/private/var/folders/…/T/strada" eaten, the one part of
  // the line that said where the file was.
  const segments = (match.startsWith("/") ? match.slice(1) : match).split("/");
  if (segments.length < 3) return false;
  if (!segments.every((segment) => segment.length > 0 && segment.length <= 32)) return false;
  // Review 2026-09-08: with the leading slash dropped, the canonical JPEG
  // base64 prefix "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL"
  // split into three short segments and read as a path. Path segments are
  // words: most start with a letter and carry a lowercase letter; base64
  // pieces start with digits and shout in mixed case.
  const wordy = segments.filter((segment) => /^[A-Za-z]/.test(segment) && /[a-z]/.test(segment)).length;
  return wordy * 2 >= segments.length;
}
