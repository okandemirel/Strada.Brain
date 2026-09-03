import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Which scene is the game, and what else the delivery left in the build.
 *
 * Measured on the first real delivery (PixelFlow, 2026-09-03): 20 scenes on
 * disk, 14 of them ENABLED in Build Settings — InitTestScene<guid>,
 * TargetedLevel151Verification, UfoShowcase, ModuleBoundary, Assembled*,
 * LiveOps* — and the report said only "game build complete". The person who
 * opened it could not find the game.
 *
 * This measures three separable things and keeps them separable, because
 * conflating them is what makes a disclosure useless:
 *   - the ENTRY scene: the enabled scene carrying the most GameObjects;
 *   - SCAFFOLDING by shape: an enabled non-entry scene whose file name matches
 *     the vocabulary a verification scene is built with, OR that holds fewer
 *     than 3 GameObjects (a camera, a light and a probe is not a game);
 *   - UNCLASSIFIED: every other enabled scene. It is NOT called scaffolding —
 *     nothing here can tell a small hand-authored level from a scratch scene,
 *     and naming it disposable would invite deleting the user's work.
 *
 * Nothing here deletes or disables anything: this system does not get to
 * remove a user's scenes. It measures, names, and refuses to declare delivery
 * only when there is literally nothing to open (audited 2026-09-03).
 */

/** One scene listed in Build Settings, with what its file actually holds. */
export interface HygieneScene {
  /** Project-relative path exactly as Build Settings records it. */
  readonly path: string;
  /** GameObject count, or null when the scene file could not be read. */
  readonly objects: number | null;
}

/** The two states in which delivery may not be declared. */
export interface SceneHygieneRefusal {
  readonly kind: "no-enabled-scene" | "entry-unidentifiable";
  readonly detail: string;
}

export interface SceneHygieneReport {
  /** False when Build Settings could not be read at all — see `note`. */
  readonly measurable: boolean;
  /** Why nothing could be measured. Present iff `measurable` is false. */
  readonly note?: string;
  /** Every scene enabled in Build Settings, in the order the file lists them. */
  readonly enabled: readonly HygieneScene[];
  /** The scene a person should open. */
  readonly entry?: { readonly path: string; readonly objects: number };
  /** Enabled scenes tying the entry scene's object count (ambiguity, disclosed). */
  readonly entryTied: readonly string[];
  /** How many enabled scenes are not the entry scene. */
  readonly otherEnabled: number;
  /** Non-entry enabled scenes matching scaffolding shape. */
  readonly scaffolding: readonly HygieneScene[];
  /** Non-entry enabled scenes matching neither scaffolding rule. */
  readonly unclassified: readonly HygieneScene[];
  /** Enabled scenes whose file could not be read (counted as neither). */
  readonly unreadable: readonly string[];
  /** Set when delivery must not be declared. */
  readonly refusal?: SceneHygieneRefusal;
}

/** Injected so the measurement is testable without a Unity project on disk. */
export interface SceneHygieneIo {
  readFile(path: string): string;
  exists(path: string): boolean;
}

const defaultIo: SceneHygieneIo = {
  readFile: (p) => readFileSync(p, "utf8"),
  exists: (p) => existsSync(p),
};

/**
 * The vocabulary a single-purpose verification scene is named with. Matched
 * against the file NAME, never the directory path — a project may perfectly
 * well keep its game under Assets/Assembled/.
 */
const SCAFFOLDING_NAME = /InitTestScene|Verification|Verified|Showcase|Boundary|Assembled/i;

/** Below this, a scene cannot hold a game: camera, light, one probe object. */
const MIN_GAME_OBJECTS = 3;

/**
 * Scenes enabled in Build Settings.
 *
 * `path:` is read to end-of-line, not as `\S+`: Unity writes scene paths
 * unquoted, so "Assets/Scenes/My Game.unity" would otherwise be truncated at
 * the space and every read of it would fail (audited 2026-09-03).
 */
function enabledScenePaths(raw: string): string[] {
  const out: string[] = [];
  const re = /enabled:\s*1\s*\r?\n\s*path:\s*(.+?)\s*\r?$/gmu;
  for (const match of raw.matchAll(re)) {
    const path = match[1];
    if (path) out.push(path);
  }
  return out;
}

function countObjects(text: string): number {
  return (text.match(/^GameObject:/gmu) ?? []).length;
}

export function assessSceneHygiene(
  projectRoot: string,
  io: SceneHygieneIo = defaultIo,
): SceneHygieneReport {
  const empty = {
    enabled: [] as HygieneScene[],
    entryTied: [] as string[],
    otherEnabled: 0,
    scaffolding: [] as HygieneScene[],
    unclassified: [] as HygieneScene[],
    unreadable: [] as string[],
  };

  const settingsPath = join(projectRoot, "ProjectSettings", "EditorBuildSettings.asset");
  let raw: string;
  try {
    if (!io.exists(settingsPath)) throw new Error("not found");
    raw = io.readFile(settingsPath);
  } catch (err) {
    // UNMEASURABLE IS NOT A REFUSAL. A tree with no EditorBuildSettings.asset
    // may not be a Unity project at all; refusing delivery on the absence of
    // evidence would block honest deliveries, so this discloses instead
    // (audited 2026-09-03).
    return {
      ...empty,
      measurable: false,
      note:
        `ProjectSettings/EditorBuildSettings.asset could not be read (${err instanceof Error ? err.message : String(err)}) — ` +
        "which scene to open was NOT measured",
    };
  }

  const paths = enabledScenePaths(raw);
  if (paths.length === 0) {
    return {
      ...empty,
      measurable: true,
      refusal: {
        kind: "no-enabled-scene",
        detail:
          "Build Settings lists no scene is enabled — a build with no enabled scene opens on nothing",
      },
    };
  }

  const unreadable: string[] = [];
  const enabled: HygieneScene[] = paths.map((path) => {
    try {
      return { path, objects: countObjects(io.readFile(join(projectRoot, path))) };
    } catch {
      unreadable.push(path);
      return { path, objects: null };
    }
  });

  // The entry scene is the richest one: a verification scene holds a camera
  // and a probe, the game holds its systems. Ties break on the path so the
  // same tree always names the same scene — and the tie itself is disclosed
  // rather than hidden behind a sort order.
  const readable = enabled.filter((s): s is HygieneScene & { objects: number } => s.objects !== null);
  const best = [...readable].sort((a, b) => b.objects - a.objects || a.path.localeCompare(b.path))[0];
  if (!best || best.objects === 0) {
    return {
      ...empty,
      measurable: true,
      enabled,
      unreadable,
      otherEnabled: enabled.length,
      refusal: {
        kind: "entry-unidentifiable",
        detail: !best
          ? `none of the ${enabled.length} enabled scene files could be read, so no entry scene can be named`
          : `every one of the ${enabled.length} enabled scenes holds 0 GameObjects — there is nothing to open`,
      },
    };
  }

  const entryTied = readable
    .filter((s) => s.objects === best.objects && s.path !== best.path)
    .map((s) => s.path);

  const others = enabled.filter((s) => s.path !== best.path);
  const scaffolding = others.filter(
    (s) =>
      SCAFFOLDING_NAME.test(basename(s.path)) || (s.objects !== null && s.objects < MIN_GAME_OBJECTS),
  );
  const scaffoldingPaths = new Set(scaffolding.map((s) => s.path));
  const unclassified = others.filter((s) => !scaffoldingPaths.has(s.path) && s.objects !== null);

  return {
    measurable: true,
    enabled,
    entry: { path: best.path, objects: best.objects },
    entryTied,
    otherEnabled: others.length,
    scaffolding,
    unclassified,
    unreadable,
  };
}

/** Names, capped and SAID to be capped — a silent cap is a lie about a count. */
function nameList(scenes: readonly HygieneScene[], limit = 12): string {
  const shown = scenes.slice(0, limit).map((s) => `\`${basename(s.path)}\``);
  const hidden = scenes.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
}

/**
 * The "How to run it" block of the delivery report. A refusal is rendered
 * too: a delivery that reached the report despite one must say so, never read
 * like a clean build.
 */
export function renderSceneHygiene(report: SceneHygieneReport): string {
  if (!report.measurable) {
    return `**How to run it**\n- Which scene to open could not be measured: ${report.note ?? "no reason recorded"}.`;
  }
  if (report.refusal) {
    return `**How to run it**\n- ⚠️ NO ENTRY SCENE: ${report.refusal.detail}.`;
  }
  const lines = ["**How to run it**"];
  const entry = report.entry;
  if (entry) {
    lines.push(
      `- Open \`${entry.path}\` and press Play — it is the richest enabled scene (${entry.objects} objects).`,
    );
  }
  if (report.entryTied.length > 0) {
    lines.push(
      `- ${report.entryTied.length + 1} enabled scenes tie at ${entry?.objects ?? 0} objects ` +
        `(${report.entryTied.map((p) => `\`${basename(p)}\``).join(", ")}), so "the richest scene" does not settle it on its own.`,
    );
  }
  if (report.otherEnabled > 0) {
    const parts = [`- ${report.otherEnabled} other scenes are enabled in Build Settings`];
    if (report.scaffolding.length > 0) {
      parts.push(
        `; ${report.scaffolding.length} of them match the shape of verification scaffolding ` +
          `(name, or fewer than ${MIN_GAME_OBJECTS} GameObjects): ${nameList(report.scaffolding)}`,
      );
    }
    if (report.unclassified.length > 0) {
      parts.push(
        `; ${report.unclassified.length} match neither rule and are NOT called scaffolding: ` +
          nameList(report.unclassified),
      );
    }
    if (report.unreadable.length > 0) {
      parts.push(`; ${report.unreadable.length} could not be read and were classified as neither`);
    }
    parts.push(
      ". Removing them from Build Settings is a decision for you — this system does not delete scenes.",
    );
    lines.push(parts.join(""));
  }
  return lines.join("\n");
}
