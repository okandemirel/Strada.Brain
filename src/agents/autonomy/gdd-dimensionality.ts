/**
 * GDD dimensionality — what the design asks for, against what the scenes hold.
 *
 * Audited 2026-09-03. The PixelFlow GDD says "plump, glossy 3D-feel pigs" on
 * "softly rendered dimensional stages"; the delivered entry scene had no mesh
 * renderers and bound none of the project's 62 imported models. Nothing in the
 * pipeline ever compared the two.
 *
 * The expectation is DERIVED FROM THE GDD TEXT, never hardcoded: the terms
 * below are counted across the whole document and reported with their own
 * excerpts. It is deliberately not "the first heading that matches" — a
 * look-conformance gate was refused on review 2026-09-02 for quoting the GDD's
 * table of contents that way.
 *
 * This never refuses. A stylised 3D-feel look can legitimately be built from
 * sprites and flat quads, and no file scan can tell that apart from a scene
 * that simply has no art in it. The delivery report says what was measured —
 * mesh renderers, bound models, sprite renderers, camera projection — and the
 * reader judges.
 */

import type { BuiltAsSpecifiedReport } from "./built-as-specified.js";


export interface DimensionSignal {
  readonly term: string;
  readonly count: number;
  /** Where it is said, in the GDD's own words, so the reader can judge. */
  readonly excerpts: readonly string[];
}

export interface DimensionalityDisclosure {
  /** The GDD states 3D somewhere (mentions, not a single "the" statement). */
  readonly asksFor3D: boolean;
  readonly signals: readonly DimensionSignal[];
  /** Report lines — disclosure only; this never refuses. */
  readonly lines: readonly string[];
}

/**
 * Terms that state a game's dimensionality. Matched with word boundaries over
 * the WHOLE document and reported with counts and excerpts — never "the first
 * heading that matches", which is how a look-conformance gate ended up reading
 * the GDD's table of contents (refused on review 2026-09-02).
 */
const DIMENSION_TERMS: ReadonlyArray<{ term: string; re: RegExp }> = [
  { term: "3D", re: /\b3-?D\b/giu },
  { term: "2D", re: /\b2-?D\b/giu },
  { term: "isometric", re: /\bisometric\b/giu },
  { term: "orthographic", re: /\borthographic\b/giu },
  { term: "perspective", re: /\bperspective\b/giu },
  { term: "pixel-art canvas", re: /\bpixel[- ]art canvas(?:es)?\b/giu },
];

export function describeDimensionality(
  gddText: string | undefined,
  report: BuiltAsSpecifiedReport,
): DimensionalityDisclosure {
  const signals: DimensionSignal[] = [];
  if (gddText) {
    for (const { term, re } of DIMENSION_TERMS) {
      const excerpts: string[] = [];
      let count = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(gddText)) !== null) {
        count++;
        if (excerpts.length < 2) {
          const from = Math.max(0, m.index - 70);
          const to = Math.min(gddText.length, m.index + m[0].length + 70);
          excerpts.push(`…${gddText.slice(from, to).replace(/\s+/gu, " ").trim()}…`);
        }
        if (count > 5_000) break;
      }
      if (count > 0) signals.push({ term, count, excerpts });
    }
  }
  const asksFor3D = signals.some((s) => s.term === "3D");

  const lines: string[] = [];
  if (!gddText) {
    lines.push(
      "Dimensionality: the GDD text was not readable, so what it asks for was NOT checked against the scenes.",
    );
    return { asksFor3D: false, signals, lines };
  }
  if (signals.length === 0) {
    lines.push(
      "Dimensionality: the GDD states none of 3D / 2D / isometric / orthographic / perspective / pixel-art canvas — " +
        "nothing to compare the scenes against.",
    );
    return { asksFor3D: false, signals, lines };
  }

  lines.push(
    `Dimensionality the GDD states: ${signals.map((s) => `${s.term} ×${s.count}`).join(", ")}.`,
  );
  // EVERY recorded excerpt, not the first match. A look-conformance gate was
  // refused on review 2026-09-02 for quoting the GDD's table of contents
  // because it took the first heading that matched; showing the count and the
  // excerpts lets the reader see a contents line for what it is.
  const three = signals.find((s) => s.term === "3D");
  for (const excerpt of three?.excerpts ?? []) lines.push(`GDD says: ${excerpt}`);

  if (!report.measured) {
    lines.push("Shipped scenes could not be measured, so this asks-vs-built comparison was NOT made.");
    return { asksFor3D, signals, lines };
  }

  const ortho = report.shippedScenes.reduce((n, s) => n + s.camerasOrthographic, 0);
  const persp = report.shippedScenes.reduce((n, s) => n + s.camerasPerspective, 0);
  const boundModels = new Set(report.shippedScenes.flatMap((s) => s.modelsBound));
  if (asksFor3D) {
    lines.push(
      `The GDD asks for 3D; the shipped scenes contain ${report.shippedMeshRenderers} mesh renderer(s) and bind ` +
        `${boundModels.size} imported model(s), against ${report.shippedSpriteRenderers} sprite renderer(s). ` +
        `The project holds ${report.artInventory.models} imported model file(s). ` +
        `A stylised 3D-feel look can legitimately be built from sprites — these are the counts, not a verdict.`,
    );
  } else {
    lines.push(
      `The GDD does not state 3D; the shipped scenes contain ${report.shippedMeshRenderers} mesh renderer(s) and ` +
        `${report.shippedSpriteRenderers} sprite renderer(s).`,
    );
  }
  lines.push(`Camera projection in the shipped scenes: ${ortho} orthographic, ${persp} perspective.`);
  return { asksFor3D, signals, lines };
}
