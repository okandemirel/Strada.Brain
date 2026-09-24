// ---------------------------------------------------------------------------
// A skill's entry point — ONE rule for the workspace trust scan
// (skill-trust.ts) and the loader (skill-loader.ts).
//
// SEC-1: the scan matched the exact name `index.js` in the directory listing
// while the loader probed `stat("<dir>/index.js")`. On a case-insensitive
// filesystem (APFS, NTFS) that probe also opens a differently-cased file, so
// the two disagreed about whether a skill had code at all. Both now decide
// from the listing, through this function.
// ---------------------------------------------------------------------------

/** The file names `loadSkillTools` imports, in order of preference. */
export const SKILL_ENTRY_POINTS: readonly string[] = ["index.ts", "index.js"];

export interface SkillEntryPointMatch {
  /** The name exactly as it appears in the directory listing. */
  readonly name: string;
  /** True only when the on-disk name is exactly one of {@link SKILL_ENTRY_POINTS}. */
  readonly exact: boolean;
}

/** Comparison key for "the same name on a case-insensitive filesystem" (NTFS upcasing, APFS folding). */
function foldKey(name: string): string {
  return name.normalize("NFKC").toUpperCase();
}

const ENTRY_POINT_FOLD_KEYS = new Set(SKILL_ENTRY_POINTS.map(foldKey));

/**
 * Pick a skill's entry point from the names of its top-level non-directory
 * entries. An exact name wins; otherwise a name that differs only in case is
 * returned with `exact: false`, so the trust scan still treats it as code and
 * the loader refuses to import it.
 */
export function findSkillEntryPoint(fileNames: readonly string[]): SkillEntryPointMatch | null {
  for (const wanted of SKILL_ENTRY_POINTS) {
    if (fileNames.includes(wanted)) return { name: wanted, exact: true };
  }
  const variant = fileNames.find((name) => ENTRY_POINT_FOLD_KEYS.has(foldKey(name)));
  return variant === undefined ? null : { name: variant, exact: false };
}
