/**
 * The campaign replay fixture's exporter (GDD-drift plan W16a).
 *
 * The replay tests judge a finished campaign again from what its databases
 * hold, so the fixture has to carry every system stamp the milestone tips
 * hold — not only the 500-character excerpt the campaign kept (18d4t's m4
 * stamp is visible only in its tip) — while carrying nothing that must not be
 * committed: identities, home paths, keys, and the approved GDD's own text.
 * The live databases are read and never written.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  countStamps,
  exportCampaignFixture,
  loadProductionModules,
  scanFixture,
  sectionRefsOf,
  stampPiecesOf,
} from "../../scripts/eval/export-campaign-fixture.mjs";
import { CampaignStorage } from "../../src/campaign/campaign-storage.js";
import { TaskStorage } from "../../src/tasks/task-storage.js";
import { TaskStatus, type Task, type TaskId } from "../../src/tasks/types.js";
import type { Campaign, CampaignMilestone } from "../../src/campaign/types.js";
import { getResilienceMessage } from "../../src/agents/resilience-messages.js";

// fileURLToPath, not `.pathname`: on Windows that is "/D:/..." and resolves to "D:\D:\...".
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPO_ROOT, "scripts", "eval", "export-campaign-fixture.mjs");
// Under tests/, not src/: the build copies every tracked .json under src/ into
// the published package.
const FIXTURE_18D4T = join(REPO_ROOT, "tests", "fixtures", "campaigns", "campaign-18d4t.json");

const STUCK = getResilienceMessage("task_stuck", "en");
const STUCK_TR = getResilienceMessage("task_stuck", "tr");
const ABORT = getResilienceMessage("provider_abort", "en");
const FLAGS = "[VERIFIER FLAGS — unresolved; this node was NOT positively verified]";
// Built at run time so no key-shaped literal sits in the repository.
const FAKE_KEY = `sk-proj-${"A1b2C3d4".repeat(4)}`;
const FAKE_HOME = "/Users/alice";
const GDD_TEXT =
  "# Sentinel GDD\n\nArt questions: art@example.org\n\n## 3.3 Core Rules\nR-01 GDD-BODY-SENTINEL the shooter must fire at the lowest cube.\n";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function task(id: string, createdAt: number, fields: Partial<Task> = {}): Task {
  return {
    id: id as TaskId,
    chatId: "chat-SENTINEL-CHAT",
    channelType: "cli",
    userId: "user-SENTINEL-USER",
    title: `Milestone task ${id}`,
    status: TaskStatus.completed,
    prompt: "PROMPT-SENTINEL",
    progress: [],
    createdAt,
    updatedAt: createdAt,
    ...fields,
  } as Task;
}

/** m1's newest retry: two back-to-back stamps, a cut one, a Turkish one and an outage stamp. */
const M1_TIP_RESULT = [
  // A result that starts mid-stamp, the way 18d4t's m1 excerpt does.
  STUCK.slice(STUCK.indexOf("fter multiple")),
  "",
  "**Stop reflecting and edit Assets/Scripts/PlayfieldBuilder.cs.**",
  "",
  FLAGS,
  `- verification_skipped: the reviewer quoted ${FAKE_KEY} from ${FAKE_HOME}/Games/.env`,
  "",
  STUCK,
  "",
  STUCK,
  "",
  "worker prose that is not evidence, line one",
  "worker prose that is not evidence, line two",
  "worker prose that is not evidence, line three",
  "",
  STUCK_TR,
  "",
  ABORT,
  "",
  "closing worker prose",
].join("\n");

/**
 * m2's tip: one stamp at the top, then more worker prose than the excerpt
 * keeps, stored cut by the sanitizer the way 18d4t's m2 and m7 tips are.
 */
const M2_FILLER = Array.from({ length: 30 }, (_, i) => `filler line ${i} — the worker kept talking about the board`);
const M2_TIP_RESULT = `${[STUCK, "", "**Make a targeted change to LevelData.cs.**", "", ...M2_FILLER].join("\n")}\n... (truncated)`;

function milestone(fields: Partial<CampaignMilestone> & Pick<CampaignMilestone, "id">): CampaignMilestone {
  return { title: `Sprint ${fields.id}`, prompt: "", status: "green", attempts: 1, ...fields } as CampaignMilestone;
}

function seedCampaign(path: string): void {
  const storage = new CampaignStorage(path);
  try {
    const campaign: Campaign = {
      id: "campaign_synthetic_1",
      chatId: "chat-SENTINEL-CHAT",
      channelType: "cli",
      userId: "user-SENTINEL-USER",
      projectRoot: `${FAKE_HOME}/Games/SentinelGame`,
      state: "done",
      ideaText: "IDEA-SENTINEL a cozy puzzle game",
      gddPath: "docs/GDD.md",
      gddText: GDD_TEXT,
      draftAttempts: 0,
      milestones: [
        milestone({
          id: "m1",
          prompt: "Read docs/GDD.md and implement §2.5, §3.1–§3.2, §15.1 and §13.2–§13.3. PROMPT-SENTINEL",
          taskId: "task_m1_root",
          timeBoxEscalations: 2,
          resultExcerpt: M1_TIP_RESULT.slice(-500),
        }),
        milestone({
          id: "m2",
          prompt: "Implement §3.3–§3.11 completely. PROMPT-SENTINEL",
          taskId: "task_m2",
          visualEvidenceBounced: true,
          resultExcerpt: M2_TIP_RESULT.slice(-500),
          // The runtime writes the project root home-relative; 18d4t's m7 does.
          visualConformance: "Judged from `~/Games/SentinelGame/Recordings/frame_00119.png` by openai.",
        }),
        milestone({ id: "m3", prompt: "Implement §4 and §5: boosters.", taskId: "task_never_written" }),
      ],
      currentMilestone: 3,
      createdAt: 1_000,
      updatedAt: 2_000,
      lastError: "ask alice@example.com why m3 never ran",
      deliveryReported: true,
    } as Campaign;
    storage.save(campaign);
  } finally {
    storage.close();
  }
  // An older database: a column this binary would add on a writable open, and
  // a rollback journal a writable open would switch to WAL. Either rewrites
  // the file, so the byte comparison below catches any open that is not
  // read-only.
  const db = new Database(path);
  db.exec("ALTER TABLE campaigns DROP COLUMN verified_sessions");
  db.pragma("journal_mode = DELETE");
  db.close();
}

function seedTasks(path: string): void {
  const storage = new TaskStorage(path);
  storage.initialize();
  try {
    storage.save(task("task_m1_root", 10, { result: "the first attempt said nothing useful" }));
    storage.save(task("task_m1_retry", 20, { parentId: "task_m1_root" as TaskId, result: M1_TIP_RESULT }));
    storage.setVerification(
      "task_m1_retry" as TaskId,
      JSON.stringify({ testsGreen: false, detail: `log at ${FAKE_HOME}/Library/Logs/Unity/Editor.log` }),
    );
    storage.save(task("task_m2", 30, { result: M2_TIP_RESULT }));
  } finally {
    storage.close();
  }
  const db = new Database(path);
  db.pragma("journal_mode = DELETE");
  db.close();
}

function fileState(path: string): { sha: string; mtimeMs: number } {
  return { sha: sha256(readFileSync(path).toString("binary")), mtimeMs: statSync(path).mtimeMs };
}

describe("export-campaign-fixture", () => {
  let dir: string;
  let campaignsDb: string;
  let tasksDb: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "campaign-fixture-"));
    campaignsDb = join(dir, "campaigns.db");
    tasksDb = join(dir, "tasks.db");
    seedCampaign(campaignsDb);
    seedTasks(tasksDb);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const exportSynthetic = async (opts: { includeGddText?: boolean } = {}) =>
    exportCampaignFixture({
      campaignsDbPath: campaignsDb,
      tasksDbPath: tasksDb,
      campaignId: "campaign_synthetic_1",
      home: FAKE_HOME,
      ...opts,
    });

  it("reads both databases read-only: neither file changes, even on an older schema", async () => {
    const before = { campaigns: fileState(campaignsDb), tasks: fileState(tasksDb) };
    await exportSynthetic();
    expect(fileState(campaignsDb)).toEqual(before.campaigns);
    expect(fileState(tasksDb)).toEqual(before.tasks);
  });

  it("follows each milestone's lineage to its newest task and carries its verification as data", async () => {
    const fixture = await exportSynthetic();
    const [m1, m2, m3] = fixture.milestones;
    expect(m1.taskId).toBe("task_m1_root");
    expect(m1.tip.id).toBe("task_m1_retry");
    expect(m1.tip.status).toBe("completed");
    expect(m1.tip.verification).toEqual({ testsGreen: false, detail: "log at ~/Library/Logs/Unity/Editor.log" });
    expect(m2.tip.id).toBe("task_m2");
    expect(m2.tip.verification).toBeNull();
    // A milestone whose task is gone says so instead of looking clean.
    expect(m3.tip).toEqual({ id: "task_never_written", missing: true });
  });

  it("counts every stamp in the FULL tip result: the cut one, back-to-back ones, other locales and outages", async () => {
    const fixture = await exportSynthetic();
    expect(fixture.milestones[0].tip.stamps).toEqual({ task_stuck: 4, provider_abort: 1 });
    expect(fixture.milestones[0].tip.resultChars).toBe(M1_TIP_RESULT.length);
    expect(fixture.milestones[0].tip.resultSha256).toBe(sha256(M1_TIP_RESULT));
  });

  it("keeps a stamp the 500-character excerpt lost (18d4t's m4), and drops the prose around it", async () => {
    const fixture = await exportSynthetic();
    const m2 = fixture.milestones[1];
    expect(m2.resultExcerpt).not.toContain("I got stuck");
    expect(m2.tip.stamps).toEqual({ task_stuck: 1 });
    const kept = m2.tip.evidenceLines.map((l: { text: string }) => l.text);
    expect(kept).toContain(STUCK);
    expect(kept).toContain("**Make a targeted change to LevelData.cs.**");
    // Only the line the cut mark follows survives of the filler.
    expect(kept.filter((t: string) => t.startsWith("filler line"))).toEqual([M2_FILLER[29]]);
    expect(kept.at(-1)).toBe("... (truncated)");
  });

  it("says when the stored tip was itself cut, so its stamp counts read as a lower bound", async () => {
    const fixture = await exportSynthetic();
    expect(fixture.milestones[1].tip.resultCutInStorage).toBe(true);
    expect(fixture.milestones[0].tip).not.toHaveProperty("resultCutInStorage");
  });

  it("reduces a tip without losing a stamp: the kept lines decode to the full result's counts", async () => {
    const fixture = await exportSynthetic();
    const { getResilienceMessage: messages } = await loadProductionModules();
    const pieces = stampPiecesOf(messages);
    for (const m of fixture.milestones.filter((x: { tip: { missing?: boolean } }) => !x.tip.missing)) {
      const reduced = m.tip.evidenceLines.map((l: { text: string }) => l.text).join("\n");
      expect(countStamps(reduced, pieces), m.id).toEqual(m.tip.stamps);
    }
    const m1Kept = fixture.milestones[0].tip.evidenceLines.map((l: { text: string }) => l.text);
    // The marker and the line after it (the flag's reason) are evidence too.
    expect(m1Kept).toContain(FLAGS);
    expect(m1Kept.some((t: string) => t.startsWith("- verification_skipped:"))).toBe(true);
    expect(m1Kept).not.toContain("worker prose that is not evidence, line two");
  });

  it("drops the prompt but keeps its § references, and keeps the milestone's stored fields", async () => {
    const fixture = await exportSynthetic();
    const m1 = fixture.milestones[0];
    expect(m1).not.toHaveProperty("prompt");
    expect(m1.sectionRefs).toEqual(["§2.5", "§3.1–§3.2", "§15.1", "§13.2–§13.3"]);
    expect(m1.promptSha256).toBe(
      sha256("Read docs/GDD.md and implement §2.5, §3.1–§3.2, §15.1 and §13.2–§13.3. PROMPT-SENTINEL"),
    );
    expect(m1.timeBoxEscalations).toBe(2);
    expect(m1.status).toBe("green");
    expect(fixture.milestones[1].visualEvidenceBounced).toBe(true);
    expect(fixture.milestones[2].sectionRefs).toEqual(["§4", "§5"]);
  });

  // Included, the text is the replay's extraction input: the approved bytes, its address untouched.
  it("names the approved GDD by hash and leaves its text out unless asked", async () => {
    const fixture = await exportSynthetic();
    expect(fixture.gdd).toMatchObject({ path: "docs/GDD.md", chars: GDD_TEXT.length, sha256: sha256(GDD_TEXT) });
    expect(fixture.gdd).not.toHaveProperty("text");
    expect(JSON.stringify(fixture)).not.toContain("GDD-BODY-SENTINEL");

    const withText = await exportSynthetic({ includeGddText: true });
    expect(withText.gdd.text).toBe(GDD_TEXT);
    expect(withText.redaction.gddText).toBe("included");
  });

  it("carries no identity, home path, e-mail or key, and says what it redacted", async () => {
    const fixture = await exportSynthetic();
    const json = JSON.stringify(fixture);
    for (const sentinel of [
      "SENTINEL-CHAT",
      "SENTINEL-USER",
      "IDEA-SENTINEL",
      "PROMPT-SENTINEL",
      FAKE_HOME,
      "alice@example.com",
      FAKE_KEY,
    ]) {
      expect(json, sentinel).not.toContain(sentinel);
    }
    expect(fixture.campaign.projectName).toBe("SentinelGame");
    expect(fixture.campaign.lastError).toBe("ask <email> why m3 never ran");
    expect(fixture.milestones[1].visualConformance).toBe(
      "Judged from `<project>/Recordings/frame_00119.png` by openai.",
    );
    expect(json).not.toContain("~/Games/SentinelGame");
    expect(fixture.redaction.secretsFound).toBeGreaterThanOrEqual(1);
    expect(fixture.redaction.homePaths).toBeGreaterThanOrEqual(2);
    expect(fixture.redaction.emails).toBe(1);
    const { applySecretPatterns, DEFAULT_SECRET_PATTERNS } = await loadProductionModules();
    expect(scanFixture(fixture, { applySecretPatterns, DEFAULT_SECRET_PATTERNS }, FAKE_HOME)).toEqual([]);
  });

  it("scans for the project root in every spelling, the home-relative one included", async () => {
    const mods = await loadProductionModules();
    const root = `${FAKE_HOME}/Games/SentinelGame`;
    expect(scanFixture({ note: "see ~/Games/SentinelGame/Recordings/a.png" }, mods, FAKE_HOME, root)).toEqual([
      { kind: "projectPaths" },
    ]);
  });

  it("writes nothing when a secret survives the redactor: the scan after it is a backstop, not a report", async () => {
    const mods = await loadProductionModules();
    const broken = { ...mods, redactSecretsDeep: <T>(value: T): T => value };
    await expect(
      exportCampaignFixture({
        campaignsDbPath: campaignsDb,
        tasksDbPath: tasksDb,
        campaignId: "campaign_synthetic_1",
        home: FAKE_HOME,
        modules: broken,
      }),
    ).rejects.toMatchObject({ name: "FixtureLeakError", findings: expect.arrayContaining([expect.objectContaining({ kind: "secret" })]) });
  });

  it("reads § references the way prompts write them", () => {
    expect(sectionRefsOf("implement §6, Appendix B, §3.5, §16.1–§16.2. and §8.1 - §8.4; again §6")).toEqual([
      "§6",
      "§3.5",
      "§16.1–§16.2",
      "§8.1–§8.4",
    ]);
    expect(sectionRefsOf(undefined)).toEqual([]);
  });

  it("CLI: writes the same bytes the API builds, and refuses a campaign that is not there", () => {
    const out = join(dir, "fixture.json");
    const args = ["--campaigns-db", campaignsDb, "--tasks-db", tasksDb, "--campaign", "campaign_synthetic_1", "--out", out];
    const ok = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    const first = readFileSync(out, "utf8");
    expect(JSON.parse(first).milestones[0].tip.stamps).toEqual({ task_stuck: 4, provider_abort: 1 });
    // Reproducible: a second export of the same databases is byte-identical.
    const again = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(first);

    const missing = spawnSync(
      process.execPath,
      [CLI, "--campaigns-db", campaignsDb, "--tasks-db", tasksDb, "--campaign", "campaign_nope", "--out", join(dir, "x.json")],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("campaign_nope");
    expect(existsSync(join(dir, "x.json"))).toBe(false);
  }, 60_000);
});

/**
 * The committed fixture of campaign 18d4t, exported once from the live
 * databases. These are the counts the M2/M3 plan measured there; the replay
 * tests read this file, so it has to keep saying them.
 */
describe("the committed 18d4t fixture", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_18D4T, "utf8"));
  const byId = (id: string) => fixture.milestones.find((m: { id: string }) => m.id === id);

  it("holds the stamps the plan measured on each milestone's tip", () => {
    expect(fixture.campaign.id).toBe("campaign_1787904962170_18d4t");
    expect(byId("m1").tip.stamps).toEqual({ task_stuck: 3 });
    expect(byId("m2").tip.stamps).toEqual({ task_stuck: 6 });
    expect(byId("m3").tip.stamps).toEqual({});
    expect(byId("m4").tip.stamps).toEqual({ task_stuck: 1 });
    expect(byId("m5").tip.stamps).toEqual({ task_stuck: 1 });
    expect(byId("m6").tip.stamps).toEqual({ task_stuck: 10, provider_abort: 1 });
    // m4's stamp is in its tip only: the stored excerpt never showed it.
    expect(byId("m4").resultExcerpt).not.toContain("I got stuck");
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) expect(byId(id).status, id).toBe("green");
    expect(byId("m6").timeBoxEscalations).toBe(2);
    expect(byId("m2").sectionRefs).toContain("§3.3–§3.11");
    // m2's six are what tasks.db kept: its result, like m7's, was stored cut.
    expect(byId("m2").tip.resultCutInStorage).toBe(true);
    expect(byId("m7").tip.resultCutInStorage).toBe(true);
    // No tip carries verification_json (the plan's fact 1); the field says so instead of being absent.
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) expect(byId(id).tip.verification, id).toBeNull();
  });

  it("decodes to the same stamps from its kept lines alone", async () => {
    const { getResilienceMessage: messages } = await loadProductionModules();
    const pieces = stampPiecesOf(messages);
    for (const m of fixture.milestones) {
      const reduced = m.tip.evidenceLines.map((l: { text: string }) => l.text).join("\n");
      expect(countStamps(reduced, pieces), m.id).toEqual(m.tip.stamps);
    }
  });

  it("is committed without the GDD's text, prompts, identities or keys", async () => {
    expect(fixture.gdd.text).toBeUndefined();
    expect(fixture.gdd.chars).toBeGreaterThan(70_000);
    expect(fixture.redaction.gddText).toBe("omitted");
    // The plan's rows need W04's extractor; the fixture says they are absent rather than look complete.
    expect(fixture.redaction.requirementRows).toMatch(/not exported/);
    for (const m of fixture.milestones) expect(m).not.toHaveProperty("prompt");
    const json = JSON.stringify(fixture);
    expect(json).not.toMatch(/\/Users\/|\/home\/|cli-user|cli-local/);
    // m7's visual verdict names the project home-relative; only <project> may remain.
    expect(json).not.toMatch(new RegExp(`~/[^"\\s]*${fixture.campaign.projectName}`));
    expect(json).toContain("`<project>/Recordings/");
    const { applySecretPatterns, DEFAULT_SECRET_PATTERNS } = await loadProductionModules();
    expect(scanFixture(fixture, { applySecretPatterns, DEFAULT_SECRET_PATTERNS })).toEqual([]);
  });
});
