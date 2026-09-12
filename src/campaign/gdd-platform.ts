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
  // "Release on Windows and Mac." named one platform and lost the other
  // (Codex 2026-09-11 O#7); "mac" alone is the ordinary way to write it.
  ["macos", /\b(?:macos|mac os|osx|apple silicon|mac app|mac)\b/gi],
  ["linux", /\b(?:linux|steamos|proton)\b/gi],
];

/**
 * Storefronts, used ONLY when the document names no operating system: a store
 * implies a platform ("Google Play" means Android) but a named OS beside it
 * always wins.
 */
/**
 * "PC" names a desktop without saying which. It is resolved WHERE IT STANDS:
 * "Ships on PC running Linux" is Linux (Codex 2026-09-11 K#14), but "Release
 * on PC and Android" is still a desktop requirement — suppressing every PC
 * mention as soon as any operating system appeared anywhere in the document
 * dropped the desktop build silently (Codex 2026-09-11 L#11).
 */
const GENERIC_DESKTOP_RE = /\bpc(?:\s+(?:build|release|version))?\b/gi;

/** The desktop operating systems: what a "PC" mention can already be saying. */
const DESKTOP_TARGETS: ReadonlySet<BuildTarget> = new Set(["windows", "macos", "linux"]);

const STOREFRONT_PATTERNS: ReadonlyArray<readonly [BuildTarget, RegExp]> = [
  ["android", /\b(?:google play|play store)\b/gi],
  ["ios", /\b(?:app store)\b/gi],
  ["webgl", /\bitch\.io\b/gi],
  ["windows", /\bsteam\b/gi],
];

/** Words that deny the platform they precede: "no iOS release", "not on Steam". */
const EXCLUDED_BEFORE = /\b(?:no|not|never|without|excluding|apart from|other than)\b[^.\n]{0,20}$/i;

function isExcluded(text: string, at: number): boolean {
  // WITHIN THE CLAUSE. "No Windows; Linux release via Steam." denied Linux
  // too, because the 40-character lookback reached across the semicolon —
  // and the document then named no platform at all (Codex 2026-09-11 O#7).
  const window = text.slice(Math.max(0, at - 40), at);
  const boundary = Math.max(window.lastIndexOf(";"), window.lastIndexOf("."), window.lastIndexOf("\n"));
  return EXCLUDED_BEFORE.test(boundary >= 0 ? window.slice(boundary + 1) : window);
}

/**
 * A "PC" that names a DISTRIBUTION, not a build target.
 *
 * "Android; Google Play Games on PC compatible" asked for an Android product
 * that Google's own compatibility layer also runs on a desktop — and the
 * reader added a native Windows target for it. Nobody builds that target, so
 * the delivery gate then reported a platform the document never asked for as
 * an unbuilt one, and no run could ever close it (Codex 2026-09-12 U#F3).
 */
// A STOREFRONT IS NOT A COMPATIBILITY LAYER: "Release on the App Store for
// Mac" names a native Mac product, and listing the store here dropped the
// target entirely (Codex 2026-09-12 V, a regression in my own U#F3 fix).
const PC_VIA_STORE_RE =
  /\b(?:google play\s+games|play games|bluestacks|emulator|emulation|compatibility layer)\b[^.\n]{0,24}$/i;
/** "PC compatible", "PC-compatible", "compatible with PC" — a compatibility statement. */
const PC_COMPATIBLE_AFTER_RE = /^\s*[-–—]?\s*compatib\w*/i;
const PC_COMPATIBLE_BEFORE_RE = /\bcompatib\w*\s+(?:with\s+)?$/i;
/** "Windows/PC play (Google Play Games on PC)" — the layer named just after. */
const PC_LAYER_RE = /\b(?:google play\s+games|play games|bluestacks|emulator|emulation|compatibility layer)\b/gi;
/** …and the same layer named in parentheses right after it: "Windows/PC play (Google Play Games on PC)". */
const PC_LAYER_PAREN_RE =
  /^[^.\n)]{0,24}?\([^)\n]{0,40}?\b(?:google play\s+games|play games|bluestacks|emulator|emulation|compatibility layer)\b/i;

function pcNamesDistributionOnly(text: string, at: number, length: number): boolean {
  const before = text.slice(Math.max(0, at - 40), at);
  const after = text.slice(at + length, at + length + 28);
  if (PC_VIA_STORE_RE.test(before) || PC_COMPATIBLE_BEFORE_RE.test(before) || PC_COMPATIBLE_AFTER_RE.test(after)) {
    return true;
  }
  // A LAYER NAMED AFTER THE OS QUALIFIES IT ONLY WITHOUT A COORDINATOR
  // between them, the same rule storefronts already follow: "Windows/PC play
  // (Google Play Games on PC)" is one distribution, while "Release on Windows
  // and Google Play" is two platforms (Codex 2026-09-11 K#14).
  if (PC_LAYER_PAREN_RE.test(text.slice(at + length, at + length + 72))) return true;
  const clause = clauseAfter(text.slice(at + length, at + length + 48));
  for (const m of clause.matchAll(PC_LAYER_RE)) {
    return !COORDINATOR_RE.test(clause.slice(0, m.index ?? 0));
  }
  return false;
}

/** "mobile"/"phones"/"tablets" with no store named: a handheld, target unresolved. */
const HANDHELD_RE = /\b(?:mobile|phones?|handheld|tablets?|smartphones?)\b/i;

/**
 * Words that separate two requests from one: "Windows and Google Play" names
 * two platforms, "Steam for Linux" names one. What sits between the store and
 * the operating system decides which.
 */
const COORDINATOR_RE = /\b(?:and|or|plus|also|then|later|as well as)\b|[,;&/]/i;

const OS_WORD_RE = new RegExp(PLATFORM_PATTERNS.map(([, re]) => re.source).join("|"), "gi");
const DESKTOP_OS_RE = new RegExp(
  PLATFORM_PATTERNS.filter(([t]) => DESKTOP_TARGETS.has(t)).map(([, re]) => re.source).join("|"),
  "gi",
);

/** The clause around an index: never across a sentence end or a line break. */
function clauseAfter(text: string): string {
  const end = text.search(/[.\n!?;]/);
  return end === -1 ? text : text.slice(0, end);
}
function clauseBefore(text: string): string {
  let cut = -1;
  for (const ch of [".", "\n", "!", "?", ";"]) cut = Math.max(cut, text.lastIndexOf(ch));
  return cut === -1 ? text : text.slice(cut + 1);
}

/**
 * Is this mention QUALIFIED by an operating system in the same noun phrase —
 * on either side of it, with no coordinator in between?
 */
function qualifiedByOs(text: string, at: number, length: number, os: RegExp): boolean {
  const after = clauseAfter(text.slice(at + length, at + length + 48));
  for (const m of after.matchAll(os)) {
    if (!COORDINATOR_RE.test(after.slice(0, m.index ?? 0))) return true;
    break;
  }
  const before = clauseBefore(text.slice(Math.max(0, at - 48), at));
  const prior = [...before.matchAll(os)].pop();
  if (prior && !COORDINATOR_RE.test(before.slice((prior.index ?? 0) + prior[0].length))) return true;
  return false;
}

/**
 * The platform a build's OWN words name — its target string or its artifact
 * path. A build that says nothing names nothing.
 */
export function targetOfBuild(text: string | undefined): BuildTarget | undefined {
  if (!text) return undefined;
  // THE ARTIFACT'S OWN NAME. Matching anywhere in the path called
  // /projects/android-helper/Build/Game.app an Android build — and on a Mac
  // that made a real launch failure look like a foreign host (Codex
  // 2026-09-11 O#6). A directory above the artifact names nothing about it.
  const lastSlash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const t = (lastSlash >= 0 ? text.slice(lastSlash + 1) : text).toLowerCase();
  if (/android|\.(?:apk|aab)$/.test(t)) return "android";
  if (/\bios\b|iphone|ipad|\.ipa$/.test(t)) return "ios";
  if (/webgl|\.html?$/.test(t)) return "webgl";
  if (/windows|win64|win32|\.exe$/.test(t)) return "windows";
  if (/osx|macos|mac os|darwin|\.app\/?$/.test(t)) return "macos";
  if (/linux|\.x86_64$/.test(t)) return "linux";
  return undefined;
}

/**
 * Did this build produce the platform the document asked for?
 *
 * A valid StandaloneOSX artifact used to satisfy "Release on Windows" and the
 * campaign reached `done` with the requested platform never built (Codex
 * 2026-09-11 L#12). A build that names NO platform is silence, not a
 * contradiction, and still counts — an unsatisfiable gate is worse than a
 * named gap.
 */
export function buildSatisfiesTarget(
  requested: string | undefined,
  builtTarget?: string,
  artifactPath?: string,
): boolean {
  if (!requested) return true;
  const fromLabel = targetOfBuild(builtTarget);
  const fromArtifact = targetOfBuild(artifactPath);
  // CONTRADICTORY EVIDENCE PROVES NOTHING. A build labelled
  // StandaloneWindows64 that produced a .app satisfied a Windows request
  // because only the label was read (Codex 2026-09-11 O#6).
  if (fromLabel !== undefined && fromArtifact !== undefined && fromLabel !== fromArtifact) return false;
  const named = fromLabel ?? fromArtifact;
  return named === undefined || named === requested;
}

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
  const collect = (
    patterns: typeof PLATFORM_PATTERNS,
    accept: (at: number, length: number, target: BuildTarget) => boolean = () => true,
  ): void => {
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
        if (!accept(m.index ?? 0, m[0].length, target)) continue;
        hits.push({ target, at: m.index ?? 0 });
        break;
      }
    }
  };
  // A DESKTOP OS NAMED AS A COMPATIBILITY LAYER is not a build target either:
  // "Windows/PC play (Google Play Games on PC) uses the same account" is a
  // sentence about one account across devices, and it put a Windows build on
  // the delivery gate's list of platforms nobody had built (Codex 2026-09-12
  // U#F3). Every occurrence is still examined, so a native mention elsewhere
  // in the document still names the target.
  collect(
    PLATFORM_PATTERNS,
    (at, length, target) => !DESKTOP_TARGETS.has(target) || !pcNamesDistributionOnly(gddText, at, length),
  );
  // …and a storefront names a platform the OS patterns did NOT: "Release on
  // Windows and Google Play" asks for two, and suppressing every storefront
  // as soon as one OS appeared dropped Android silently (Codex 2026-09-11
  // K#14). `collect` already skips a target that is present.
  // A storefront QUALIFIED BY AN OS names no platform of its own: "Steam for
  // Linux" is one platform, while "Windows and Google Play" is two (Codex
  // 2026-09-11 K#14).
  // …and the qualifier can stand EITHER SIDE of the store: "the Mac app on
  // the App Store" and "Linux release via Steam" each name one platform, and
  // reading only forward invented a second one that then blocked delivery
  // forever (Codex 2026-09-11 L#11).
  collect(STOREFRONT_PATTERNS, (at, length) => !qualifiedByOs(gddText, at, length, OS_WORD_RE));
  // A PC mention is its own clause's question, asked every time rather than
  // only when the document named nothing at all.
  collect(
    [["windows", GENERIC_DESKTOP_RE]],
    (at, length) =>
      !qualifiedByOs(gddText, at, length, DESKTOP_OS_RE) && !pcNamesDistributionOnly(gddText, at, length),
  );
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
  // THE CANONICAL TARGET, through the same parser the build acceptance uses:
  // a substring search for "macos" inside Unity's own "StandaloneOSX" found
  // nothing, so a Mac player's frame rate answered a Mac document with "not
  // measured" and an explanation about handhelds (Codex 2026-09-12 AA#5).
  const canonical = targetOfBuild(builtTarget);
  const built = (canonical ?? builtTarget).toLowerCase();
  // A NAMED target must be the one that was built: Android performance does
  // not answer an iOS-only requirement (Codex 2026-09-11 D#33).
  // ANY target the document named, not only the first: a document asking for
  // Windows AND Linux has its frame rate answered by either platform's own
  // measurement, and reading `target` alone made the second target's numbers
  // unmeasurable — so a 10 fps Linux build satisfied "60 fps" by saying
  // nothing (Codex 2026-09-12 Y#J4.3).
  const named = platform.targets.length > 0 ? platform.targets : platform.target ? [platform.target] : [];
  if (named.length > 0) return named.some((t) => built.includes(t));
  if (!platform.handheld) return true;
  return MOBILE_TARGETS.has(built) || [...MOBILE_TARGETS].some((t) => built.includes(t));
}

/** The platform of the machine this process is running on. */
export function hostTarget(platform: string = process.platform): BuildTarget | undefined {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return undefined;
}

/**
 * Is this artifact built for a DIFFERENT machine than the one holding it?
 *
 * "exec format error" was waived as host incompatibility whatever the
 * artifact was, so a malformed executable built FOR this machine excused
 * playing the game at all (Codex 2026-09-11 L#17). Only a proven mismatch is
 * a host's limit; an artifact whose platform is unknown is not proof of one.
 */
export function artifactIsForeign(artifactPath: string | undefined, host: BuildTarget | undefined): boolean {
  const built = targetOfBuild(artifactPath);
  if (built === undefined || host === undefined) return false;
  return built !== host;
}
