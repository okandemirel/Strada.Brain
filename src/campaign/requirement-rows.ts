/**
 * Requirement rows: the approved GDD read into the rows a milestone is judged
 * on, and each row given to the milestone that owns it (GDD-drift plan W04, M3).
 *
 * In a measured campaign no GDD rule was ever a row the system owned: a
 * labelled rule was "closed" by a worker's prose, a section of tuning
 * constants was never held against anything, and nobody noticed a hole in a
 * numbered series. Everything here is code, not a model:
 *
 *   • extraction reads labelled rules, normative sentences (closed modal
 *     lists in en, tr, de, es and fr), quantities with bounds parsed by code,
 *     screens, outcomes and the delivery-time claims of gdd-claims.ts;
 *   • one model pass may only ADD rows, and only rows that quote the document
 *     verbatim (`proposeRowsAddOnly`);
 *   • ownership follows the planner's `coveredSections` by heading, or the
 *     `§` references of a milestone planned before those existed; a row
 *     nobody claims is queued, never dropped.
 *
 * The text always comes in as an argument, and the campaign helper reads the
 * APPROVED `Campaign.gddText` (frozen at approval) — never the copy on disk,
 * which workers can edit and which `gddTextOf` prefers. Nothing here reads a
 * file or knows a game's names.
 */

import { createHash } from "node:crypto";
import { balancedJsonObjects, splitGddSections } from "./campaign-planner.js";
import { DURATION_LABEL_RE, extractNumericClaims, type NumericClaim } from "./gdd-claims.js";
import {
  headingClaimedBy,
  normalizeHeading,
  parseHeadingLine,
  sectionAsksForWork,
  TRIVIAL_HEADING_RE,
  type HeadingLine,
} from "./gdd-scope.js";
import {
  contentFingerprint,
  contentTokens,
  decodeIdentities,
  identifyRequirements,
} from "./requirement-identity.js";
import type {
  NumberingGap,
  RequirementBounds,
  RequirementKind,
  RequirementLedger,
  RequirementOverflow,
  RequirementRow,
  RowOwnership,
} from "./scope-types.js";
import type { Campaign } from "./types.js";

/** CAMPAIGN_MAX_REQUIREMENT_ROWS's default; the caller passes the configured value. */
export const DEFAULT_MAX_REQUIREMENT_ROWS = 400;
/** One section cannot crowd out the rest of the document. */
export const DEFAULT_ROWS_PER_SECTION = 40;
/** The add-only pass takes at most this many rows from one chunk. */
export const ADD_ONLY_ROWS_PER_CHUNK = 10;
/** A shorter quote names a thing, not a rule ("Main Menu"). */
export const ADD_ONLY_MIN_QUOTE_CHARS = 20;
/** Share of the proposed requirement's content tokens its quote must carry. */
export const ADD_ONLY_MIN_OVERLAP = 0.6;

// =============================================================================
// WORD LISTS (closed, per language)
// =============================================================================

type Language = "en" | "tr" | "de" | "es" | "fr";

/** Function words that say which language a document is written in. */
const STOPWORDS: Record<Language, readonly string[]> = {
  en: ["the", "and", "of", "is", "to", "with", "for"],
  tr: ["ve", "bir", "bu", "ile", "için", "olarak", "her", "da", "de"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "ein", "eine"],
  es: ["el", "los", "las", "que", "del", "con", "una", "por"],
  fr: ["le", "les", "et", "des", "est", "une", "avec", "dans"],
};

/**
 * Obligation words. Applied per language, because a word that obliges in one
 * language is an ordinary word in another ("solo" is "only" in Spanish and a
 * solo event in English; "nie" is "never" in German).
 */
const MODALS: Record<Language, readonly string[]> = {
  en: [
    "must", "mustn't", "shall", "shan't", "never", "always", "only", "at\\s+least", "at\\s+most",
    "no\\s+more\\s+than", "no\\s+(?:less|fewer)\\s+than", "cannot", "can't", "required", "requires?", "mandatory",
  ],
  tr: [
    "asla", "hiçbir\\s+zaman", "her\\s+zaman", "yalnızca", "sadece", "en\\s+az", "en\\s+fazla", "zorunlu\\p{L}*",
    "gerek(?:ir|li\\p{L}*)",
    // -mAlI, with the copula or a person ending: olmalı, gelmeli, yapılmalıdır, olmamalı.
    "\\p{L}{2,}m[ae]l[ıi](?:d[ıi]r|y[ıi]z|s[ıi]n(?:[ıi]z)?)?",
  ],
  de: ["muss", "müssen", "muß", "musst", "darf\\s+nicht", "dürfen\\s+nicht", "soll", "sollen", "nie", "niemals", "immer", "nur", "mindestens", "höchstens", "stets", "erforderlich", "zwingend"],
  es: ["debe", "deben", "deberá", "deberán", "nunca", "jamás", "siempre", "solo", "sólo", "solamente", "únicamente", "al\\s+menos", "como\\s+mínimo", "como\\s+máximo", "obligatori[oa]s?"],
  fr: ["doit", "doivent", "devra", "devront", "jamais", "toujours", "seulement", "uniquement", "au\\s+moins", "au\\s+plus", "obligatoires?"],
};

/** Verbs of player input. A row about one of them is an input row: its check must drive input, not call the code. */
const INPUT_VERBS: Record<Language, readonly string[]> = {
  en: [
    "tap(?:s|ped|ping|pable)?", "click(?:s|ed|ing|able)?", "press(?:es|ed|ing)?", "long-press(?:es|ed|ing)?",
    // "touch" alone is a noun as often as a verb ("touch points", "touch target").
    "swipe[sd]?", "swiping", "drag(?:s|ged|ging)?", "touch(?:es|ed|ing)", "touch\\s+(?:the|a|an|any|anywhere)", "hold\\s+down",
  ],
  tr: ["dokun\\p{L}*", "tıkla\\p{L}*", "bas(?:ar|ın|ılı|ıl|mak)\\p{L}*", "kaydır\\p{L}*", "sürükle\\p{L}*"],
  de: ["tipp\\p{L}*", "klick\\p{L}*", "drück\\p{L}*", "wisch\\p{L}*", "berühr\\p{L}*", "zieh\\p{L}*"],
  es: ["toca\\p{L}*", "toque\\p{L}*", "tocar", "puls\\p{L}*", "presion\\p{L}*", "desliz\\p{L}*", "arrastr\\p{L}*", "clic"],
  fr: ["touche[rsz]?", "touchez", "appui\\p{L}*", "appuy\\p{L}*", "cliqu\\p{L}*", "gliss\\p{L}*"],
};

const PLAYER_WORDS: Record<Language, readonly string[]> = {
  en: ["players?", "player's", "users?", "you", "your"],
  tr: ["oyuncu\\p{L}*", "kullanıcı\\p{L}*"],
  de: ["spieler\\p{L}*", "nutzer\\p{L}*"],
  es: ["jugador\\p{L}*", "usuari[oa]s?"],
  fr: ["joueur\\p{L}*", "utilisateur\\p{L}*"],
};

/** Look and feel with no number: disclosed, never blocks. */
const JUDGEMENT_WORDS: Record<Language, readonly string[]> = {
  en: ["style", "looks?", "feels?", "mood", "tone", "aesthetics?", "palette", "polish(?:ed)?"],
  tr: ["stil\\p{L}*", "görünüm\\p{L}*", "his(?:si)?", "hava(?:sı)?", "ton\\p{L}*", "estetik\\p{L}*", "palet\\p{L}*"],
  de: ["stil", "aussehen", "gefühl", "stimmung", "ton", "ästhetik", "palette"],
  es: ["estilo", "aspecto", "sensación", "ambiente", "tono", "estética", "paleta"],
  fr: ["style", "aspect", "sensation", "ambiance", "ton", "esthétique", "palette"],
};

/** A game outcome and the condition that brings it: the row is a flow. */
const OUTCOMES: Record<Language, readonly string[]> = {
  en: [
    "(?:win|lose|loss|fail(?:ure)?)\\s+(?:condition|state)s?",
    "(?:level|round|match|game|stage|run|puzzle)\\s+(?:is\\s+)?(?:won|lost|failed|completed?|cleared|over)",
    "game\\s+over", "victory", "defeat", "(?:fail|win)\\s+triggers", "(?:player|you)\\s+(?:wins?|loses?|fails?)",
  ],
  tr: ["kazanma\\s+koşulu", "kaybetme\\s+koşulu", "oyun\\s+bit\\p{L}*", "seviye\\s+(?:tamamlan|kazanıl|kaybedil)\\p{L}*", "oyuncu\\s+(?:kazan|kaybed)\\p{L}*"],
  de: ["(?:spiel|level|runde)\\s+(?:ist\\s+)?(?:gewonnen|verloren|vorbei)", "siegbedingung", "niederlage", "sieg"],
  es: ["(?:nivel|partida|juego)\\s+(?:se\\s+)?(?:gana|pierde|termina)", "condición\\s+de\\s+victoria", "derrota", "victoria"],
  fr: ["(?:niveau|partie)\\s+(?:est\\s+)?(?:gagnée?|perdue?|terminée?)", "condition\\s+de\\s+victoire", "défaite", "victoire"],
};
const CONDITIONS: Record<Language, readonly string[]> = {
  en: ["when", "if", "iff", "once", "until", "as\\s+soon\\s+as", "triggers?"],
  tr: ["\\p{L}+[dt][ıiuü]ğ[ıiuü]nda", "eğer", "zaman"],
  de: ["wenn", "sobald", "falls"],
  es: ["cuando", "si"],
  fr: ["quand", "lorsque", "si", "dès\\s+que"],
};

/**
 * Business and process goals: never a rule a test can hold the game to.
 *
 * An excluded row is never checked, so a word that a GAME also uses must not
 * exclude by itself: a team game, a star rating, a frame-time budget, risk
 * cards, currency conversion and a token budget are all the game.
 *
 *   • A row's own TEXT decides only with the metric names, and only for a
 *     row the document did not label: a labelled rule about the retention
 *     of seed tokens between seasons is about the economy, and a BUDGET of
 *     seven grafts per season is a game requirement.
 *   • METRIC and PRODUCTION headings (a KPI section, the roadmap, staffing,
 *     the production schedule — not an element unlock schedule) decide for
 *     every row under them, at any depth.
 *   • Every other business NOUN decides only as the row's own heading, only
 *     when that heading names nothing else ("Team", "Budget", "Risk
 *     Management" — not "Team Size", "Performance Budget" or "Risk Cards"),
 *     and only for a row that does not speak of the player.
 */
const ASPIRATION_TEXT = [
  "kpis?", "dau", "mau", "arpu", "arpdau", "arppu", "ltv", "roas", "cpi", "ecpm", "revenue",
  "d\\d{1,2}\\s+retention", "retention\\s+rate", "conversion\\s+rate", "payer\\s+conversion",
  "gelir\\s+hedef\\p{L}*", "umsatz", "ingresos", "chiffre\\s+d'affaires",
];
const ASPIRATION_PATH = [
  "kpis?", "dau", "mau", "arpu", "arpdau", "arppu", "ltv", "roas", "cpi", "ecpm",
  "d\\d{1,2}\\s+retention", "retention\\s+rate", "conversion\\s+rate", "payer\\s+conversion", "gelir\\s+hedef\\p{L}*",
  "(?:production|release|development|project|delivery)\\s+schedule", "production\\s+scope", "roadmap", "staffing",
  "yol\\s+haritası", "hoja\\s+de\\s+ruta", "feuille\\s+de\\s+route",
];
const ASPIRATION_NOUN = [
  "revenues?", "umsatz", "ingresos", "chiffre\\s+d['\\s]\\s*affaires", "revenus?", "gelir",
  "retention", "conversion", "ratings?", "benchmarks?", "elde\\s+tutma", "dönüşüm", "kundenbindung", "retención", "conversión", "rétention",
  "teams?", "budgets?", "risks?", "zeitplan",
  "ekip", "takım", "bütçe", "riskler", "risiken", "equipo", "presupuesto", "riesgos", "équipe", "risques",
];
/** What may stand beside a business noun in a heading that names only it: "Risk Management", "KPI Hedefleri". */
const ASPIRATION_QUALIFIER = [
  "and", "or", "targets?", "goals?", "objectives?", "plans?", "planning", "estimates?", "mitigations?", "management", "overview", "structure", "schedule", "timeline",
  "ve", "hedef\\p{L}*", "plan(?:ı|lama\\p{L}*)", "önlem\\p{L}*", "yönetim\\p{L}*", "yapı\\p{L}*",
  "und", "ziele?", "maßnahmen", "gegenmaßnahmen", "struktur",
  "y", "objetivos?", "metas?", "planes", "mitigación", "estructura",
  "et", "objectifs?", "atténuation",
];

function wordsRe(words: readonly string[], flags = "iu"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, flags);
}

const ASPIRATION_TEXT_RE = wordsRe(ASPIRATION_TEXT);
const ASPIRATION_PATH_RE = wordsRe(ASPIRATION_PATH);
const ASPIRATION_NAMES_RE = wordsRe([...ASPIRATION_PATH, ...ASPIRATION_NOUN], "giu");
const ASPIRATION_QUALIFIER_RE = wordsRe(ASPIRATION_QUALIFIER, "giu");

/** The business noun a heading names and nothing else beside it; undefined for any other heading. */
function businessSectionName(heading: string): string | undefined {
  const plain = normalizeHeading(heading);
  const named = plain.match(ASPIRATION_NAMES_RE)?.[0];
  if (named === undefined) return undefined;
  const rest = plain.replace(ASPIRATION_NAMES_RE, " ").replace(ASPIRATION_QUALIFIER_RE, " ").trim();
  return rest === "" ? named : undefined;
}

interface Vocabulary {
  readonly modal: RegExp;
  readonly input: RegExp;
  readonly player: RegExp;
  readonly judgement: RegExp;
  readonly outcome: RegExp;
  readonly condition: RegExp;
}

function vocabularyFor(languages: ReadonlySet<Language>): Vocabulary {
  const pick = (table: Record<Language, readonly string[]>): RegExp =>
    wordsRe([...languages].flatMap((l) => table[l]));
  return {
    modal: pick(MODALS),
    input: pick(INPUT_VERBS),
    player: pick(PLAYER_WORDS),
    judgement: pick(JUDGEMENT_WORDS),
    outcome: pick(OUTCOMES),
    condition: pick(CONDITIONS),
  };
}

/**
 * English, plus every language whose function words are at least half as
 * frequent as the most frequent one's. A bilingual document gets both lists;
 * an English one never gets "solo" as a modal.
 */
function languagesOf(text: string): Set<Language> {
  const counts = (Object.keys(STOPWORDS) as Language[]).map((language) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${STOPWORDS[language].join("|")})(?![\\p{L}\\p{N}])`, "giu");
    return [language, [...text.matchAll(re)].length] as const;
  });
  const most = Math.max(...counts.map(([, n]) => n));
  const out = new Set<Language>(["en"]);
  for (const [language, n] of counts) if (n >= 3 && n >= most / 2) out.add(language);
  return out;
}

// =============================================================================
// NUMBERS AND BOUNDS — parsed by code, never written by a model
// =============================================================================

/** "4,500" and "4.500" are thousands; "0.25" and "0,25" are decimals. */
const NUM = String.raw`(?:[1-9]\d{0,2}(?:[.,]\d{3})+(?![.,]?\d)|\d+(?:[.,]\d+)?)`;
/** A number glued to a letter, a section sign, a label dash or a ratio slash is an identifier ("G-01", "§5.2", "L14", "x/12"). */
const NOT_AN_IDENTIFIER = String.raw`(?<![\p{L}\p{N}§#_.,\/×\-–—])`;
/** Units of measure. No bare "m": case-blind, it read "10M+ players" as ten metres. */
const UNIT = String.raw`(?:%|°|×|fps|hz|ms|milliseconds?|millisaniye\p{L}*|secs?|seconds?|saniye\p{L}*|sn|sekunden?|segundos?|secondes?|s|mins?|minutes?|minuten?|minutos?|dakika\p{L}*|dk|h|hrs?|hours?|stunden?|horas?|heures?|saat\p{L}*|days?|gün\p{L}*|tage?n?|días?|jours?|weeks?|px|pt|dp|mb|gb|kb|cm|mm|km|x|\p{L}[\p{L}-]*\/(?:s|sec|min|h|day)|\/\s?(?:s|sec|min|h|day))(?![\p{L}\p{N}])`;

const LO_INCLUSIVE = ["≥", ">=", "at\\s+least", "no\\s+(?:less|fewer)\\s+than", "not\\s+(?:less|fewer)\\s+than", "minimum(?:\\s+of)?", "min\\.?", "en\\s+az", "asgari", "mindestens", "wenigstens", "al\\s+menos", "como\\s+mínimo", "au\\s+moins", "au\\s+minimum"];
const LO_EXCLUSIVE = [">", "more\\s+than", "above", "over"];
const HI_INCLUSIVE = ["≤", "<=", "at\\s+most", "no\\s+more\\s+than", "not\\s+more\\s+than", "up\\s+to", "maximum(?:\\s+of)?", "max\\.?", "within", "en\\s+fazla", "azami", "höchstens", "maximal", "bis\\s+zu", "como\\s+máximo", "hasta", "au\\s+plus", "au\\s+maximum", "jusqu'à"];
const HI_EXCLUSIVE = ["<", "less\\s+than", "fewer\\s+than", "under", "below"];
const EQUALS = ["==", "="];

const comparatorAlternation = (words: readonly string[]): string =>
  words.map((w) => (/^\p{L}/u.test(w) ? `(?<![\\p{L}])${w}` : w)).join("|");
const COMPARATOR_RE = new RegExp(
  `(${comparatorAlternation([...LO_INCLUSIVE, ...LO_EXCLUSIVE, ...HI_INCLUSIVE, ...HI_EXCLUSIVE, ...EQUALS].sort((a, b) => b.length - a.length))})\\s*[~≈]?\\s*(%\\s*)?(${NUM})(?:\\s*(${UNIT}))?`,
  "giu",
);
const RANGE_RE = new RegExp(
  `${NOT_AN_IDENTIFIER}([~≈])?(${NUM})(?:\\s*(${UNIT}))?(?:\\s*[–—-]\\s*|\\s+(?:to|ile|bis|a|à|au)\\s+)[~≈]?(${NUM})(?:\\s*(${UNIT}))?`,
  "giu",
);
const EXACT_RE = new RegExp(`${NOT_AN_IDENTIFIER}([~≈])?(${NUM})(\\+(?!\\d))?(?:\\s*(${UNIT}))?`, "giu");
const PERCENT_FIRST_RE = new RegExp(`(?<![\\p{L}\\p{N}])%\\s*(${NUM})`, "giu");
const NUMBER_RE = new RegExp(`${NOT_AN_IDENTIFIER}${NUM}`, "gu");
const BARE_VALUE_RE = new RegExp(`^[~≈]?\\s*${NUM}\\+?$`, "u");

function parseNumber(token: string): number {
  if (/^[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(token)) return Number(token.replace(/[.,]/g, ""));
  return Number(token.replace(",", "."));
}

/** The precision the document states: "0.17" fixes the hundredths, "43" the units. */
function toleranceOf(token: string, approximate: boolean): number {
  const value = parseNumber(token);
  if (approximate) return Math.abs(value) * 0.1;
  const decimals = /^[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(token) ? 0 : (/[.,](\d+)$/.exec(token)?.[1]?.length ?? 0);
  return 0.5 / 10 ** decimals;
}

function canonicalUnit(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const unit = raw.replace(/\s+/g, "");
  if (/^(?:ms|milliseconds?|millisaniye\p{L}*)$/iu.test(unit)) return "ms";
  if (/^(?:s|secs?|seconds?|saniye\p{L}*|sn|sekunden?|segundos?|secondes?)$/iu.test(unit)) return "s";
  if (/^(?:mins?|minutes?|minuten?|minutos?|dakika\p{L}*|dk)$/iu.test(unit)) return "min";
  if (/^(?:h|hrs?|hours?|stunden?|horas?|heures?|saat\p{L}*)$/iu.test(unit)) return "h";
  if (/^(?:days?|gün\p{L}*|tage?n?|días?|jours?)$/iu.test(unit)) return "day";
  if (/^[x×]$/iu.test(unit)) return "×";
  return unit;
}

interface Quantity {
  readonly bounds: RequirementBounds;
  readonly start: number;
  readonly end: number;
}

/** "Levels 1–5", "row 2", "Stage 3": a number that NAMES something bounds nothing. */
const NAMING_NOUN_BEFORE_RE =
  /(?<![\p{L}])(?:levels?|stages?|worlds?|chapters?|steps?|rows?|columns?|areas?|tiers?|phases?|sections?|versions?|seviye\p{L}*|bölüm\p{L}*|stufen?|nivel(?:es)?|niveaux?)\s*[~≈]?\s*$/iu;

function namesSomething(text: string, at: number): boolean {
  return NAMING_NOUN_BEFORE_RE.test(text.slice(Math.max(0, at - 16), at));
}

function withUnit<T extends object>(bounds: T, unit: string | undefined): T & { unit?: string } {
  return unit === undefined ? bounds : { ...bounds, unit };
}

function comparatorBounds(word: string, value: number, unit: string | undefined): RequirementBounds {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  const isIn = (list: readonly string[]): boolean => list.some((p) => new RegExp(`^(?:${p})$`, "iu").test(w));
  if (isIn(EQUALS)) return withUnit({ kind: "exact" as const, value, tolerance: 0 }, unit);
  if (isIn(LO_EXCLUSIVE)) return withUnit({ kind: "range" as const, lo: value, loExclusive: true }, unit);
  if (isIn(LO_INCLUSIVE)) return withUnit({ kind: "range" as const, lo: value }, unit);
  if (isIn(HI_EXCLUSIVE)) return withUnit({ kind: "range" as const, hi: value, hiExclusive: true }, unit);
  return withUnit({ kind: "range" as const, hi: value }, unit);
}

/**
 * The quantities in a piece of text, left to right: ranges first, then
 * comparisons, then a number with a unit (or a "+"). A bare number is not a
 * quantity: "Level 13" and "G-04" bound nothing.
 */
function quantitiesIn(text: string): Quantity[] {
  const found: Quantity[] = [];
  const free = (start: number, end: number): boolean => !found.some((q) => start < q.end && end > q.start);
  for (const m of text.matchAll(RANGE_RE)) {
    const lo = parseNumber(m[2]!);
    const hi = parseNumber(m[4]!);
    if (!(lo < hi) || namesSomething(text, m.index!)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    found.push({ bounds: withUnit({ kind: "range" as const, lo, hi }, canonicalUnit(m[5] ?? m[3])), start, end });
  }
  for (const m of text.matchAll(COMPARATOR_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    const unit = m[2] !== undefined ? "%" : canonicalUnit(m[4]);
    const value = parseNumber(m[3]!);
    const bounds = comparatorBounds(m[1]!, value, unit);
    found.push({
      bounds: bounds.kind === "exact" ? { ...bounds, tolerance: toleranceOf(m[3]!, false) } : bounds,
      start,
      end,
    });
  }
  for (const m of text.matchAll(PERCENT_FIRST_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    found.push({ bounds: { kind: "exact", value: parseNumber(m[1]!), tolerance: toleranceOf(m[1]!, false), unit: "%" }, start, end });
  }
  for (const m of text.matchAll(EXACT_RE)) {
    const plus = m[3] !== undefined;
    const unit = canonicalUnit(m[4]);
    // "44+ varieties" names no unit, and neither does a year: an unmeasured "+" is no bound.
    if (unit === undefined || namesSomething(text, m.index!)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    const value = parseNumber(m[2]!);
    found.push({
      bounds: plus
        ? withUnit({ kind: "range" as const, lo: value }, unit)
        : withUnit({ kind: "exact" as const, value, tolerance: toleranceOf(m[2]!, m[1] !== undefined) }, unit),
      start,
      end,
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Bounds only when the text states ONE quantity and no other number: a
 * sentence with three figures cannot be checked by asserting one of them,
 * so it stays a rule and the check is written whole.
 */
function singleBounds(text: string): RequirementBounds | undefined {
  const quantities = quantitiesIn(text);
  if (quantities.length !== 1) return undefined;
  const only = quantities[0]!;
  const strays = [...text.matchAll(NUMBER_RE)].filter(
    (m) => (m.index! < only.start || m.index! >= only.end) && !namesSomething(text, m.index!),
  );
  return strays.length === 0 ? only.bounds : undefined;
}

// =============================================================================
// THE DOCUMENT: lines, headings, sections
// =============================================================================

interface Line {
  readonly index: number;
  readonly start: number;
  readonly raw: string;
  /** The line without bullets, list markers' decoration or surrounding blanks. */
  readonly text: string;
  readonly textStart: number;
  readonly kind: "blank" | "heading" | "code" | "body";
  readonly heading?: HeadingLine;
}

interface SectionRecord {
  readonly start: number;
  /** Non-apparatus headings, outermost first. */
  readonly path: readonly string[];
  /** The innermost heading as spelled, apparatus or not. */
  readonly section: string;
  readonly number?: string;
  /** The innermost heading is document apparatus (contents, summary, glossary…). */
  readonly apparatus: boolean;
}

interface Document {
  readonly text: string;
  readonly lines: readonly Line[];
  readonly sections: readonly SectionRecord[];
  readonly vocabulary: Vocabulary;
}

const BULLET_RE = /^[\s ]*(?:(?:[•·▪◦‣●○■□➢►]|[*+-](?=\s))[\s ]*)*/u;
const JSON_LINE_RE = /^\s*(?:[{}[\]],?\s*$|[{[]\s*"|"[^"\n]*"\s*:)/;
const FENCE_RE = /^\s*(?:```|~~~)/;

function readDocument(text: string): Document {
  const vocabulary = vocabularyFor(languagesOf(text));
  const rawLines = text.split("\n");
  const lines: Line[] = [];
  let offset = 0;
  let fenced = false;
  for (const [index, withCr] of rawLines.entries()) {
    const raw = withCr.replace(/\r$/, "");
    const start = offset;
    offset += withCr.length + 1;
    const bullet = BULLET_RE.exec(raw)?.[0].length ?? 0;
    const trimmed = raw.slice(bullet).trimEnd();
    const lead = trimmed.length - trimmed.trimStart().length;
    const body = trimmed.trim();
    const base = { index, start, raw, text: body, textStart: start + bullet + lead };
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      lines.push({ ...base, kind: "code" });
      continue;
    }
    if (fenced || JSON_LINE_RE.test(raw)) {
      lines.push({ ...base, kind: "code" });
      continue;
    }
    if (body === "") {
      lines.push({ ...base, kind: "blank" });
      continue;
    }
    const heading = headingOf(raw, vocabulary);
    lines.push(heading === undefined ? { ...base, kind: "body" } : { ...base, kind: "heading", heading });
  }
  return { text, lines, sections: sectionsOf(lines, rawLines), vocabulary };
}

/**
 * A heading by gdd-scope's rules — except that a plain numbered line which
 * reads as a sentence is a list item: "1. The player must reach the exit."
 * would otherwise open a section and cut every row below it from its own.
 */
function headingOf(raw: string, vocabulary: Vocabulary): HeadingLine | undefined {
  const heading = parseHeadingLine(raw);
  if (heading === undefined) return undefined;
  const markdown = /^\s{0,3}#/.test(raw);
  if (!markdown && (/[.!?:;,]$/.test(heading.title) || heading.title.includes(";") || vocabulary.modal.test(heading.title))) {
    return undefined;
  }
  return heading;
}

function sectionsOf(lines: readonly Line[], rawLines: readonly string[]): SectionRecord[] {
  const headings = lines.filter((l) => l.kind === "heading");
  // A document's own TITLE ("# Orbit Garden — Design Document") is the one
  // top-level markdown heading that opens it; it is nobody's section, and as
  // an ancestor every milestone that claims a word of it would own every row.
  const topLevel = headings.filter((l) => /^\s{0,3}#\s/.test(l.raw));
  const title = topLevel.length === 1 && headings[0] === topLevel[0] ? topLevel[0] : undefined;
  const records: SectionRecord[] = [{ start: 0, path: [], section: "", apparatus: false }];
  const stack: Array<{ title: string; level: number; omit: boolean }> = [];
  for (const line of headings) {
    const heading = line.heading!;
    const apparatus =
      TRIVIAL_HEADING_RE.test(normalizeHeading(heading.title)) && !sectionAsksForWork(rawLines, line.index);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    stack.push({ title: heading.title, level: heading.level, omit: apparatus || line === title });
    records.push({
      start: line.start,
      path: stack.filter((e) => !e.omit).map((e) => e.title),
      section: heading.title,
      ...(heading.number === undefined ? {} : { number: heading.number }),
      apparatus,
    });
  }
  return records;
}

function sectionAt(doc: Document, offset: number): SectionRecord {
  let found = doc.sections[0]!;
  for (const record of doc.sections) {
    if (record.start > offset) break;
    found = record;
  }
  return found;
}

function lineNumberAt(doc: Document, offset: number): number {
  let line = 1;
  for (const l of doc.lines) {
    if (l.start > offset) break;
    line = l.index + 1;
  }
  return line;
}

/** The document's words between two offsets, whitespace folded: verbatim, as a person reads it. */
function verbatim(doc: Document, start: number, end: number): string {
  return doc.text.slice(start, end).replace(/\s+/g, " ").trim();
}

// =============================================================================
// CANDIDATE ROWS
// =============================================================================

interface Candidate {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly label?: string;
  /** Kind fixed by the shape that found it (claim, screen, constant…); otherwise classified. */
  readonly kind?: RequirementKind;
  readonly bounds?: RequirementBounds;
}

/** "G-01", "P3", "FR-12", "NFR-2.1", "K-4a": a rule's own label. */
const LABEL_RE = /^([A-Z]{1,4}-?)(\d{1,3})(?:\.(\d{1,2}))?([a-z])?$/;
const INLINE_LABEL_RE = /^(?:\*\*|__)?([A-Z]{1,4}-?\d{1,3}(?:\.\d{1,2})?[a-z]?)(?:\*\*|__)?\s*(?:[:.)\]—–]|\s-)\s*(?=\S)/u;

interface LabelParts {
  readonly series: string;
  readonly number: number;
  readonly order: number;
  readonly width: number;
}

function labelParts(label: string): LabelParts | undefined {
  const m = LABEL_RE.exec(label);
  if (m === null) return undefined;
  const sub = m[3] === undefined ? 0 : Number(m[3]);
  const letter = m[4] === undefined ? 0 : m[4].charCodeAt(0) - 96;
  return { series: m[1]!, number: Number(m[2]), order: Number(m[2]) * 10_000 + sub * 100 + letter, width: m[2]!.length };
}

const ROW_INDEX_RE = /^\d{1,3}$/;

/** A table cell that is a name, not a sentence: what a header row and a first column hold. */
function isShortCell(line: Line | undefined): line is Line {
  return line !== undefined && line.kind === "body" && line.text.length <= 40 && !/[.!?:;]$/.test(line.text);
}

/**
 * Which column the label sits in, counted from the row's first cell.
 *
 * The header row is the run of short cells before the first label: when it
 * is wider than a row, the label is not the first column ("Variety | Week |
 * Note" — the week labels the row, the variety's name comes first). A
 * row-index column ("2", "3", …) in front of every label says the same.
 */
function labelColumn(doc: Document, run: readonly Line[], stride: number): number {
  const series = labelParts(run[0]!.text)!.series;
  let header = 0;
  for (let i = run[0]!.index - 1; i >= 0 && header < 12; i--) {
    const line = doc.lines[i];
    if (!isShortCell(line) || labelParts(line.text)?.series === series) break;
    header += 1;
  }
  const offset = header - stride;
  if (offset >= 1 && offset < stride) return offset;
  return run.every((line) => ROW_INDEX_RE.test(doc.lines[line.index - 1]?.text ?? "")) ? 1 : 0;
}

/**
 * Labelled rules in a table that lost its pipes: each label alone on a line,
 * its cells on the lines around it (the converter shape spec-scope.ts reads for
 * schedules). A label counts only inside a RUN — two or more labels of one
 * series, in increasing order, at a constant stride — because a lone "G-03"
 * cited in another table's cell is a reference, not a definition.
 */
function labelRuns(doc: Document, consumed: Set<number>): Candidate[] {
  const out: Candidate[] = [];
  const labelLines = doc.lines.filter((l) => l.kind === "body" && labelParts(l.text) !== undefined);
  const used = new Set<number>();
  for (let i = 0; i < labelLines.length; i++) {
    if (used.has(labelLines[i]!.index)) continue;
    const first = labelLines[i]!;
    const series = labelParts(first.text)!.series;
    const run: Line[] = [first];
    let stride = 0;
    for (let j = i + 1; j < labelLines.length; j++) {
      const next = labelLines[j]!;
      const parts = labelParts(next.text)!;
      if (parts.series !== series) continue;
      const last = run[run.length - 1]!;
      const gap = next.index - last.index;
      const crossesHeading = doc.lines.slice(last.index + 1, next.index).some((l) => l.kind === "heading");
      if (crossesHeading || parts.order <= labelParts(last.text)!.order) break;
      if (stride === 0) stride = gap;
      if (gap !== stride || stride < 2) break;
      run.push(next);
    }
    if (run.length < 2) continue;
    for (const line of run) used.add(line.index);
    const column = labelColumn(doc, run, stride);
    const after = stride - 1 - column;
    const runHasBlanks = doc.lines.slice(run[0]!.index, run[run.length - 1]!.index).some((l) => l.kind === "blank");
    for (const label of run) {
      let lastCell: Line | undefined;
      for (let k = 1; k <= after; k++) {
        const cell = doc.lines[label.index + k];
        if (cell === undefined || cell.kind === "heading" || cell.kind === "code") break;
        if (cell.kind === "blank") {
          if (!runHasBlanks) break;
          continue;
        }
        if (labelParts(cell.text)?.series === series) break;
        lastCell = cell;
      }
      if (lastCell === undefined) continue;
      // The row's cells before its label belong to it — all but a bare row index.
      let firstLine = label;
      for (let k = 1; k <= column; k++) {
        const cell = doc.lines[label.index - k];
        if (!isShortCell(cell) || ROW_INDEX_RE.test(cell.text)) break;
        firstLine = cell;
      }
      const start = firstLine.textStart;
      const end = lastCell.textStart + lastCell.text.length;
      for (let k = firstLine.index; k <= lastCell.index; k++) consumed.add(k);
      out.push({ text: verbatim(doc, start, end), start, end, label: label.text });
    }
  }
  return out;
}

/** "| FR-1 | The player must… |" and "FR-1<TAB>The player must…": one row per line. */
function cellsOf(line: Line): Array<{ text: string; start: number }> | undefined {
  const separator = line.text.includes("|") ? "|" : line.text.includes("\t") ? "\t" : undefined;
  if (separator === undefined) return undefined;
  const cells: Array<{ text: string; start: number }> = [];
  let at = 0;
  for (const part of line.text.split(separator)) {
    const lead = part.length - part.trimStart().length;
    if (part.trim() !== "") cells.push({ text: part.trim(), start: line.textStart + at + lead });
    at += part.length + 1;
  }
  return cells.length >= 2 ? cells : undefined;
}

const TABLE_RULE_RE = /^\|?\s*:?-{3,}/;

function labelledLines(doc: Document, consumed: Set<number>): Candidate[] {
  const out: Candidate[] = [];
  for (const line of doc.lines) {
    if (line.kind !== "body" || consumed.has(line.index)) continue;
    const cells = cellsOf(line);
    if (cells !== undefined && labelParts(cells[0]!.text) !== undefined) {
      const last = cells[cells.length - 1]!;
      const start = cells[0]!.start;
      const end = last.start + last.text.length;
      consumed.add(line.index);
      out.push({ text: verbatim(doc, start, end), start, end, label: cells[0]!.text });
      continue;
    }
    const inline = INLINE_LABEL_RE.exec(line.text);
    if (inline !== null && inline[0].length < line.text.length && line.text.slice(inline[0].length).trim().split(/\s+/).length >= 2) {
      consumed.add(line.index);
      out.push({ text: verbatim(doc, line.textStart, line.textStart + line.text.length), start: line.textStart, end: line.textStart + line.text.length, label: inline[1]! });
    }
  }
  return out;
}

const VALUE_CELL_RE = /^(?:[≤≥<>=~≈+]|at\s+least|at\s+most|up\s+to|max\.?|min\.?|en\s+az|en\s+fazla)?\s*%?\s*\d/iu;
const BUDGET_RE = /(?<![\p{L}])(?:budget|limit|ceiling|cap)(?![\p{L}])|(?:^|[._\s])(?:cap|limit)(?:$|[._\s])/iu;
/** A clause about a day or a week is not about a session (gdd-claims' allowance reads the same way). */
const OTHER_SUBJECT_RE = /\b(?:per\s+(?:day|week|month|dau|user|player)|daily|weekly|sitting|session\s+count|retention|dau)\b/i;

function isValueCell(text: string): boolean {
  return text.length <= 64 && VALUE_CELL_RE.test(text);
}

function isLabelCell(line: Line | undefined): line is Line {
  if (line === undefined || line.kind !== "body") return false;
  const text = line.text;
  return (
    text.length <= 48 &&
    /\p{L}/u.test(text) &&
    !/[.!?:;,]$/.test(text) &&
    !isValueCell(text) &&
    labelParts(text) === undefined &&
    text.split(/\s+/).length <= 6
  );
}

/**
 * Label/value pairs of a flattened table: "Graft time" / "38 s", and an
 * optional third line that describes the row — unless that line is itself
 * the label of the next pair.
 */
function labelValuePairs(doc: Document, consumed: Set<number>): Candidate[] {
  const out: Candidate[] = [];
  const lines = doc.lines;
  for (let i = 0; i + 1 < lines.length; i++) {
    const label = lines[i];
    const value = lines[i + 1];
    if (consumed.has(i) || consumed.has(i + 1) || !isLabelCell(label) || value?.kind !== "body" || !isValueCell(value.text)) continue;
    const description = lines[i + 2];
    const describes =
      description !== undefined &&
      description.kind === "body" &&
      !consumed.has(i + 2) &&
      !isValueCell(description.text) &&
      labelParts(description.text) === undefined &&
      !(isLabelCell(description) && lines[i + 3]?.kind === "body" && isValueCell(lines[i + 3]!.text));
    const last = describes ? description! : value;
    const start = label.textStart;
    const end = last.textStart + last.text.length;
    const section = sectionAt(doc, start);
    const claim = DURATION_LABEL_RE.test(label.text) ? sessionClaimBounds(value.text) : undefined;
    if (section.apparatus && claim === undefined) continue;
    let kind: RequirementKind | undefined;
    let bounds: RequirementBounds | undefined;
    if (claim !== undefined) {
      kind = "claim";
      bounds = claim;
    } else {
      bounds = BARE_VALUE_RE.test(value.text) ? bareValueBounds(value.text) : singleBounds(value.text);
      if (bounds !== undefined) {
        if (bounds.kind === "exact" && BUDGET_RE.test(`${label.text} ${describes ? description!.text : ""}`)) {
          bounds = withUnit({ kind: "range" as const, hi: bounds.value }, bounds.unit);
        }
        kind = bounds.kind === "exact" ? "constant" : "range";
      } else if (quantitiesIn(value.text).length === 0) {
        continue;
      }
    }
    for (let k = i; k <= last.index; k++) consumed.add(k);
    out.push({ text: verbatim(doc, start, end), start, end, ...(kind === undefined ? {} : { kind }), ...(bounds === undefined ? {} : { bounds }) });
    i = last.index;
  }
  return out;
}

function bareValueBounds(value: string): RequirementBounds {
  const token = new RegExp(NUM, "u").exec(value)![0];
  const approximate = /^[~≈]/.test(value.trim());
  if (value.trim().endsWith("+")) return { kind: "range", lo: parseNumber(token) };
  return { kind: "exact", value: parseNumber(token), tolerance: toleranceOf(token, approximate) };
}

/** "6–13 min in a calm season; up to 37 min in a storm season": the session lasts between the least and the most any clause allows. */
function sessionClaimBounds(value: string): RequirementBounds | undefined {
  const clauses = value.split(";").filter((clause) => !OTHER_SUBJECT_RE.test(clause));
  const timed = clauses.flatMap(quantitiesIn).filter((q) => ["s", "ms", "min", "h"].includes(q.bounds.unit ?? ""));
  if (timed.length === 0) return undefined;
  const unit = timed[0]!.bounds.unit;
  const same = timed.filter((q) => q.bounds.unit === unit);
  const los = same.map((q) => (q.bounds.kind === "range" ? q.bounds.lo : q.bounds.value)).filter((n): n is number => n !== undefined);
  const his = same.map((q) => (q.bounds.kind === "range" ? q.bounds.hi : q.bounds.value)).filter((n): n is number => n !== undefined);
  return withUnit({
    kind: "range" as const,
    ...(los.length > 0 ? { lo: Math.min(...los) } : {}),
    ...(his.length > 0 ? { hi: Math.max(...his) } : {}),
  }, unit);
}

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATION_RE = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|cf|fig|no|nr|z\.\s?b|d\.\s?h|bzw|örn|vb|p\.\s?ej|p\.\s?ex|incl|ca|esp)\.$/iu;

function sentencesOf(text: string, offset: number): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let begin = 0;
  const push = (end: number): void => {
    const piece = text.slice(begin, end);
    const lead = piece.length - piece.trimStart().length;
    const body = piece.trim();
    if (body !== "") out.push({ text: body, start: offset + begin + lead });
  };
  for (const m of text.matchAll(/[.!?]+(?=\s+["“'(«¿¡]?[\p{Lu}\p{N}])/gu)) {
    const end = m.index! + m[0].length;
    if (ABBREVIATION_RE.test(text.slice(begin, end))) continue;
    push(end);
    begin = end;
  }
  push(text.length);
  return out;
}

const ARROW_RE = /→|->|=>/g;

/** Normative sentences, quantities and outcomes from every line no other shape took. */
function sentenceRows(doc: Document, consumed: ReadonlySet<number>): Candidate[] {
  const out: Candidate[] = [];
  const { vocabulary } = doc;
  for (const line of doc.lines) {
    if (line.kind !== "body" || consumed.has(line.index) || TABLE_RULE_RE.test(line.text)) continue;
    if (sectionAt(doc, line.textStart).apparatus) continue;
    const segments = cellsOf(line) ?? [{ text: line.text, start: line.textStart }];
    for (const segment of segments) {
      for (const sentence of sentencesOf(segment.text, segment.start)) {
        if ((sentence.text.match(/\p{L}{2,}/gu) ?? []).length < 3) continue;
        const normative = vocabulary.modal.test(sentence.text);
        const quantified = quantitiesIn(sentence.text).length > 0;
        const outcome = vocabulary.outcome.test(sentence.text) && vocabulary.condition.test(sentence.text);
        const flow = outcome || (sentence.text.match(ARROW_RE) ?? []).length >= 2;
        if (!normative && !quantified && !flow) continue;
        const end = sentence.start + sentence.text.length;
        out.push({ text: verbatim(doc, sentence.start, end), start: sentence.start, end, ...(flow ? { kind: "flow" as const } : {}) });
      }
    }
  }
  return out;
}

/** A heading NAMING a group of screens; its children are the screens. */
const SCREEN_GROUP_RE =
  /^(?:(?:ui|game|menu)\s+)?(?:screens?|menus?|popups?)(?:\s+(?:specifications?|specs?|list|definitions?|catalog(?:ue)?|inventory))?$|^(?:ekranlar|menüler|bildschirme|pantallas|écrans)$/iu;
const SCREEN_WORD_RE =
  /^(?:screens?|popups?|pop-?ups?|menus?|hud|dialog(?:ue)?s?|overlays?|ekran\p{L}*|menü\p{L}*|bildschirm\p{L}*|dialog|pantallas?|menú|écrans?)$/iu;
const SCREEN_CONTAINER_RE =
  /(?<![\p{L}])(?:map|flow|specifications?|list|overview|inventory|design|principles|harita|akış|liste|übersicht|mapa|flujo|lista|carte|flux)(?![\p{L}])/iu;
/** German writes a screen as one compound word: "Hauptmenü", "Ergebnisbildschirm". */
const SCREEN_COMPOUND_RE = /^\p{L}{3,}(?:bildschirm|menü)$/iu;

function isScreenTitle(title: string, parent: string | undefined): boolean {
  const plain = normalizeHeading(title.replace(/\([^)]*\)/g, " "));
  if (plain === "" || SCREEN_GROUP_RE.test(plain) || SCREEN_CONTAINER_RE.test(plain)) return false;
  if (parent !== undefined && SCREEN_GROUP_RE.test(normalizeHeading(parent))) return true;
  const words = plain.split(" ");
  if (words.length < 2) return SCREEN_COMPOUND_RE.test(plain);
  return SCREEN_WORD_RE.test(words[0]!) || SCREEN_WORD_RE.test(words[words.length - 1]!);
}

function screenRows(doc: Document): Candidate[] {
  const out: Candidate[] = [];
  for (const line of doc.lines) {
    if (line.kind !== "heading") continue;
    const here = sectionAt(doc, line.start);
    if (here.apparatus || here.path[here.path.length - 1] !== line.heading!.title) continue;
    const parent = here.path.length >= 2 ? here.path[here.path.length - 2] : undefined;
    if (!isScreenTitle(line.heading!.title, parent)) continue;
    const start = line.start + line.heading!.titleAt;
    const end = start + line.heading!.title.length;
    out.push({ text: verbatim(doc, start, end), start, end, kind: "screen" });
  }
  return out;
}

/** The document folded to single spaces, with the original offset of every character kept. */
interface FoldedText {
  readonly folded: string;
  readonly offsets: readonly number[];
}

function foldWhitespace(text: string): FoldedText {
  let folded = "";
  const offsets: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (folded.length > 0 && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      folded += " ";
      offsets.push(pendingSpace);
      pendingSpace = -1;
    }
    folded += ch;
    offsets.push(i);
  }
  return { folded, offsets };
}

/** Where a (whitespace-folded) quote sits in the original text; undefined when it is not there verbatim. */
function locate(fold: FoldedText, quote: string): { start: number; end: number } | undefined {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle === "") return undefined;
  const at = fold.folded.indexOf(needle);
  if (at < 0) return undefined;
  return { start: fold.offsets[at]!, end: fold.offsets[at + needle.length - 1]! + 1 };
}

const CLAIM_UNIT: Record<NumericClaim["kind"], string> = {
  fps: "fps",
  boot_seconds: "s",
  level_load_seconds: "s",
  session_seconds: "s",
  level_count: "levels",
};

/**
 * gdd-claims' numbers — frame rate, boot, level load, session length, level
 * count — as rows. They are measured at delivery, wherever the document
 * states them, so even a summary table's figures are read. Two claims read
 * from one fragment ("lasts 74–95 s") are one row with both bounds.
 */
function claimRows(doc: Document, fold: FoldedText): Candidate[] {
  const bySpan = new Map<string, { start: number; end: number; bounds: RequirementBounds }>();
  for (const claim of extractNumericClaims(doc.text).claims) {
    const span = locate(fold, claim.text);
    if (span === undefined) continue;
    const bullet = BULLET_RE.exec(doc.text.slice(span.start, span.end))?.[0].length ?? 0;
    const start = span.start + bullet;
    const key = `${start}:${span.end}`;
    const unit = CLAIM_UNIT[claim.kind];
    const previous = bySpan.get(key)?.bounds;
    let bounds: RequirementBounds;
    if (claim.comparator === "eq") bounds = { kind: "exact", value: claim.value, tolerance: 0, unit };
    else {
      const prior = previous?.kind === "range" ? previous : undefined;
      bounds = {
        kind: "range",
        ...(prior?.lo !== undefined ? { lo: prior.lo } : {}),
        ...(prior?.hi !== undefined ? { hi: prior.hi } : {}),
        ...(claim.comparator === "min" ? { lo: claim.value } : { hi: claim.value }),
        unit,
      };
    }
    bySpan.set(key, { start, end: span.end, bounds });
  }
  return [...bySpan.values()].map(({ start, end, bounds }) => ({ text: verbatim(doc, start, end), start, end, kind: "claim" as const, bounds }));
}

// =============================================================================
// CLASSIFICATION
// =============================================================================

interface Classified {
  readonly kind: RequirementKind;
  readonly excludedBecause?: string;
}

function classify(doc: Document, candidate: Candidate, section: SectionRecord): Classified {
  if (candidate.kind === "claim") return { kind: "claim" };
  const { vocabulary } = doc;
  const textAspiration = candidate.label === undefined ? ASPIRATION_TEXT_RE.exec(candidate.text)?.[0] : undefined;
  const pathAspiration = [...section.path, section.section].map((h) => ASPIRATION_PATH_RE.exec(h)?.[0]).find((w) => w !== undefined);
  const ownSection = vocabulary.player.test(candidate.text) ? undefined : businessSectionName(section.section);
  const aspiration = textAspiration ?? pathAspiration ?? ownSection;
  if (aspiration !== undefined) {
    return { kind: "aspiration", excludedBecause: `aspiration (${aspiration.toLowerCase()}): a business or process goal, not a rule the game can be tested against` };
  }
  if (candidate.kind !== undefined && candidate.kind !== "flow") return { kind: candidate.kind };
  const words = candidate.text.split(/\s+/);
  const body = (candidate.label !== undefined ? words.slice(1) : words).filter((w) => w !== "|");
  const early = body.slice(0, 6).join(" ");
  if (vocabulary.input.test(candidate.text) && (vocabulary.player.test(candidate.text) || vocabulary.input.test(early))) {
    return { kind: "input" };
  }
  if (candidate.kind === "flow") return { kind: "flow" };
  const numbered = [...candidate.text.matchAll(NUMBER_RE)].length > 0;
  if (candidate.label === undefined && !numbered && vocabulary.judgement.test(candidate.text)) return { kind: "judgement" };
  if (candidate.label === undefined && candidate.bounds !== undefined) return { kind: candidate.bounds.kind === "exact" ? "constant" : "range" };
  return { kind: "rule" };
}

// =============================================================================
// NUMBERING GAPS
// =============================================================================

const RANGE_OF_LABELS_RE = /(?<![\p{L}\p{N}])([A-Z]{1,4}-?)(\d{1,3})\s*(?:…|\.{2,3}|–|—|-|to|through|thru|ile|bis)\s*(?:([A-Z]{1,4}-?))?(\d{1,3})(?![\p{N}])/gu;
const LABEL_MENTION_RE = /(?<![\p{L}\p{N}])([A-Z]{1,4}-?)(\d{1,3})(?![\p{N}.])/gu;

/**
 * A numbered series the document defines only in part. Reported from what
 * the document SAYS — a stated span ("G-01 to G-07") that the definitions
 * stop short of, or holes in a series that is otherwise complete — and never
 * invented: a sparse series ("W3, W11, W38…") is a schedule, not a list with
 * gaps.
 */
function numberingGapsOf(doc: Document, labels: readonly string[]): NumberingGap[] {
  const defined = new Map<string, { numbers: Set<number>; width: number }>();
  for (const label of labels) {
    const parts = labelParts(label);
    if (parts === undefined) continue;
    const entry = defined.get(parts.series) ?? { numbers: new Set<number>(), width: parts.width };
    entry.numbers.add(parts.number);
    defined.set(parts.series, entry);
  }
  const gaps: NumberingGap[] = [];
  for (const [series, { numbers, width }] of defined) {
    const max = Math.max(...numbers);
    const min = Math.min(...numbers);
    const dense = numbers.size >= 2 && numbers.size / (max - min + 1) >= 0.5;
    const missing = new Set<number>();
    const stated: string[] = [];
    for (const m of doc.text.matchAll(RANGE_OF_LABELS_RE)) {
      if (m[1] !== series || (m[3] !== undefined && m[3] !== series)) continue;
      const lo = Number(m[2]);
      const hi = Number(m[4]);
      if (!numbers.has(lo) || hi <= max || hi - lo > 500) continue;
      for (let n = max + 1; n <= hi; n++) missing.add(n);
      stated.push(m[0].replace(/\s+/g, " "));
    }
    if (dense) {
      for (let n = min; n <= max; n++) if (!numbers.has(n)) missing.add(n);
      for (const m of doc.text.matchAll(LABEL_MENTION_RE)) {
        const n = Number(m[2]);
        if (m[1] === series && !numbers.has(n) && n > max && n <= max * 2 + 10) missing.add(n);
      }
    }
    if (missing.size === 0) continue;
    const name = (n: number): string => `${series}${String(n).padStart(width, "0")}`;
    const sorted = [...missing].sort((a, b) => a - b);
    gaps.push({
      series,
      missing: sorted.map(name),
      detail:
        `${numbers.size} ${series}* label(s) defined (${name(min)}…${name(max)})` +
        (stated.length > 0 ? `; the document names ${[...new Set(stated)].join(", ")}` : "") +
        `; ${sorted.map(name).join(", ")} ${sorted.length === 1 ? "is" : "are"} never defined`,
    });
  }
  return gaps;
}

// =============================================================================
// EXTRACTION
// =============================================================================

export interface ExtractOptions {
  readonly gddSha256: string;
  readonly gddRevision: number;
  /** CAMPAIGN_MAX_REQUIREMENT_ROWS. */
  readonly maxRows?: number;
  readonly perSection?: number;
  /** Rows of an earlier revision: their identities carry over (requirement-identity.ts). */
  readonly previous?: readonly RequirementRow[];
  /** Row ids proven closed; a cosmetic rewording of one carries its evidence. */
  readonly proven?: ReadonlySet<string>;
}

export interface ExtractedRequirements {
  readonly rows: RequirementRow[];
  readonly overflow: RequirementOverflow;
  readonly numberingGaps: NumberingGap[];
}

/**
 * The approved GDD's requirement rows, deterministically: the same text gives
 * the same rows, with no model call. Rows past the caps are counted in
 * `overflow` and never dropped silently.
 */
export function extractRequirementRows(gddText: string, options: ExtractOptions): ExtractedRequirements {
  const doc = readDocument(gddText ?? "");
  const fold = foldWhitespace(doc.text);
  const consumed = new Set<number>();
  const labelled = [...labelRuns(doc, consumed), ...labelledLines(doc, consumed)].filter(
    (c) => !sectionAt(doc, c.start).apparatus,
  );
  const pairs = labelValuePairs(doc, consumed);
  const claims = claimRows(doc, fold);
  const loose = [...pairs, ...sentenceRows(doc, consumed), ...screenRows(doc)].filter(
    (c) => !claims.some((claim) => c.start < claim.end && c.end > claim.start),
  );

  // A labelled rule keeps the bounds of the one quantity it states, and stays the rule it is.
  const withBounds = labelled.map((c) => {
    const cells = c.text.slice(c.label!.length);
    const bounds = singleBounds(cells);
    return bounds === undefined ? c : { ...c, bounds };
  });
  const looseWithBounds = loose.map((c) => {
    if (c.bounds !== undefined || c.kind === "screen") return c;
    const bounds = singleBounds(c.text);
    return bounds === undefined ? c : { ...c, bounds };
  });

  const candidates = [...withBounds, ...claims, ...looseWithBounds].sort((a, b) => a.start - b.start || a.end - b.end);
  // DUPLICATES COLLAPSE by content: a rule restated in a summary table is one
  // row, and the labelled statement of it wins.
  const kept: Candidate[] = [];
  const byContent = new Map<string, number>();
  for (const candidate of candidates) {
    const key = contentFingerprint(candidate.text);
    const at = byContent.get(key);
    if (at === undefined) {
      byContent.set(key, kept.length);
      kept.push(candidate);
    } else if (candidate.label !== undefined && kept[at]!.label === undefined) {
      kept[at] = candidate;
    }
  }

  const sized = applyCaps(
    kept.map((candidate) => {
      const section = sectionAt(doc, candidate.start);
      return { candidate, section, classified: classify(doc, candidate, section) };
    }),
    options.maxRows ?? DEFAULT_MAX_REQUIREMENT_ROWS,
    options.perSection ?? DEFAULT_ROWS_PER_SECTION,
  );

  const { encoded, result } = identifyRequirements({
    previous: decodeIdentities((options.previous ?? []).map((r) => r.encoded)),
    texts: sized.kept.map(({ candidate }) => candidate.text),
    gdd: { sha256: options.gddSha256, revision: options.gddRevision },
    ...(options.proven === undefined ? {} : { proven: options.proven }),
  });
  const rows = sized.kept.map(({ candidate, section, classified }, i) =>
    toRow(doc, candidate, section, classified, result.identities[i]!.id, encoded[i]!, "extracted", options),
  );
  return {
    rows,
    overflow: sized.overflow,
    numberingGaps: numberingGapsOf(doc, labelled.map((c) => c.label!)),
  };
}

function toRow(
  doc: Document,
  candidate: Candidate,
  section: SectionRecord,
  classified: Classified,
  rid: string,
  encoded: string,
  source: RequirementRow["source"],
  gdd: { readonly gddSha256: string; readonly gddRevision: number },
): RequirementRow {
  return {
    rid,
    encoded,
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    text: candidate.text,
    section: section.section,
    sectionPath: [...section.path],
    ...(section.number === undefined ? {} : { sectionNumber: section.number }),
    line: lineNumberAt(doc, candidate.start),
    span: { start: candidate.start, end: candidate.end },
    kind: classified.kind,
    source,
    ...(candidate.bounds === undefined ? {} : { bounds: candidate.bounds }),
    ownership: [],
    status: classified.excludedBecause === undefined ? "open" : "excluded",
    ...(classified.excludedBecause === undefined ? {} : { excludedBecause: classified.excludedBecause }),
    checks: [],
    gddSha256: gdd.gddSha256,
    gddRevision: gdd.gddRevision,
  };
}

/**
 * The caps. Labelled rules and claims are taken first, then every other row
 * that a test decides, then aspiration and judgement rows; within a tier the
 * document's order. Whatever does not fit is counted with its section.
 */
function applyCaps<T extends { candidate: Candidate; section: SectionRecord; classified: Classified }>(
  items: readonly T[],
  maxRows: number,
  perSection: number,
): { kept: T[]; overflow: RequirementOverflow } {
  const tier = ({ candidate, classified }: T): number =>
    classified.kind === "aspiration" || classified.kind === "judgement"
      ? 3
      : candidate.label !== undefined || candidate.kind === "claim"
        ? 0
        : candidate.kind === "screen"
          ? 1
          : 2;
  const ranked = items.map((item, order) => ({ item, order })).sort((a, b) => tier(a.item) - tier(b.item) || a.order - b.order);
  const perSectionCount = new Map<string, number>();
  const keptOrders = new Set<number>();
  const dropped: T[] = [];
  for (const { item, order } of ranked) {
    const key = `${item.section.number ?? ""}|${item.section.section}`;
    const count = perSectionCount.get(key) ?? 0;
    if (count >= perSection || keptOrders.size >= maxRows) {
      dropped.push(item);
      continue;
    }
    perSectionCount.set(key, count + 1);
    keptOrders.add(order);
  }
  const kept = items.filter((_, order) => keptOrders.has(order));
  const sections = [...new Set(dropped.map((d) => d.section.section || "(before the first heading)"))];
  return { kept, overflow: { count: dropped.length, sections } };
}

/**
 * The ledger for a campaign, from the APPROVED text. The parameter's type is
 * the point: it holds `gddText` and nothing that leads to the disk copy, so a
 * caller cannot read rows from a document nobody approved. A campaign from
 * before the hash existed is bound to the text it holds, at revision 1.
 */
export function requirementLedgerFrom(
  campaign: Pick<Campaign, "gddText" | "gddSha256" | "gddRevision">,
  options: { readonly atMs: number } & Omit<ExtractOptions, "gddSha256" | "gddRevision">,
): RequirementLedger | undefined {
  const text = campaign.gddText;
  if (text === undefined || text.trim() === "") return undefined;
  const gddSha256 = campaign.gddSha256 ?? createHash("sha256").update(text).digest("hex");
  const gddRevision = campaign.gddRevision ?? 1;
  const { atMs, ...rest } = options;
  const extracted = extractRequirementRows(text, { ...rest, gddSha256, gddRevision });
  return {
    version: 1,
    gddSha256,
    gddRevision,
    extractedAtMs: atMs,
    rows: extracted.rows,
    overflow: extracted.overflow,
    numberingGaps: extracted.numberingGaps,
    llmAdded: 0,
  };
}

// =============================================================================
// THE ADD-ONLY PASS
// =============================================================================

/** One model call: system and user text in, the reply's text out (CampaignPlanner.complete). */
export type CompleteText = (system: string, user: string) => Promise<string>;

export interface AddOnlyRejection {
  readonly quote: string;
  readonly reason: string;
}

export interface AddOnlyResult {
  /** The rows passed in, unchanged and in order, then the accepted additions. */
  readonly rows: RequirementRow[];
  readonly added: RequirementRow[];
  readonly rejected: AddOnlyRejection[];
  readonly calls: number;
  readonly failedCalls: number;
}

const ADD_ONLY_SYSTEM = `You check ONE section of a game design document for requirements a code reader missed.
You see the section and the rows already read from it. Name only rules the finished game must obey that no listed row states: behaviour, numbers, screens, inputs, outcomes. Not marketing, business goals or team process.
Every item must QUOTE the document verbatim — the exact words, at least 20 characters, copied from the section — and say in one line what the game must do. A paraphrase is discarded.
At most ${ADD_ONLY_ROWS_PER_CHUNK} items. Respond ONLY with JSON: {"rows":[{"requirement":"<one line>","quote":"<the document's exact words>"}]} — an empty array when nothing is missing.`;

function parseProposals(reply: string): Array<{ quote: unknown; requirement: unknown }> {
  for (const candidate of balancedJsonObjects(reply).reverse()) {
    try {
      const parsed = JSON.parse(candidate) as { rows?: unknown };
      if (Array.isArray(parsed.rows)) {
        return parsed.rows
          .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
          .map((r) => ({ quote: r["quote"], requirement: r["requirement"] }));
      }
    } catch {
      // the next object, if any
    }
  }
  return [];
}

/**
 * One model pass per GDD revision that may only ADD rows. A proposal is
 * accepted only when its quote is in the approved text verbatim (whitespace
 * aside), at least 20 characters long, the proposed requirement is about
 * that quote (content-token overlap), and it is not a row already read. The
 * deterministic rows come back unchanged: this pass never removes or
 * reclassifies one, and a failed call costs nothing but its own additions.
 */
export async function proposeRowsAddOnly(
  gddText: string,
  ask: CompleteText,
  rows: readonly RequirementRow[],
  options: { readonly gddSha256: string; readonly gddRevision: number; readonly chunkChars?: number; readonly maxChunks?: number },
): Promise<AddOnlyResult> {
  const doc = readDocument(gddText ?? "");
  const fold = foldWhitespace(doc.text);
  const accepted: Array<{ candidate: Candidate; section: SectionRecord }> = [];
  const rejected: AddOnlyRejection[] = [];
  const known = new Set(rows.map((r) => contentFingerprint(r.text)));
  const spans = rows.map((r) => r.span);
  let calls = 0;
  let failedCalls = 0;

  for (const chunk of splitGddSections(doc.text, options.chunkChars, options.maxChunks)) {
    const chunkText = chunk.text.replace(/\s+/g, " ");
    const already = rows
      .filter((r) => chunkText.includes(r.text))
      .map((r) => `- ${r.text}`)
      .join("\n")
      .slice(0, 8_000);
    let reply: string;
    calls += 1;
    try {
      reply = await ask(
        ADD_ONLY_SYSTEM,
        `<section heading="${chunk.heading.replace(/"/g, "'")}">\n${chunk.text}\n</section>\n\n<rows-already-read>\n${already || "(none)"}\n</rows-already-read>`,
      );
    } catch {
      failedCalls += 1;
      continue;
    }
    let takenHere = 0;
    for (const proposal of parseProposals(reply)) {
      const quote = typeof proposal.quote === "string" ? proposal.quote : "";
      const reject = (reason: string): void => {
        rejected.push({ quote: quote.slice(0, 200), reason });
      };
      if (takenHere >= ADD_ONLY_ROWS_PER_CHUNK) {
        reject(`over the cap of ${ADD_ONLY_ROWS_PER_CHUNK} rows per section`);
        continue;
      }
      const folded = quote.replace(/\s+/g, " ").trim();
      if (folded.length < ADD_ONLY_MIN_QUOTE_CHARS) {
        reject(`quote too short (under ${ADD_ONLY_MIN_QUOTE_CHARS} characters)`);
        continue;
      }
      const span = locate(fold, folded);
      if (span === undefined) {
        reject("quote is not verbatim in the approved GDD");
        continue;
      }
      const section = sectionAt(doc, span.start);
      if (section.apparatus) {
        reject(`quote sits in document apparatus (${section.section})`);
        continue;
      }
      const requirement = typeof proposal.requirement === "string" && proposal.requirement.trim() !== "" ? proposal.requirement : folded;
      const asked = new Set(contentTokens(requirement));
      const quoted = new Set(contentTokens(folded));
      const shared = [...asked].filter((t) => quoted.has(t)).length;
      if (asked.size === 0 || shared / asked.size < ADD_ONLY_MIN_OVERLAP) {
        reject("the requirement is not about its quote");
        continue;
      }
      const text = verbatim(doc, span.start, span.end);
      const inside = spans.some((s) => span.start >= s.start && span.end <= s.end);
      if (known.has(contentFingerprint(text)) || inside) {
        reject("duplicate of an existing row");
        continue;
      }
      known.add(contentFingerprint(text));
      spans.push(span);
      takenHere += 1;
      const bounds = singleBounds(text);
      accepted.push({ candidate: { text, start: span.start, end: span.end, ...(bounds === undefined ? {} : { bounds }) }, section });
    }
  }

  if (accepted.length === 0) return { rows: [...rows], added: [], rejected, calls, failedCalls };
  const { encoded, result } = identifyRequirements({
    previous: decodeIdentities(rows.map((r) => r.encoded)),
    texts: [...rows.map((r) => r.text), ...accepted.map((a) => a.candidate.text)],
    gdd: { sha256: options.gddSha256, revision: options.gddRevision },
  });
  const added = accepted.map(({ candidate, section }, i) =>
    toRow(doc, candidate, section, classify(doc, candidate, section), result.identities[rows.length + i]!.id, encoded[rows.length + i]!, "llm-added", options),
  );
  return { rows: [...rows, ...added], added, rejected, calls, failedCalls };
}

/**
 * Rows for passages a reviewer names as unmet (the coverage audit, the
 * independent review). The add-only pass's rules for a quote, without its
 * per-section model call: in the approved text verbatim (whitespace aside), at
 * least ADD_ONLY_MIN_QUOTE_CHARS long, outside document apparatus, and not a
 * row already read — a duplicate is named by the row it repeats. Rows come
 * back classified, with identities that do not collide with `rows`, and with
 * no owner; `rows` is not changed.
 */
export function rowsFromQuotes(
  gddText: string,
  quotes: readonly string[],
  rows: readonly RequirementRow[],
  options: { readonly gddSha256: string; readonly gddRevision: number; readonly source: RequirementRow["source"] },
): { added: RequirementRow[]; rejected: AddOnlyRejection[] } {
  const doc = readDocument(gddText ?? "");
  const fold = foldWhitespace(doc.text);
  const accepted: Array<{ candidate: Candidate; section: SectionRecord }> = [];
  const rejected: AddOnlyRejection[] = [];
  const known = new Map(rows.map((r) => [contentFingerprint(r.text), r.rid]));
  const spans = rows.map((r) => ({ ...r.span, rid: r.rid }));
  for (const quote of quotes) {
    const folded = quote.replace(/\s+/g, " ").trim();
    const reject = (reason: string): void => {
      rejected.push({ quote: folded.slice(0, 200), reason });
    };
    if (folded.length < ADD_ONLY_MIN_QUOTE_CHARS) {
      reject(`quote too short (under ${ADD_ONLY_MIN_QUOTE_CHARS} characters)`);
      continue;
    }
    const span = locate(fold, folded);
    if (span === undefined) {
      reject("quote is not verbatim in the approved GDD");
      continue;
    }
    const section = sectionAt(doc, span.start);
    if (section.apparatus) {
      reject(`quote sits in document apparatus (${section.section})`);
      continue;
    }
    const text = verbatim(doc, span.start, span.end);
    const same = known.get(contentFingerprint(text)) ?? spans.find((s) => span.start >= s.start && span.end <= s.end)?.rid;
    if (same !== undefined) {
      reject(`duplicate of an existing row (${same})`);
      continue;
    }
    known.set(contentFingerprint(text), "another quote in this list");
    spans.push({ ...span, rid: "another quote in this list" });
    const bounds = singleBounds(text);
    accepted.push({ candidate: { text, start: span.start, end: span.end, ...(bounds === undefined ? {} : { bounds }) }, section });
  }
  if (accepted.length === 0) return { added: [], rejected };
  const { encoded, result } = identifyRequirements({
    previous: decodeIdentities(rows.map((r) => r.encoded)),
    texts: [...rows.map((r) => r.text), ...accepted.map((a) => a.candidate.text)],
    gdd: { sha256: options.gddSha256, revision: options.gddRevision },
  });
  const taken = new Set(rows.map((r) => r.rid));
  const added: RequirementRow[] = [];
  accepted.forEach(({ candidate, section }, i) => {
    const rid = result.identities[rows.length + i]!.id;
    // Results, budgets and waivers are keyed by rid: a second row under one id is damage, not a row.
    if (taken.has(rid)) {
      rejected.push({ quote: candidate.text.slice(0, 200), reason: `its identity is an existing row's (${rid})` });
      return;
    }
    taken.add(rid);
    added.push(toRow(doc, candidate, section, classify(doc, candidate, section), rid, encoded[rows.length + i]!, options.source, options));
  });
  return { added, rejected };
}

// =============================================================================
// OWNERSHIP
// =============================================================================

/** How a row the plan excluded says so; a replanned ladder lifts exactly these (requirement-ledger.ts). */
export const PLAN_EXCLUSION_PREFIX = "excluded by the plan: ";

/** What ownership reads from a milestone. */
export interface OwnerCandidate {
  readonly id: string;
  readonly coveredSections?: readonly string[];
  readonly prompt?: string;
}

export interface OwnershipResult {
  readonly rows: RequirementRow[];
  /** Row ids per owning milestone, in row order (`CampaignMilestone.requirementIds`). */
  readonly byMilestone: Record<string, string[]>;
  /** Rows nobody claims: queued for a later sprint, never dropped. A person can waive by section. */
  readonly queued: string[];
  readonly excluded: string[];
}

/**
 * "§7.4", and a range "§7.4–§7.12" or "§21-23". A range's far end needs its
 * own "§" or a dash with no space around it: "§6 – 2 passes" is §6 and a count.
 */
const SECTION_REFERENCE_RE =
  /§{1,2}\s*(\d{1,3}(?:\.\d{1,3})*)(?:(?:\s*(?:[–—-]|to|through|thru|bis|ile|a|à|au|hasta)\s*§{1,2}\s*|[–—-])(\d{1,3}(?:\.\d{1,3})*))?/gu;

interface SectionReference {
  readonly from: readonly number[];
  readonly to: readonly number[];
  /** A range covers more than one section, so it says less about any one of them. */
  readonly range: boolean;
  readonly spelled: string;
}

function sectionNumberParts(number: string): number[] {
  return number.split(".").map(Number);
}

/** A section number against one end of a reference, compared at that end's depth: §5 comes before §5.2, §5.10.2 is at §5.10. */
function compareToEnd(number: readonly number[], end: readonly number[]): number {
  for (let i = 0; i < end.length; i++) {
    if (i >= number.length) return -1;
    if (number[i] !== end[i]) return number[i]! - end[i]!;
  }
  return 0;
}

function sectionReferences(prompt: string | undefined): SectionReference[] {
  return [...(prompt ?? "").matchAll(SECTION_REFERENCE_RE)].map((m) => {
    const from = sectionNumberParts(m[1]!);
    const to = m[2] === undefined ? from : sectionNumberParts(m[2]);
    // A range that runs backwards is not a range; its first end still names a section.
    if (m[2] === undefined || compareToEnd(to, from) <= 0) return { from, to: from, range: false, spelled: `§${m[1]}` };
    return { from, to, range: true, spelled: `§${m[1]}–§${m[2]}` };
  });
}

function referenceCovers(reference: SectionReference, number: readonly number[]): boolean {
  return compareToEnd(number, reference.from) >= 0 && compareToEnd(number, reference.to) <= 0;
}

/** Deeper is more specific, and naming one section is more specific than spanning several at the same depth. */
function referenceSpecificity(reference: SectionReference): number {
  return Math.min(reference.from.length, reference.to.length) * 2 + (reference.range ? 0 : 1);
}

/**
 * Does a plan exclusion name this heading? The item before its colon must BE
 * the heading's name or a whole-word part of it. An item that only mentions a
 * heading ("events beyond the core rules") excludes nothing: a row excluded by
 * mistake is never checked, while a row queued by mistake waits for a person.
 */
function exclusionNames(item: string, heading: string): boolean {
  const named = normalizeHeading(item);
  const key = normalizeHeading(heading);
  return named.length >= 4 && ` ${key} `.includes(` ${named} `);
}

/**
 * A rung of the planned ladder, by the line campaign-manager's partial
 * delivery draws: the system appends coverage sprints (mcovN) and a final
 * proof (mfinal-N) after it. On a measured campaign's stored ladder the last milestone was
 * mcov1, a failed coverage sprint, and every claim went to it.
 */
export function isPlannedMilestone(id: string): boolean {
  return !id.startsWith("mcov") && !id.startsWith("mfinal");
}

/**
 * Give each row its milestone. Only the PLANNED ladder owns rows: the
 * coverage sprints and the final proof the system appends after it were not
 * planned to build a section, and a stored ladder ends with them.
 *
 *   • claims go to the final planned milestone, whatever the plan excluded
 *     (they are measured at delivery all the same);
 *   • a row under a heading the planner EXCLUDED is excluded, with the
 *     planner's reason;
 *   • otherwise the milestone whose `coveredSections` claims the row's own
 *     heading, then its parent, and so on outward (the most specific heading
 *     decides; the earliest milestone breaks a tie);
 *   • a milestone planned before `coveredSections` existed claims by the `§N.N`
 *     references in its prompt: a reference covers its subsections, a range
 *     ("§7.4–§7.12", as a planner's prompt may write them) every section between its
 *     ends, and the most specific reference decides;
 *   • a row nobody claims is QUEUED — failing closed.
 *
 * Rows already owned or excluded are left as they are. A waived row keeps its
 * status and waiver, and is given an owner only when it has none (a replan or
 * a move released it) and the plan does not exclude its heading: the owner is
 * what judges the row again if an amendment lifts the waiver. The input is
 * not mutated.
 */
export function assignOwners(
  rows: readonly RequirementRow[],
  milestones: readonly OwnerCandidate[],
  options: { readonly excluded?: readonly string[]; readonly finalId?: string; readonly atMs: number },
): OwnershipResult {
  const planned = milestones.filter((m) => isPlannedMilestone(m.id));
  const finalId = options.finalId ?? planned[planned.length - 1]?.id;
  const exclusions = (options.excluded ?? []).map((item) => ({ item, head: item.split(":")[0]!.trim() }));
  const byMilestone: Record<string, string[]> = {};
  const queued: string[] = [];
  const excluded: string[] = [];

  const exclusionOf = (row: RequirementRow): { item: string } | undefined => {
    const headings = [...(row.sectionPath ?? []), row.section].filter((h) => h !== "");
    return row.kind === "claim" ? undefined : exclusions.find((e) => headings.some((h) => exclusionNames(e.head, h)));
  };

  const owned = rows.map((row): RequirementRow => {
    if (row.status === "waived") {
      // A person's decision: its status stays, and the row joins no milestone's count. No owner
      // under a heading the plan excludes: once an amendment lifts the waiver, the owner would
      // judge a row the plan does not build, where an ownerless one is excluded like its siblings.
      const owner = row.owner === undefined && exclusionOf(row) === undefined ? ownerOf(row, planned, finalId) : undefined;
      return owner === undefined ? row : { ...row, owner: owner.milestoneId, ownership: [...row.ownership, { ...owner, atMs: options.atMs }] };
    }
    if (row.status === "excluded") {
      excluded.push(row.rid);
      return row;
    }
    if (row.owner !== undefined) {
      (byMilestone[row.owner] ??= []).push(row.rid);
      return row;
    }
    const exclusion = exclusionOf(row);
    if (exclusion !== undefined) {
      excluded.push(row.rid);
      return { ...row, status: "excluded", excludedBecause: `${PLAN_EXCLUSION_PREFIX}${exclusion.item}` };
    }
    const owner = ownerOf(row, planned, finalId);
    if (owner === undefined) {
      queued.push(row.rid);
      return row;
    }
    (byMilestone[owner.milestoneId] ??= []).push(row.rid);
    const entry: RowOwnership = { ...owner, atMs: options.atMs };
    return { ...row, owner: owner.milestoneId, ownership: [...row.ownership, entry] };
  });
  return { rows: owned, byMilestone, queued, excluded };
}

function ownerOf(
  row: RequirementRow,
  milestones: readonly OwnerCandidate[],
  finalId: string | undefined,
): Omit<RowOwnership, "atMs"> | undefined {
  if (row.kind === "claim") {
    return finalId === undefined ? undefined : { milestoneId: finalId, reason: "final-milestone" };
  }
  const path = row.sectionPath ?? (row.section === "" ? [] : [row.section]);
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const heading = path[depth]!;
    const claimant = milestones.find((m) => (m.coveredSections?.length ?? 0) > 0 && headingClaimedBy(heading, m.coveredSections!));
    if (claimant !== undefined) return { milestoneId: claimant.id, reason: "covered-section", detail: heading };
  }
  if (row.sectionNumber === undefined) return undefined;
  const number = sectionNumberParts(row.sectionNumber);
  let best: { id: string; spelled: string; specificity: number } | undefined;
  for (const milestone of milestones) {
    if ((milestone.coveredSections?.length ?? 0) > 0) continue;
    for (const reference of sectionReferences(milestone.prompt)) {
      if (!referenceCovers(reference, number)) continue;
      const specificity = referenceSpecificity(reference);
      if (best === undefined || specificity > best.specificity) best = { id: milestone.id, spelled: reference.spelled, specificity };
    }
  }
  return best === undefined ? undefined : { milestoneId: best.id, reason: "section-reference", detail: best.spelled };
}

/** The coverage queue's strings for rows still to do (`encodeRequirement`); a row that passes, is excluded or is waived is never a gap. */
export function rowsToGaps(rows: readonly RequirementRow[]): string[] {
  return rows.filter((r) => r.status !== "passing" && r.status !== "excluded" && r.status !== "waived").map((r) => r.encoded);
}
