/**
 * A REQUIREMENT'S IDENTITY — plan item 6.2, the surface.
 *
 * The core of 6.2 landed first: a requirement is closed only by a TYPED,
 * requirement-specific evidence predicate (campaign-planner.ts `quoteIsAbout`).
 * What was still missing is the other half — WHICH requirement a proof belongs
 * to. Until this module every requirement was identified by its own TEXT
 * (`requirementKey` in campaign-manager.ts normalizes the string and that is
 * the identity), which fails in three ways that were all measured in this
 * repo:
 *
 *   1. A GDD edit that rewords a requirement produces a different key, so the
 *      history of what had already been proven about it is lost and the repair
 *      budget starts again from zero. The same defect shape as Codex
 *      2026-09-12 AD#15, where "…attempt 1" and "…attempt 2" were two
 *      requirements.
 *   2. Two requirements with similar words collide — the reason
 *      `coverageRequirementOf` refuses to key on the 60-character title at all
 *      ("Boss Alpha" and "Boss Beta" both reduce to "Boss", Codex 2026-09-12
 *      X#2). Text similarity is not identity.
 *   3. Nothing said which GDD REVISION a requirement (or its closure) came
 *      from, so a closure read on revision 1 silently answered revision 2.
 *
 * The model here has two levels, and the distinction is the whole point:
 *
 *   • `id`      identifies a requirement AS WORDED. It embeds a fingerprint of
 *               the normalized wording, so an id can never be reused for a
 *               different requirement — the id would not fingerprint to it.
 *   • `lineage` identifies the REQUIREMENT across rewordings. It is the id of
 *               the first ancestor and never changes, so the history survives
 *               an edit to the document.
 *
 * A rewording therefore MINTS A NEW ID and links it to its predecessor with
 * `supersedes`. Whether the new id inherits the old one's evidence is decided
 * by one rule, stated in code in `isCosmeticRewording`: the evidence carries
 * over only when the two wordings have the same content fingerprint —
 * identical content words (stemmed), identical numbers, identical negations,
 * in the same order. Anything else — a changed number, an added clause, a
 * changed diagnosis, a dropped "not" — is NOT cosmetic: the new id carries no
 * evidence and, if the predecessor had been proven, the requirement is
 * REOPENED.
 *
 * Carriage. The campaign's persisted requirement fields are strings
 * (`Campaign.pendingCoverageGaps: string[]`, `CampaignMilestone.coverageGap:
 * string`), so an identity rides in the string itself through
 * `encodeRequirement` / `decodeRequirement`: the requirement text followed by
 * one machine-readable tail. Everything that reads a requirement for a human
 * or for a model must go through `requirementText` first — the tail is an id,
 * not prose.
 */

import { createHash } from "node:crypto";

// ─── wording normalization ──────────────────────────────────────────────────

/**
 * Words whose plural the suffix rules cannot reach.
 *
 * The -is/-es pairs are LISTED, not inferred: a general "-ses → -sis" rule
 * turned `houses` into `housis` while `house` stemmed to `hous`, and
 * "-xes → -xis" turned `boxes` into `boxis` while `box` stayed `box` — so
 * ordinary plurals stopped matching their own singular and real
 * implementation evidence was rejected (Codex 2026-09-17 round 9 #33). Only
 * words that genuinely take -is in the singular belong here.
 *
 * Lived in campaign-planner.ts until plan 6.2; it is text normalization, and
 * both the evidence matcher and the identity fingerprint need exactly the same
 * one — two stemmers would mean a requirement could be "the same" for matching
 * and "different" for identity.
 */
export const IRREGULAR_STEMS: Record<string, string> = {
  mice: "mous", children: "child", feet: "foot", teeth: "tooth", geese: "goos",
  men: "man", women: "woman", lives: "lif", knives: "knif",
  // Greek/Latin -is → -es (round 8 #14): both forms meet at the singular.
  analysis: "analysis", analyses: "analysis",
  axis: "axis", axes: "axis",
  crisis: "crisis", crises: "crisis",
  thesis: "thesis", theses: "thesis",
  hypothesis: "hypothesis", hypotheses: "hypothesis",
  diagnosis: "diagnosis", diagnoses: "diagnosis",
  parenthesis: "parenthesis", parentheses: "parenthesis",
  synopsis: "synopsis", synopses: "synopsis",
  // …and -x → -ices, which no suffix rule reaches either.
  matrix: "matrix", matrices: "matrix",
  vertex: "vertex", vertices: "vertex",
  index: "index", indices: "index", indexes: "index",
  appendix: "appendix", appendices: "appendix",
};

/**
 * A word's stem, lightly: enough that "restarts" meets "restart", "saving"
 * meets "save" and "levels" meets "level" — compared as WHOLE stems, so
 * "saver" (ScreenSaver.png) does not meet "save" and "leverage" does not
 * meet "level" (Codex 2026-09-17 round 6 #1, #2).
 */
export function stemWord(word: string): string {
  const irregular = IRREGULAR_STEMS[word];
  if (irregular !== undefined) return irregular;
  // Canonical suffix rules: "progress" and "progresses" meet at "progres",
  // "mouse" and "mice" at "mous" (Codex 2026-09-17 round 7 #1). The -is/-es
  // families are in IRREGULAR_STEMS above: as suffix rules they mangled every
  // ordinary -xes/-ses plural (round 9 #33).
  let w = word.replace(/ies$/u, "y");
  if (/sses$/u.test(w)) return w.replace(/sses$/u, "ss"); // processes → process
  if (/ss$/u.test(w)) return w; // progress, class
  w = w.replace(/(?:ing|ed)$/u, "");
  if (/(?:ch|sh|x|z|s)es$/u.test(w)) w = w.replace(/es$/u, "");
  else if (/es$/u.test(w)) w = w.replace(/s$/u, "");
  else if (/[^s]s$/u.test(w)) w = w.replace(/s$/u, "");
  return w.replace(/e$/u, "");
}

/** The closed set of verdict tails the audit appends; never part of the ask. */
const VERDICT_SUFFIX_RE =
  /:\s*(?:absent|missing|not implemented|nothing implemented it|no milestone implemented it)\s*\.?\s*$/i;

/** Run-specific tails: "attempt 2", "(round 3 of 5)", "try #1" (Codex 2026-09-12 AD#15). */
const RUN_TAIL_RE =
  /[\s,;:—–-]*\(?\b(?:attempt|try|retry|round|pass|iteration)\b\s*#?\d+(?:\s*(?:of|\/)\s*\d+)?\)?\s*$/i;

/**
 * List/heading decoration a document editor adds and removes without changing
 * the ask. The numbering branch demands WHITESPACE after the separator: "3."
 * opening "3. Save progress" is a list marker, and "3.000" opening "3.000
 * coins" is a figure — stripping the latter turned three thousand into zero.
 */
// A leading dash is decoration ("- Save progress") EXCEPT when it is stuck to
// a digit: "-10 gravity" opens with a NEGATIVE NUMBER, and eating that sign made
// it "10 gravity" (Codex 2026-09-18 round 14 #10).
const LEADING_DECORATION_RE = /^(?:[\s>*_`•·]|[-–—](?!\d))*(?:\d+[.)]\s+)*[\s>*_`]*/u;
/** …and the decoration at the other end, a closing full stop included. */
const TRAILING_DECORATION_RE = /[\s>*_`•·.]+$/u;

/**
 * The wording, stripped of everything that is not the ask: the identity tail,
 * markdown decoration, a numbered-list prefix, the audit's verdict suffix, a
 * run-specific tail, curly punctuation, repeated whitespace, and case.
 *
 * Case folding and whitespace collapsing are deliberately part of the EXACT
 * fingerprint: re-indenting a document or capitalizing a heading is not a
 * rewording at all, and minting a new id for it would lose the history for no
 * reason.
 */
export function normalizeWording(text: string): string {
  return requirementText(text)
    .normalize("NFKC")
    .replace(/[‘’‛′]/gu, "'")
    .replace(/[“”″]/gu, '"')
    .replace(/[‐-―−]/gu, "-")
    .replace(LEADING_DECORATION_RE, "")
    .replace(TRAILING_DECORATION_RE, "")
    // THE RUN TAIL FIRST: "Shop: absent, attempt 3" keeps its verdict suffix
    // hidden behind the attempt counter, and a suffix that is not at the end
    // is not stripped at all (Codex 2026-09-12 AD#15 is the same shape).
    .replace(RUN_TAIL_RE, "")
    .replace(VERDICT_SUFFIX_RE, "")
    .replace(TRAILING_DECORATION_RE, "")
    // camelCase is split BEFORE case folding, so `SaveSystem` and `Save
    // System` are one requirement rather than two (the same rule the evidence
    // matcher's `stemsOf` uses).
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Words dropped before the CONTENT fingerprint: articles, the copula and the
 * modals. Deliberately tiny. Every word dropped here is a word two different
 * requirements are allowed to differ by and still count as the same one, so
 * prepositions ("save TO disk" versus "save FROM disk"), quantifiers and
 * conjunctions all stay in.
 */
const COSMETIC_FILLERS = new Set([
  "a", "an", "the", "is", "are", "be", "been", "being", "was", "were",
  "must", "should", "shall", "will", "would", "can", "may", "might",
  "that", "which", "does", "do", "did",
]);

/**
 * Negations, kept whatever their length. A fingerprint that dropped "not"
 * would make "the boss is defeated" and "the boss is NOT defeated" the same
 * requirement, and the second one would inherit the first one's proof.
 */
const NEGATIONS = new Set(["not", "no", "never", "none", "nor", "without", "non", "cannot", "cant", "dont", "doesnt", "isnt"]);

/**
 * "3,000" and "3.000" are 3000; "2.5" is 2.5 (a decimal, not a separator).
 *
 * THE SIGN IS PART OF THE VALUE. "-10" is not "10": a proven `Set gravity = -10`
 * reworded to `Set gravity = 10` had the same fingerprint, so it inherited the
 * proof and never reopened (round 14 #10). A LEADING PLUS is not part of the
 * value — "+10" is ten — so it is folded away, and only a minus survives. The
 * approximation marker does survive: "~60 fps" is a different ask from "60 fps".
 */
function normalizeNumber(token: string): string {
  const marker = /^[-~]/u.exec(token)?.[0] ?? "";
  const digits = token.replace(/^[+\-~≈]+/u, "");
  if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(digits)) return marker + digits.replace(/[.,]/gu, "");
  return marker + digits.replace(/,/gu, "");
}

/**
 * OPERATORS ARE CONTENT. A requirement's comparison carries its whole meaning:
 * `Score < 10` and `Score > 10` are opposite asks, and with every non-letter,
 * non-digit character treated as a separator they had ONE content fingerprint
 * — so one could inherit the other's proof, or silently replace it as a
 * "cosmetic" rewording (Codex 2026-09-18 round 13 #27). `60+ fps` is not
 * `60 fps` for the same reason.
 *
 * The family is closed and small: the comparisons, equality, and the "at
 * least" plus. Everything else stays a separator, because a hyphen in
 * "auto-save", a slash in "Assets/Art/Hero.png" and the asterisks of markdown
 * emphasis are decoration, not meaning.
 */
const OPERATOR_TOKEN_RE = /^(?:<=|>=|==|!=|[≤≥≠<>=+×÷%°$€£¥])$/u;
const OPERATOR_CANONICAL: Record<string, string> = { "≤": "<=", "≥": ">=", "≠": "!=", "==": "=", "÷": "/" };

/**
 * The token pattern, in one place because its ORDER is load-bearing.
 *
 *   1. the two-character comparisons, before their first character can match
 *      alone ("<=" is not "<" followed by "=");
 *   2. a NUMBER WITH ITS MARKER — a sign or an approximation stuck to the
 *      digits. The lookbehind is what keeps a hyphen a hyphen: in "level-10"
 *      and "auto-save" the dash JOINS, and calling it a sign would make
 *      "level-10 boss" a different requirement from "level 10 boss";
 *   3. the single-character symbols that change an ask — comparison, the
 *      postfix "60+", a multiplier, a percentage, a degree, a currency. A bare
 *      "-" is deliberately NOT one of them (see 2), and neither are "*", "/"
 *      or "~" on their own: those are markdown emphasis, a path separator and
 *      a strikethrough;
 *   4. letters.
 *
 * CONSIDERED AND DELIBERATELY LEFT OUT: "/" and ":" between digits ("1/2",
 * "1:30"). Both are separators far more often than they are content — a path
 * and the audit's own diagnostic colon — and no requirement pair in this repo
 * turns on one. A unit written in LETTERS ("10s" against "10ms") already
 * separates itself, because there is no length floor any more.
 */
const CONTENT_TOKEN_RE =
  /<=|>=|==|!=|(?<![\p{L}\p{N}])[+\-~≈]?\d+(?:[.,]\d+)*|[≤≥≠<>=+×÷%°$€£¥]|\p{L}+/gu;

/**
 * The CONTENT TOKENS of a wording, in order: numbers verbatim, operators
 * canonicalized, negations verbatim, every other word as its stem, fillers
 * dropped. camelCase is split before folding, so `SaveSystem` is two words.
 *
 * NO LENGTH FLOOR. A three-letter minimum dropped every short word that
 * carries the subject — `AI`, `UI`, `HP`, `XP`, the `2` of `2D` — so
 * "Enable AI" and "Enable UI" fingerprinted identically and each could inherit
 * the other's evidence (round 13 #27). It also dropped the two-letter
 * prepositions this module's own doctrine says it keeps ("save TO disk" is not
 * "save FROM disk"). The filler list is now the only thing that drops a word,
 * and it is deliberately tiny: every word in it is a word two requirements may
 * differ by and still count as the same one.
 *
 * ORDER IS KEPT. A sorted multiset would make "the player defeats the boss"
 * and "the boss defeats the player" the same requirement.
 */
export function contentTokens(text: string): string[] {
  // Numbers (with their separators), operators, or letter runs; every other
  // character is a separator. normalizeWording has already split camelCase and
  // folded case.
  const words = [...normalizeWording(text).matchAll(CONTENT_TOKEN_RE)].map((m) => m[0]);
  const out: string[] = [];
  for (const word of words) {
    if (/^[+\-~≈]?\d/u.test(word)) {
      out.push(normalizeNumber(word));
      continue;
    }
    if (OPERATOR_TOKEN_RE.test(word)) {
      out.push(OPERATOR_CANONICAL[word] ?? word);
      continue;
    }
    if (NEGATIONS.has(word)) {
      out.push(word);
      continue;
    }
    if (COSMETIC_FILLERS.has(word)) continue;
    // A stem that the suffix rules reduce to nothing ("es") keeps its word:
    // an empty token would merge two different short words into one.
    const stem = stemWord(word);
    out.push(stem.length > 0 ? stem : word);
  }
  return out;
}

function hash12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** The fingerprint of a WORDING: what the id is built from. */
export function wordingFingerprint(text: string): string {
  return hash12(`w:${normalizeWording(text)}`);
}

/**
 * The fingerprint of the CONTENT: two wordings share it exactly when the
 * difference between them is cosmetic (see `isCosmeticRewording`).
 *
 * A wording with NO content tokens ("—", "TBD", "???") falls back to its exact
 * wording, so two contentless requirements are never judged the same one.
 */
export function contentFingerprint(text: string): string {
  const tokens = contentTokens(text);
  if (tokens.length === 0) return `exact:${wordingFingerprint(text)}`;
  return hash12(`c:${tokens.join("|")}`);
}

/**
 * COSMETIC, EXACTLY: two wordings whose content tokens are identical —
 * same stems, same numbers, same negations, in the same order — differing
 * only in case, whitespace, punctuation, list/markdown decoration, the
 * audit's verdict suffix, a run-specific tail, an article, the copula or a
 * modal, or the inflection of a word.
 *
 * Everything else is NOT cosmetic, including the three cases that matter
 * most: a changed NUMBER ("12 levels" → "13 levels"), an added or removed
 * CLAUSE ("save progress" → "save progress to the cloud"), and a changed
 * DIAGNOSIS ("Shop: absent" → "Shop: the UI shell exists but nothing sells" —
 * the ask is the same but the new sentence is a fresh finding, and letting the
 * old closure answer it would suppress the finding).
 *
 * Not cosmetic ⇒ no inherited evidence, and a proven predecessor is reopened.
 */
export function isCosmeticRewording(previousText: string, nextText: string): boolean {
  return contentFingerprint(previousText) === contentFingerprint(nextText);
}

/**
 * The SUBJECT of a requirement: the part before the audit's diagnostic colon.
 * The audit writes "<item>: <one line on what is missing>", so "Shop: the UI
 * shell exists but nothing sells" and "Shop: absent" both have the subject
 * "Shop" — the verdict suffix has already been stripped by the time the second
 * one is read, which is why a wording with no colon left is its own subject.
 *
 * Two wordings with the same subject and different content are the same
 * requirement REDIAGNOSED — or the same ask with a changed figure ("Level
 * count: 13 levels" → "Level count: 20 levels"). They share a lineage, so the
 * history is not lost, and they share nothing else: the new wording carries no
 * evidence and a proven predecessor is reopened.
 */
export function subjectFingerprint(text: string): string | undefined {
  const wording = normalizeWording(text);
  const colon = wording.indexOf(":");
  const subject = colon > 0 ? wording.slice(0, colon) : wording;
  const tokens = contentTokens(subject);
  if (tokens.length === 0) return undefined;
  return hash12(`s:${tokens.join("|")}`);
}

// ─── the identity ───────────────────────────────────────────────────────────

export interface RequirementIdentity {
  /**
   * Stable id for this requirement AS WORDED: `req-<ordinal>-<wording
   * fingerprint>`. The ordinal is the requirement's 1-based position in the
   * revision that MINTED it — it disambiguates two requirements whose wording
   * is byte-identical; the fingerprint is what makes the id impossible to
   * reuse for a different requirement.
   */
  readonly id: string;
  /** The requirement's text, with no identity tail. */
  readonly text: string;
  /** Id of the first ancestor: the requirement's identity across rewordings. */
  readonly lineage: string;
  /** sha256 of the GDD this WORDING came from (plan 1.9's `gddSha256`). */
  readonly gddSha256?: string;
  /** That GDD's revision number (plan 1.9's `gddRevision`). */
  readonly gddRevision?: number;
  /** The id(s) this wording replaces. Present exactly when a revision reworded one. */
  readonly supersedes?: readonly string[];
  /** True only for a PROVABLY COSMETIC rewording of a requirement already proven. */
  readonly evidenceCarried?: boolean;
  /**
   * THE TREE the carried evidence was measured on — the project revision the
   * predecessor's closure was read against.
   *
   * Carriage without it is carriage that never expires: a requirement proven at
   * one revision, cosmetically reworded after its implementation was REMOVED,
   * was closed again by the historical commit note that had proved it, over the
   * model's own `delivered:false` (Codex 2026-09-18 round 13 #31). A reader of
   * `evidenceCarried` must hold this against the tree in front of it; when the
   * two do not match, the carriage says nothing and the requirement is judged
   * on this tree's evidence alone.
   */
  readonly carriedAtRevision?: string;
  /** True when a non-cosmetic rewording dropped a proven predecessor's closure. */
  readonly reopened?: boolean;
}

/** The id for a wording at a position. Deterministic; no clock, no randomness. */
export function mintRequirementId(text: string, ordinal: number): string {
  const n = Number.isFinite(ordinal) && ordinal > 0 ? Math.floor(ordinal) : 1;
  return `req-${String(n).padStart(3, "0")}-${wordingFingerprint(text)}`;
}

// ─── carriage: the identity rides in the persisted string ───────────────────

const TAIL_OPEN = "⟦";
const TAIL_CLOSE = "⟧";
const TAIL_RE = /\s*⟦(rid:[^⟧]*)⟧\s*$/u;

/**
 * The requirement as a person or a model must see it: the text, with any
 * identity tail removed. A string that never carried one comes back unchanged,
 * so every legacy persisted requirement reads correctly through this.
 */
export function requirementText(encoded: string): string {
  return encoded.replace(TAIL_RE, "").trim();
}

/**
 * A LIST of requirements as a person or a model must see it.
 *
 * Every presentation boundary needs this, and one of them did not have it: a
 * pending gap past the scheduling cap was copied verbatim into the delivery
 * output, `⟦rid:… lin:… gdd:…⟧` and all (Codex 2026-09-18 round 13 #30). A
 * named helper is harder to forget at the next boundary than a `.map()`.
 */
export function requirementTexts(encoded: readonly string[]): string[] {
  return encoded.map((item) => requirementText(item));
}

/** The identity carried by a persisted requirement string, when it carries one. */
export function decodeRequirement(encoded: string): { text: string; identity?: RequirementIdentity } {
  const match = TAIL_RE.exec(encoded);
  const text = requirementText(encoded);
  if (match === null) return { text };
  const fields = new Map<string, string>();
  for (const part of match[1]!.trim().split(/\s+/u)) {
    const at = part.indexOf(":");
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1));
  }
  const id = fields.get("rid");
  if (id === undefined || id === "") return { text };
  const gdd = fields.get("gdd");
  const [sha, rev] = gdd === undefined ? [undefined, undefined] : gdd.split("@");
  const supersedes = fields.get("sup")?.split(",").filter((s) => s.length > 0);
  const revision = rev === undefined || rev === "" ? undefined : Number(rev);
  return {
    text,
    identity: {
      id,
      text,
      lineage: fields.get("lin") ?? id,
      ...(sha === undefined || sha === "" ? {} : { gddSha256: sha }),
      ...(revision === undefined || !Number.isFinite(revision) ? {} : { gddRevision: revision }),
      ...(supersedes === undefined || supersedes.length === 0 ? {} : { supersedes }),
      ...(fields.get("carry") === "1" ? { evidenceCarried: true } : {}),
      ...(fields.get("tree") === undefined || fields.get("tree") === ""
        ? {}
        : { carriedAtRevision: fields.get("tree")! }),
      ...(fields.get("reopen") === "1" ? { reopened: true } : {}),
    },
  };
}

/** The requirement text plus its identity, as one persistable string. */
export function encodeRequirement(identity: RequirementIdentity): string {
  const parts = [`rid:${identity.id}`, `lin:${identity.lineage}`];
  if (identity.gddSha256 !== undefined && identity.gddSha256 !== "") {
    // The FULL sha, not a prefix: the campaign's own `gddSha256` is the whole
    // hash, and a truncated one here would force every comparison to be a
    // prefix test — one of which would eventually be written as `===` and
    // silently answer "a different document" for the same document.
    parts.push(`gdd:${identity.gddSha256}${identity.gddRevision === undefined ? "" : `@${identity.gddRevision}`}`);
  }
  if (identity.supersedes !== undefined && identity.supersedes.length > 0) {
    parts.push(`sup:${identity.supersedes.join(",")}`);
  }
  if (identity.evidenceCarried === true) parts.push("carry:1");
  // The revision the carriage is bound to travels WITH it: a `carry:1` whose
  // tree nobody recorded can never be held against the tree in front of the
  // reader, so it closes nothing (round 13 #31).
  if (identity.carriedAtRevision !== undefined && identity.carriedAtRevision !== "") {
    parts.push(`tree:${identity.carriedAtRevision}`);
  }
  if (identity.reopened === true) parts.push("reopen:1");
  return `${requirementText(identity.text)} ${TAIL_OPEN}${parts.join(" ")}${TAIL_CLOSE}`;
}

// ─── reconciliation across GDD revisions ────────────────────────────────────

/**
 * How much of the smaller token set two wordings must share before a
 * POSITIONAL match is believed to be the same requirement reworded rather than
 * a new one. Only ever used to record a `supersedes` link and to REOPEN; it
 * can never carry evidence, so a wrong guess here costs a re-check, never a
 * false closure.
 */
const REWORD_OVERLAP = 0.5;
const REWORD_MIN_SHARED = 2;

export interface ReconcileInput {
  /** Identities the campaign already holds, decoded from its persisted state. */
  readonly previous?: readonly RequirementIdentity[];
  /** The requirements of the revision being reconciled, in document order. */
  readonly texts: readonly string[];
  /** The GDD revision they came from (plan 1.9). */
  readonly gdd?: { readonly sha256?: string; readonly revision?: number };
  /** Ids the campaign has PROVEN closed. Evidence is only ever carried from one of these. */
  readonly proven?: ReadonlySet<string>;
  /**
   * The project revision those closures were read on. Stamped onto whatever
   * carries evidence, so the carriage can be held against the tree a later
   * reader sees (round 13 #31). A caller that cannot name a revision passes
   * none, and the carriage it produces closes nothing on its own.
   */
  readonly provenAtRevision?: string;
}

export interface ReconcileResult {
  /** One identity per input text, in the same order. */
  readonly identities: RequirementIdentity[];
  /** Previously known requirements this revision no longer asks for. */
  readonly retired: RequirementIdentity[];
  /** Identities whose proven predecessor's closure was dropped as non-cosmetic. */
  readonly reopened: RequirementIdentity[];
}

/**
 * Give every requirement of a revision its identity, carrying forward what the
 * campaign already knows.
 *
 * In order, for each requirement:
 *   1. the same WORDING as a known requirement → the same id, untouched. The
 *      revision did not reword it, so nothing about its evidence changes.
 *   2. a COSMETIC rewording of a known requirement → a new id, `supersedes`
 *      the old one, the same lineage, and `evidenceCarried` when the
 *      predecessor was proven.
 *   3. the same SUBJECT rediagnosed, or a positional match that shares enough
 *      content to be the same ask → a new id, `supersedes`, the same lineage,
 *      NO carried evidence, and `reopened` when the predecessor was proven.
 *   4. otherwise a NEW requirement: a fresh id and a lineage of its own.
 *
 * Each known requirement is claimed at most once, so two similar new wordings
 * cannot both inherit one predecessor.
 */
export function reconcileRequirements(input: ReconcileInput): ReconcileResult {
  const previous = input.previous ?? [];
  const proven = input.proven ?? new Set<string>();
  const claimed = new Set<string>();
  const identities: RequirementIdentity[] = [];
  const reopened: RequirementIdentity[] = [];
  const usedIds = new Map<string, string>();

  const free = (): RequirementIdentity[] => previous.filter((p) => !claimed.has(p.id));
  const gddFields = {
    ...(input.gdd?.sha256 === undefined ? {} : { gddSha256: input.gdd.sha256 }),
    ...(input.gdd?.revision === undefined ? {} : { gddRevision: input.gdd.revision }),
  };

  input.texts.forEach((raw, index) => {
    const text = requirementText(raw);
    const ordinal = index + 1;
    const wording = wordingFingerprint(text);
    const content = contentFingerprint(text);
    const subject = subjectFingerprint(text);

    // 1 — the same wording.
    const same = free().find((p) => wordingFingerprint(p.text) === wording);
    if (same !== undefined) {
      claimed.add(same.id);
      identities.push({ ...same, text });
      usedIds.set(same.id, wording);
      return;
    }

    const mint = (
      predecessor: RequirementIdentity | undefined,
      kind: "cosmetic" | "reworded" | "new",
    ): RequirementIdentity => {
      let id = mintRequirementId(text, ordinal);
      // AN ID IS NEVER REUSED FOR A DIFFERENT REQUIREMENT. Two identical
      // wordings at one position cannot happen (the ordinal differs), but a
      // caller may pass the same text twice at the same index across calls,
      // so the invariant is enforced rather than assumed.
      let bump = 2;
      while ((usedIds.get(id) ?? wording) !== wording) id = `${mintRequirementId(text, ordinal)}-${bump++}`;
      const carried = kind === "cosmetic" && predecessor !== undefined && proven.has(predecessor.id);
      const reopens = kind === "reworded" && predecessor !== undefined && proven.has(predecessor.id);
      const identity: RequirementIdentity = {
        id,
        text,
        lineage: predecessor?.lineage ?? id,
        ...gddFields,
        ...(predecessor === undefined ? {} : { supersedes: [predecessor.id] }),
        ...(carried ? { evidenceCarried: true } : {}),
        ...(carried && input.provenAtRevision !== undefined && input.provenAtRevision !== ""
          ? { carriedAtRevision: input.provenAtRevision }
          : {}),
        ...(reopens ? { reopened: true } : {}),
      };
      usedIds.set(id, wording);
      if (reopens) reopened.push(identity);
      return identity;
    };

    // 2 — a provably cosmetic rewording.
    const cosmetic = free().find((p) => contentFingerprint(p.text) === content);
    if (cosmetic !== undefined) {
      claimed.add(cosmetic.id);
      identities.push(mint(cosmetic, "cosmetic"));
      return;
    }

    // 3a — the same subject, rediagnosed.
    const rediagnosed =
      subject === undefined ? undefined : free().find((p) => subjectFingerprint(p.text) === subject);
    if (rediagnosed !== undefined) {
      claimed.add(rediagnosed.id);
      identities.push(mint(rediagnosed, "reworded"));
      return;
    }

    // 3b — the requirement that sat at this position, when the two wordings
    // still overlap enough to be the same ask.
    const atPosition = previous[index];
    if (atPosition !== undefined && !claimed.has(atPosition.id)) {
      const mine = new Set(contentTokens(text));
      const theirs = new Set(contentTokens(atPosition.text));
      const shared = [...mine].filter((t) => theirs.has(t)).length;
      const smaller = Math.min(mine.size, theirs.size);
      if (smaller > 0 && shared >= REWORD_MIN_SHARED && shared / smaller >= REWORD_OVERLAP) {
        claimed.add(atPosition.id);
        identities.push(mint(atPosition, "reworded"));
        return;
      }
    }

    // 4 — new.
    identities.push(mint(undefined, "new"));
  });

  return { identities, retired: free(), reopened };
}

/**
 * Reconcile a revision's requirements and hand back the persistable strings,
 * in the same order — the form the campaign stores and the planner reads back.
 */
export function identifyRequirements(input: ReconcileInput): { encoded: string[]; result: ReconcileResult } {
  const result = reconcileRequirements(input);
  return { encoded: result.identities.map(encodeRequirement), result };
}

/** Every identity a set of persisted requirement strings carries. */
export function decodeIdentities(encoded: readonly string[]): RequirementIdentity[] {
  const out: RequirementIdentity[] = [];
  for (const raw of encoded) {
    const decoded = decodeRequirement(raw);
    if (decoded.identity !== undefined) out.push(decoded.identity);
  }
  return out;
}
