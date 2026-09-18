/**
 * Brain-side scenario contract for record.scenarios in a play-through verdict.
 * The producer must DRIVE and observe these operations, not infer them from a
 * session's outcome. No report means not-measured; a bare reached claim proves
 * nothing. Frame indices are zero-based in THIS verdict's captured-frame order.
 * Before/after must bracket the named operation, not arbitrary session frames.
 * This validates the reported evidence, not the pixels or save bytes themselves.
 */
import type { PlaythroughEvidence } from "./types.js";

export const PLAYTHROUGH_SCENARIOS = [
  { id: "menu-to-game", name: "menu → game" },
  { id: "win", name: "win" },
  { id: "lose", name: "lose" },
  { id: "save-load", name: "save/load" },
  { id: "scene-transition", name: "scene transition" },
] as const;

export type PlaythroughScenarioId = (typeof PLAYTHROUGH_SCENARIOS)[number]["id"];
export type PlaythroughScenarioStatus = "reached" | "refused" | "not-measured" | "not-reached";

/** Optional fields stay absent: zero and false are measurements, not defaults. */
export interface PlaythroughScenarioEvidence {
  startAccepted?: boolean;
  reached?: boolean;
  actions?: number;
  frames?: { before?: number; after?: number };
  reason?: string;
  missing?: string;
  outcome?: string;
  reachedOutcome?: boolean;
  /** menu-to-game: Menu -> Playing, observed at the two referenced frames. */
  fromState?: string;
  toState?: string;
  /** scene-transition: completed transition between distinct observed scenes. */
  transitionCompleted?: boolean;
  fromScene?: string;
  toScene?: string;
  /** save-load: completed save, then load of that save with matching state. */
  saveCompleted?: boolean;
  loadCompleted?: boolean;
  /**
   * Project-relative path of the save the run wrote and read back. Round 13
   * #32: a save id and a state hash are the producer's own words about game
   * state; the artifact is the only part of save/load this reader can check.
   * Absent means save/load is NOT MEASURED, never reached.
   */
  artifact?: string;
  saveId?: string;
  loadedSaveId?: string;
  savedStateHash?: string;
  loadedStateHash?: string;
}

/**
 * WHAT THE RUN LEFT ON DISK, as opposed to what the file says about itself.
 *
 * Codex round 13 #32: every field above is written by the producer, so a
 * verdict claiming `frames.count: 2`, indices 0 -> 1 and matching save ids of
 * `"x"` made save/load READ AS REACHED with no captures and no save artifact
 * anywhere. The numbers are a claim; the files are the evidence, and the
 * reader knows where they are (the verdict's own directory).
 */
export interface ScenarioEvidenceOnDisk {
  /** Frames actually captured beside this verdict, counted from the files. */
  readonly framesOnDisk?: number;

  /**
   * Is this project-relative artifact a real save whose bytes hash to what the
   * row claims? Absent = nothing can be checked, which is never proof.
   */
  readonly artifactExists?: (relativePath: string, expectedSha256: string | undefined) => boolean;
}

/** Wire row: record.scenarios is an array of these, parsed from unknown. */
export interface PlaythroughScenarioRecord extends PlaythroughScenarioEvidence {
  id: PlaythroughScenarioId;
}

export interface PlaythroughScenarioResult {
  id: PlaythroughScenarioId;
  status: PlaythroughScenarioStatus;
  evidence?: PlaythroughScenarioEvidence;
  reason?: string;
}

/** Additive view; existing callers using PlaythroughEvidence remain compatible. */
export interface ScenarioPlaythroughEvidence extends PlaythroughEvidence {
  scenarios?: PlaythroughScenarioResult[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseEvidence(row: Record<string, unknown>): PlaythroughScenarioEvidence {
  const evidence: PlaythroughScenarioEvidence = {};
  for (const key of ["reason", "missing", "outcome", "fromState", "toState", "fromScene", "toScene", "artifact", "saveId", "loadedSaveId", "savedStateHash", "loadedStateHash"] as const) {
    const value = str(row[key]);
    if (value !== undefined) evidence[key] = value;
  }
  for (const key of ["startAccepted", "reached", "reachedOutcome", "transitionCompleted", "saveCompleted", "loadCompleted"] as const) {
    const value = row[key];
    if (typeof value === "boolean") evidence[key] = value;
  }
  const actions = whole(row.actions);
  if (actions !== undefined) evidence.actions = actions;
  const frames = object(row.frames);
  if (frames !== undefined) {
    evidence.frames = {};
    for (const key of ["before", "after"] as const) {
      const value = whole(frames[key]);
      if (value !== undefined) evidence.frames[key] = value;
    }
  }
  return evidence;
}

/**
 * REACHED always needs explicit acceptance, observed reach, action and frames —
 * and the frames it names must EXIST. A claimed count beyond the files on disk
 * is not evidence of anything (round 13 #32).
 */
function reached(
  id: PlaythroughScenarioId,
  e: PlaythroughScenarioEvidence,
  count: unknown,
  disk: ScenarioEvidenceOnDisk,
): boolean {
  const claimed = whole(count);
  // The smaller of what the file claims and what the directory holds; when the
  // caller could not look, the claim alone proves nothing.
  const total = disk.framesOnDisk === undefined
    ? undefined
    : Math.min(claimed ?? 0, disk.framesOnDisk);
  // NOT a second index check (round 14 #12, judged NOT a defect): an index is a
  // POSITION in this verdict's capture order, not a file number, so `after <
  // total` above — where total is min(claimed, files present) — already says
  // every referenced position exists. A list-resolution on top of that was
  // unfalsifiable: no test could distinguish it, which is the sign it says
  // nothing. What WAS wrong is that directories named like captures counted;
  // the reader filters on file type now.
  const before = e.frames?.before;
  const after = e.frames?.after;
  if (e.startAccepted !== true || e.reached !== true || e.actions === undefined || e.actions <= 0) return false;
  if (total === undefined || before === undefined || after === undefined || before >= after || after >= total) return false;
  switch (id) {
    case "menu-to-game": return e.fromState === "Menu" && e.toState === "Playing";
    case "win": return e.outcome === "Won" && e.reachedOutcome === true;
    case "lose": return e.outcome === "Lost" && e.reachedOutcome === true;
    case "save-load": return e.saveCompleted === true && e.loadCompleted === true
      && e.saveId !== undefined && e.saveId === e.loadedSaveId
      && e.savedStateHash !== undefined && e.savedStateHash === e.loadedStateHash
      // The one part of save/load that is not the producer's own word: a real
      // save file whose bytes hash to the state the row says came back.
      && e.artifact !== undefined && disk.artifactExists !== undefined
      && disk.artifactExists(e.artifact, e.savedStateHash);
    case "scene-transition": return e.transitionCompleted === true
      && e.fromScene !== undefined && e.toScene !== undefined && e.fromScene !== e.toScene;
  }
}

function refused(e: PlaythroughScenarioEvidence): boolean {
  return e.startAccepted === false || e.outcome === "Refused" || e.missing !== undefined;
}

/**
 * Exactly one result per stable id. Unknown/invalid rows cannot name a scenario.
 * Duplicates cannot cherry-pick success: any refusal wins, otherwise ambiguous
 * duplicates are not-reached. A known but incomplete row is also not-reached.
 */
export function parsePlaythroughScenarios(
  raw: unknown,
  frameCount: unknown,
  disk: ScenarioEvidenceOnDisk = {},
): PlaythroughScenarioResult[] {
  const rows = Array.isArray(raw) ? raw.map(object).filter((row) => row !== undefined) : [];
  return PLAYTHROUGH_SCENARIOS.map(({ id }): PlaythroughScenarioResult => {
    const matches = rows.filter((row) => row.id === id).map(parseEvidence);
    if (matches.length === 0) return { id, status: "not-measured" };
    const denied = matches.find(refused);
    if (denied) return { id, status: "refused", evidence: denied, reason: denied.reason ?? denied.missing ?? "runner refused the scenario" };
    if (matches.length !== 1) return { id, status: "not-reached", reason: "duplicate scenario reports" };
    const evidence = matches[0]!;
    if (reached(id, evidence, frameCount, disk)) return { id, status: "reached", evidence };
    return {
      id,
      status: "not-reached",
      evidence,
      reason:
        evidence.reason
        ?? (disk.framesOnDisk === undefined
          ? "the captured frames beside the verdict were not inspected, so the frame claim proves nothing"
          : disk.framesOnDisk === 0
            ? "the verdict claims captured frames but none are on disk beside it"
            : id === "save-load" && evidence.artifact === undefined
              ? "no save artifact was named, so only the producer's own word says the state came back"

              : "required observations or captured frames are missing or contradictory"),
    };
  });
}

/**
 * Conservative mapping of whole, atomic GDD requirements. This vocabulary
 * proves these flows only: e.g. "win with 500 coins" is NOT proved by "win".
 * Semicolon-separated requirements require every clause; unknown clauses leave
 * the whole requirement unmapped/open. No keyword overlap or suite total closes
 * a feature. Richer/game-specific requirements need their own evidence contract.
 */
const REQUIREMENT_SCENARIOS: ReadonlyArray<{ pattern: RegExp; id: PlaythroughScenarioId }> = [
  { id: "menu-to-game", pattern: /^(?:menu (?:to )?(?:game|gameplay)|start (?:the )?game from (?:the )?(?:main )?menu)$/u },
  { id: "win", pattern: /^(?:win|victory|win (?:the )?(?:game|session)|reach (?:a )?(?:win|victory)(?: state)?)$/u },
  { id: "lose", pattern: /^(?:lose|defeat|lose (?:the )?(?:game|session)|reach (?:a )?(?:loss|defeat)(?: state)?)$/u },
  { id: "save-load", pattern: /^(?:save (?:and )?load(?: (?:game|progress))?|save (?:and )?restore progress)$/u },
  { id: "scene-transition", pattern: /^(?:scene transition|transition between scenes|change scenes)$/u },
];

export function scenariosForRequirement(requirement: string): PlaythroughScenarioId[] {
  const ids: PlaythroughScenarioId[] = [];
  for (const clause of requirement.split(";")) {
    const normalized = clause.toLowerCase().trim().replace(/[.!]$/u, "")
      .replace(/^(?:(?:the )?(?:player|game) )?(?:can|must|shall|should) /u, "")
      .replace(/(?:→|->)/gu, " to ").replace(/[-/]/gu, " ").replace(/\s+/gu, " ");
    const match = REQUIREMENT_SCENARIOS.find(({ pattern }) => pattern.test(normalized));
    if (!match) return [];
    if (!ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}

export function isRequirementShownByPlaythrough(requirement: string, verdict: ScenarioPlaythroughEvidence | undefined): boolean {
  if (!verdict?.found || verdict.ok !== true || verdict.stale || verdict.unreadable) return false;
  const ids = scenariosForRequirement(requirement);
  return ids.length > 0 && ids.every((id) => {
    const results = verdict.scenarios?.filter((row) => row.id === id) ?? [];
    return results.length === 1 && results[0]?.status === "reached";
  });
}

/** One human-readable line per scenario, including names a legacy runner omits. */
export function describePlaythroughScenarios(verdict: ScenarioPlaythroughEvidence | undefined): string {
  const results = verdict?.found && !verdict.stale && !verdict.unreadable ? verdict.scenarios : undefined;
  const lines = PLAYTHROUGH_SCENARIOS.map(({ id, name }) => {
    const result = results?.find((row) => row.id === id);
    const prefix = `scenario ${id}: `;
    if (!result || result.status === "not-measured") return `${prefix}not measured — ${name}`;
    if (result.status === "reached") return `${prefix}REACHED — ${name} shown; frames #${result.evidence?.frames?.before ?? "?"} → #${result.evidence?.frames?.after ?? "?"}`;
    return `${prefix}${result.status === "refused" ? "REFUSED" : "NOT REACHED"} — ${name}; ${result.reason ?? "no reason recorded"}`;
  });
  const unmeasured = !results || results.every((row) => row.status === "not-measured");
  return (unmeasured ? ["scenarios not measured", ...lines] : lines).join("\n");
}
