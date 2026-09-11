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

/**
 * The OPERATING SYSTEM the document names. A storefront is not one: "Ships on
 * Steam for Linux" built Windows because Steam matched first, and "Buy the Mac
 * app on the App Store" built iOS (Codex 2026-09-11 J#19).
 */
const PLATFORM_PATTERNS: ReadonlyArray<readonly [BuildTarget, RegExp]> = [
  ["android", /\b(?:android)\b/gi],
  ["ios", /\b(?:ios|iphone|ipad|testflight)\b/gi],
  ["webgl", /\b(?:webgl|web ?browser|html5|play in the browser)\b/gi],
  ["windows", /\b(?:windows|win64)\b/gi],
  ["macos", /\b(?:macos|mac os|osx|apple silicon|mac app)\b/gi],
  ["linux", /\b(?:linux|steamos|proton)\b/gi],
];

/**
 * Storefronts, used ONLY when the document names no operating system: a store
 * implies a platform ("Google Play" means Android) but a named OS beside it
 * always wins.
 */
/**
 * "PC" names a desktop without saying which: Windows only when the document
 * names no operating system at all. "Ships on PC running Linux" used to
 * resolve to Windows first (Codex 2026-09-11 K#14).
 */
const GENERIC_DESKTOP_RE = /\bpc(?:\s+(?:build|release|version))?\b/gi;

const STOREFRONT_PATTERNS: ReadonlyArray<readonly [BuildTarget, RegExp]> = [
  ["android", /\b(?:google play|play store)\b/gi],
  ["ios", /\b(?:app store)\b/gi],
  ["webgl", /\bitch\.io\b/gi],
  ["windows", /\bsteam\b/gi],
];

/** Words that deny the platform they precede: "no iOS release", "not on Steam". */
const EXCLUDED_BEFORE = /\b(?:no|not|never|without|excluding|apart from|other than)\b[^.\n]{0,20}$/i;

function isExcluded(text: string, at: number): boolean {
  return EXCLUDED_BEFORE.test(text.slice(Math.max(0, at - 40), at));
}

/** "mobile"/"phones"/"tablets" with no store named: a handheld, target unresolved. */
const HANDHELD_RE = /\b(?:mobile|phones?|handheld|tablets?|smartphones?)\b/i;

export interface GddPlatform {
  /** The build target to ask for: the FIRST platform the document names. */
  readonly target?: BuildTarget;
  /**
   * Every platform the document asks for, in the order it names them.
   *
   * A document that ships to two used to resolve to NO target at all, so the
   * campaign built whatever the project had active, delivered that, and never
   * said the second platform existed (Codex 2026-09-11 F#11). The first is
   * built and the rest are disclosed, because a host that can build one
   * cannot necessarily build the others and an unbuildable gate is worse than
   * a named gap.
   */
  readonly targets: readonly BuildTarget[];
  /** True when the document describes a handheld device, whatever the store. */
  readonly handheld: boolean;
  /** The sentence the decision came from. */
  readonly evidence?: string;
}

export function gddPlatform(gddText: string | undefined): GddPlatform {
  if (!gddText) return { handheld: false, targets: [] };
  const hits: Array<{ target: BuildTarget; at: number }> = [];
  const collect = (patterns: typeof PLATFORM_PATTERNS, accept: (at: number, length: number) => boolean = () => true): void => {
    for (const [target, re] of patterns) {
      if (hits.some((h) => h.target === target)) continue;
      // EVERY occurrence, not the first: "No Windows release at launch. Linux
      // first; Windows later." excluded the first Windows mention and never
      // looked at the second (Codex 2026-09-11 J#19).
      for (const m of gddText.matchAll(re)) {
        // A platform the document EXCLUDES is not a platform it asks for:
        // "Android only; no iOS release" named two and therefore forced
        // neither (Codex 2026-09-11 D#32).
        if (isExcluded(gddText, m.index ?? 0)) continue;
        if (!accept(m.index ?? 0, m[0].length)) continue;
        hits.push({ target, at: m.index ?? 0 });
        break;
      }
    }
  };
  collect(PLATFORM_PATTERNS);
  // …and a storefront names a platform the OS patterns did NOT: "Release on
  // Windows and Google Play" asks for two, and suppressing every storefront
  // as soon as one OS appeared dropped Android silently (Codex 2026-09-11
  // K#14). `collect` already skips a target that is present.
  // A storefront QUALIFIED BY AN OS names no platform of its own: "Steam for
  // Linux" is one platform, while "Windows and Google Play" is two (Codex
  // 2026-09-11 K#14).
  collect(STOREFRONT_PATTERNS, (at, length) => !/^\s*(?:for|on)\s+(?:windows|win64|linux|macos|mac os|osx|android|ios)\b/i.test(gddText.slice(at + length, at + length + 24)));
  if (hits.length === 0) collect([["windows", GENERIC_DESKTOP_RE]]);
  const handheldMatch = HANDHELD_RE.exec(gddText);
  const handheld = handheldMatch !== null || hits.some((h) => MOBILE_TARGETS.has(h.target));
  if (hits.length === 0) {
    return { handheld, targets: [], ...(handheldMatch ? { evidence: sentenceAt(gddText, handheldMatch.index) } : {}) };
  }
  // THE FIRST NAMED PLATFORM IS THE TARGET, and every named platform is
  // carried. Returning no target for a two-platform document meant the build
  // took whatever the project had active and the report never named the rest.
  const ordered = [...hits].sort((a, b) => a.at - b.at);
  const first = ordered[0]!;
  return {
    target: first.target,
    targets: ordered.map((h) => h.target),
    handheld,
    evidence: sentenceAt(gddText, first.at),
  };
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
