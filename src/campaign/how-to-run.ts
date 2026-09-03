import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * HOW_TO_RUN.md — the file the person who opens the delivery reads first.
 *
 * Measured 2026-09-03: the delivered PixelFlow tree had 20 scenes, 14 of them
 * enabled in the build, no README of any kind, and the user opened a scene of
 * flat coloured squares expecting a game. The delivery report is a chat
 * message that scrolls away; the project itself said nothing.
 *
 * EVERY field here is measured or declared unknown:
 *   - Unity version   ← ProjectSettings/ProjectVersion.txt
 *   - entry scene     ← ProjectSettings/EditorBuildSettings.asset + the scene files
 *   - how to play     ← the GDD's own core-mechanic field, quoted and attributed
 *   - the suite       ← the final milestone's recorded test verdict
 *   - what is scratch ← the scene-hygiene measurement
 * Nothing is inferred, and no field is silently omitted: an unmeasured field
 * is printed as "Unknown — <why>", because a missing line reads like a fact
 * nobody needed.
 */

export interface HowToRunFacts {
  /** Absolute project root — printed in the command line, not measured from. */
  readonly projectRoot: string;
  readonly unityVersion?: string;
  /** Why the version is unknown. Required when `unityVersion` is absent. */
  readonly unityVersionNote?: string;
  readonly entryScene?: string;
  readonly entryObjects?: number;
  /** Why no entry scene could be named. Required when `entryScene` is absent. */
  readonly entryNote?: string;
  /** Enabled scenes matching scaffolding shape — the removable ones. */
  readonly scaffolding: readonly string[];
  /** Enabled scenes matching neither rule — listed, never called removable. */
  readonly unclassified: readonly string[];
  /** Enabled scenes that are not the entry scene. */
  readonly otherEnabled: number;
  /** The GDD's core-mechanic sentence, verbatim. */
  readonly coreLoop?: string;
  readonly coreLoopNote?: string;
  /** Project-relative GDD path, so the quote can be checked at its source. */
  readonly gddPath?: string;
  /** The final milestone's observed test verdict, verbatim. */
  readonly suiteVerdict?: string;
  /** Whether that verdict came from the whole suite rather than a filter. */
  readonly suiteUnfiltered?: boolean;
  readonly suiteNote?: string;
  /** "PlayMode"/"EditMode" when the verdict names one — never assumed. */
  readonly testPlatform?: string;
}

/** Every "Unknown" carries its reason; a bare "Unknown" would be a shrug. */
function unknown(note: string | undefined): string {
  return `Unknown — ${note ?? "nothing measured it and no reason was recorded"}`;
}

export function readUnityVersion(
  projectRoot: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { version?: string; note?: string } {
  const path = join("ProjectSettings", "ProjectVersion.txt");
  try {
    const raw = read(join(projectRoot, path));
    const version = /^m_EditorVersion:\s*(\S+)\s*$/mu.exec(raw)?.[1];
    return version
      ? { version }
      : { note: `${path} names no m_EditorVersion line` };
  } catch (err) {
    return { note: `${path} could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * The GDD's own statement of the core verb.
 *
 * STRUCTURAL, not fuzzy. A line qualifies only when it IS the label — "Core
 * mechanic", "Core loop", "Core gameplay loop", stripped of markdown emphasis,
 * heading marks, table pipes and a trailing colon — either alone on its line
 * (the value is the next non-empty line, as a converted table row writes it)
 * or followed by a colon and the value. A line that merely STARTS with the
 * words does not qualify: the real GDD's "Core loop fun-test: 20 graybox
 * levels…" is a production checklist, and a first-match-wins scan is exactly
 * how an earlier gate ended up reading a table of contents (audited
 * 2026-09-03).
 *
 * Returns undefined when the GDD names no such field — the caller then prints
 * "Unknown" and points at the document, rather than paraphrasing a game it
 * cannot read.
 */
const CORE_LOOP_LABELS = new Set([
  "core mechanic",
  "core mechanics",
  "core loop",
  "core gameplay",
  "core game loop",
  "core gameplay loop",
]);

/** Strip the decoration a converted GDD wraps a field label in. */
function normalizeLabel(line: string): string {
  return line
    .replace(/^[\s|>*_#-]+/u, "")
    .replace(/[\s|*_:]+$/u, "")
    .trim()
    .toLowerCase();
}

/** How much of a very long value is quoted; the cut is always announced. */
const CORE_LOOP_CHARS = 600;

export function extractCoreLoop(gddText: string): string | undefined {
  const lines = gddText.split("\n");
  for (const [i, line] of lines.entries()) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      // `**Core loop:** value` puts the closing emphasis on the VALUE side of
      // the colon; strip it rather than quoting "** value" into the README.
      const inlineValue = line.slice(colon + 1).replace(/^[\s*_]+/u, "").trim();
      if (inlineValue.length > 0 && CORE_LOOP_LABELS.has(normalizeLabel(line.slice(0, colon)))) {
        return truncate(inlineValue);
      }
    }
    if (!CORE_LOOP_LABELS.has(normalizeLabel(line))) continue;
    // Bare label: the value is the next non-empty line — unless that line is
    // a heading or another label, in which case this was a contents entry or
    // a section title and there is no value to read.
    const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
    if (next === undefined) continue;
    if (/^\s*#/u.test(next) || CORE_LOOP_LABELS.has(normalizeLabel(next))) continue;
    return truncate(next.trim());
  }
  return undefined;
}

function truncate(value: string): string {
  return value.length > CORE_LOOP_CHARS
    ? `${value.slice(0, CORE_LOOP_CHARS)}… (quoted to ${CORE_LOOP_CHARS} of ${value.length} chars)`
    : value;
}

export function renderHowToRun(facts: HowToRunFacts): string {
  const lines: string[] = [
    `# How to run ${basename(facts.projectRoot)}`,
    "",
    "Written by Strada.Brain at delivery. Every line below is measured off this",
    "project; anything it could not measure says so instead of guessing.",
    "",
    "## Open it",
    "",
    `- **Unity version:** ${facts.unityVersion ?? unknown(facts.unityVersionNote)}` +
      (facts.unityVersion ? "  _(ProjectSettings/ProjectVersion.txt)_" : ""),
  ];

  if (facts.entryScene) {
    lines.push(
      `- **Entry scene:** \`${facts.entryScene}\` — open it and press Play.` +
        `  _(the richest scene enabled in ProjectSettings/EditorBuildSettings.asset` +
        (facts.entryObjects === undefined ? "" : `, ${facts.entryObjects} GameObjects`) +
        ")_",
    );
  } else {
    lines.push(`- **Entry scene:** ${unknown(facts.entryNote)}`);
  }

  lines.push("", "## Play it", "");
  if (facts.coreLoop) {
    lines.push(
      `> ${facts.coreLoop}`,
      "",
      `_The game's core mechanic, quoted from ${facts.gddPath ? `\`${facts.gddPath}\`` : "the GDD"}._`,
    );
  } else {
    lines.push(
      `${unknown(facts.coreLoopNote)}.` +
        (facts.gddPath ? ` Read the design document yourself: \`${facts.gddPath}\`.` : ""),
    );
  }

  lines.push("", "## Prove the suite", "");
  if (facts.suiteVerdict) {
    lines.push(
      `- **What delivery observed:** ${facts.suiteVerdict}` +
        (facts.suiteUnfiltered === true
          ? "  _(unfiltered — the whole suite was seen to pass)_"
          : "  _(FILTERED — this green covered a chosen subset, not the whole suite)_"),
    );
  } else {
    lines.push(`- **What delivery observed:** ${unknown(facts.suiteNote)}`);
  }
  const platform = facts.testPlatform ?? "<PlayMode|EditMode>";
  lines.push(
    "- **Re-run it** from the Unity Editor: Window ▸ General ▸ Test Runner ▸ Run All.",
    "- Or from a terminal, with your own Unity executable (its path is not measured here):",
    "",
    "```sh",
    `<unity-editor> -runTests -batchmode -projectPath "${facts.projectRoot}" \\`,
    `  -testPlatform ${platform} -testResults ./test-results.xml`,
    "```",
  );
  if (!facts.testPlatform) {
    lines.push("", "_Which suite to name is unknown: the recorded verdict does not name which suite ran._");
  }

  lines.push("", "## What is scaffolding", "");
  if (facts.otherEnabled === 0) {
    lines.push(
      "Build Settings enables the entry scene and nothing else — there is no scratch scene to remove.",
    );
  } else {
    lines.push(
      `Build Settings enables ${facts.otherEnabled} scene${facts.otherEnabled === 1 ? "" : "s"} besides the entry scene.`,
      "",
    );
    if (facts.scaffolding.length > 0) {
      lines.push(
        `${facts.scaffolding.length} match the shape of verification scaffolding (a single-purpose name, or fewer than 3 GameObjects) and can be removed from Build Settings or deleted:`,
        "",
        ...facts.scaffolding.map((s) => `- \`${s}\``),
        "",
      );
    }
    if (facts.unclassified.length > 0) {
      lines.push(
        `${facts.unclassified.length} are **not classified as scaffolding** — nothing here can tell a small hand-authored scene from a scratch one, so decide for yourself:`,
        "",
        ...facts.unclassified.map((s) => `- \`${s}\``),
        "",
      );
    }
    lines.push("Strada.Brain does not delete or disable scenes on its own.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
