/**
 * The platform the GDD asks for.
 *
 * The campaign built the player with no target at all, so it used whatever
 * the project happened to have active — and a desktop build then answered a
 * "60 fps on mid-range phones" claim (Codex 2026-09-11 B#11). The GDD's own
 * words decide the target; when it names none, nothing is forced and the
 * report says the target was the project's own.
 */

/** Targets unity_build_player accepts (Strada.MCP BUILD_TARGETS). */
export const BUILD_TARGETS = ["android", "ios", "webgl", "windows", "macos", "linux"] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];

/** Targets that are a handheld device: a desktop frame rate says nothing about them. */
export const MOBILE_TARGETS: ReadonlySet<string> = new Set(["android", "ios"]);

const PLATFORM_PATTERNS: ReadonlyArray<readonly [BuildTarget, RegExp]> = [
  ["android", /\b(?:android|google play|play store)\b/i],
  ["ios", /\b(?:ios|iphone|ipad|app store|testflight)\b/i],
  ["webgl", /\b(?:webgl|web ?browser|html5|itch\.io|play in the browser)\b/i],
  ["windows", /\b(?:windows|win64|pc(?:\s+(?:build|release|version))?|steam)\b/i],
  ["macos", /\b(?:macos|mac os|osx|apple silicon)\b/i],
  ["linux", /\b(?:linux|steamos|proton)\b/i],
];

/** Words that deny the platform they precede: "no iOS release", "not on Steam". */
const EXCLUDED_BEFORE = /\b(?:no|not|never|without|excluding|apart from|other than)\b[^.\n]{0,20}$/i;

function isExcluded(text: string, at: number): boolean {
  return EXCLUDED_BEFORE.test(text.slice(Math.max(0, at - 40), at));
}

/** "mobile"/"phones"/"tablets" with no store named: a handheld, target unresolved. */
const HANDHELD_RE = /\b(?:mobile|phones?|handheld|tablets?|smartphones?)\b/i;

export interface GddPlatform {
  /** The build target to ask for, when the document names one. */
  readonly target?: BuildTarget;
  /** True when the document describes a handheld device, whatever the store. */
  readonly handheld: boolean;
  /** The sentence the decision came from. */
  readonly evidence?: string;
}

export function gddPlatform(gddText: string | undefined): GddPlatform {
  if (!gddText) return { handheld: false };
  const hits: Array<{ target: BuildTarget; at: number }> = [];
  for (const [target, re] of PLATFORM_PATTERNS) {
    const m = re.exec(gddText);
    // A platform the document EXCLUDES is not a platform it asks for: "Android
    // only; no iOS release" named two and therefore forced neither (Codex
    // 2026-09-11 D#32).
    if (m && !isExcluded(gddText, m.index)) hits.push({ target, at: m.index });
  }
  const handheldMatch = HANDHELD_RE.exec(gddText);
  const handheld = handheldMatch !== null || hits.some((h) => MOBILE_TARGETS.has(h.target));
  if (hits.length === 0) return { handheld, ...(handheldMatch ? { evidence: sentenceAt(gddText, handheldMatch.index) } : {}) };
  // One platform named: that is the target. Several: the document ships to
  // more than one, and forcing one of them would be a guess — the project's
  // own active target stands and the report says so.
  const first = hits.sort((a, b) => a.at - b.at)[0]!;
  return hits.length === 1
    ? { target: first.target, handheld, evidence: sentenceAt(gddText, first.at) }
    : { handheld, evidence: sentenceAt(gddText, first.at) };
}

function sentenceAt(text: string, index: number): string {
  const from = Math.max(0, text.lastIndexOf("\n", index) + 1);
  const to = text.indexOf("\n", index);
  return text.slice(from, to === -1 ? Math.min(text.length, from + 200) : to).trim().slice(0, 200);
}

/**
 * Does a frame rate measured in `builtTarget` answer a claim made for this
 * document's platform? A desktop player cannot answer a phone's budget.
 */
export function frameRateAnswersPlatform(platform: GddPlatform, builtTarget: string | undefined): boolean {
  if (!builtTarget) return !platform.handheld;
  const built = builtTarget.toLowerCase();
  // A NAMED target must be the one that was built: Android performance does
  // not answer an iOS-only requirement (Codex 2026-09-11 D#33).
  if (platform.target) return built.includes(platform.target);
  if (!platform.handheld) return true;
  return MOBILE_TARGETS.has(built) || [...MOBILE_TARGETS].some((t) => built.includes(t));
}
