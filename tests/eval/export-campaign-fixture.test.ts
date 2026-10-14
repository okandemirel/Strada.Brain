/**
 * The campaign replay fixture's exporter (GDD-drift plan W16a).
 *
 * The replay tests judge a finished campaign again from what its databases
 * hold, so the fixture has to carry every system stamp the milestone tips
 * hold — not only the 500-character excerpt the campaign kept (a measured
 * campaign's m4 stamp was visible only in its tip) — while carrying nothing that must not be
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
import { localFixturePath, missingLocalFixture } from "../../src/tests/helpers/local-fixtures.js";
import {
  SYNTHETIC_CAMPAIGN_ID,
  SYNTHETIC_GDD,
  SYNTHETIC_HOME,
  seedSyntheticCampaign,
} from "../fixtures/campaigns/synthetic-campaign.js";

// fileURLToPath, not `.pathname`: on Windows that is "/D:/..." and resolves to "D:\D:\...".
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPO_ROOT, "scripts", "eval", "export-campaign-fixture.mjs");
// Under tests/, not src/: the build copies every tracked .json under src/ into
// the published package.
const SYNTHETIC_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "campaigns", "synthetic-campaign.json");

const STUCK = getResilienceMessage("task_stuck", "en");
const STUCK_TR = getResilienceMessage("task_stuck", "tr");
const ABORT = getResilienceMessage("provider_abort", "en");
const FLAGS = "[VERIFIER FLAGS — unresolved; this node was NOT positively verified]";
// Built at run time so no key-shaped literal sits in the repository.
const FAKE_KEY = `sk-proj-${"A1b2C3d4".repeat(4)}`;
const FAKE_HOME = "/Users/alice";
const GDD_TEXT =
  "# Sentinel GDD\n\nArt questions: art@example.org\n\n## 2 Dome\nThe dome GDD-BODY-SENTINEL turns on a toothed rail.\n";

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
  // A result that starts mid-stamp, the way a measured m1 excerpt did.
  STUCK.slice(STUCK.indexOf("fter multiple")),
  "",
  "**Stop reflecting and edit Assets/Observatory/Shutter/ShutterMotor.cs.**",
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
 * keeps, stored cut by the sanitizer the way a measured campaign's m2 and m7 tips were.
 */
const M2_FILLER = Array.from({ length: 30 }, (_, i) => `filler line ${i} — the worker restated its plan`);
const M2_TIP_RESULT = `${[STUCK, "", "**Change the shutter timer, then rerun the dome checks.**", "", ...M2_FILLER].join("\n")}\n... (truncated)`;

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
      ideaText: "IDEA-SENTINEL a quiet stargazing game",
      gddPath: "docs/GDD.md",
      gddText: GDD_TEXT,
      draftAttempts: 0,
      milestones: [
        milestone({
          id: "m1",
          prompt: "Read docs/GDD.md, then build §2 and §5.1–§5.3 before §6. PROMPT-SENTINEL",
          taskId: "task_m1_root",
          timeBoxEscalations: 2,
          resultExcerpt: M1_TIP_RESULT.slice(-500),
        }),
        milestone({
          id: "m2",
          prompt: "Finish §3 and log what it changed. PROMPT-SENTINEL",
          taskId: "task_m2",
          visualEvidenceBounced: true,
          resultExcerpt: M2_TIP_RESULT.slice(-500),
          // The runtime writes the project root home-relative; a measured m7 did.
          visualConformance: "Judged from `~/Games/SentinelGame/Recordings/frame_00342.png` by openai.",
        }),
        milestone({ id: "m3", prompt: "Implement §1.2: the shutter.", taskId: "task_never_written" }),
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

  it("keeps a stamp the 500-character excerpt lost (as a measured m4's was), and drops the prose around it", async () => {
    const fixture = await exportSynthetic();
    const m2 = fixture.milestones[1];
    expect(m2.resultExcerpt).not.toContain("I got stuck");
    expect(m2.tip.stamps).toEqual({ task_stuck: 1 });
    const kept = m2.tip.evidenceLines.map((l: { text: string }) => l.text);
    expect(kept).toContain(STUCK);
    expect(kept).toContain("**Change the shutter timer, then rerun the dome checks.**");
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
    expect(m1.sectionRefs).toEqual(["§2", "§5.1–§5.3", "§6"]);
    expect(m1.promptSha256).toBe(
      sha256("Read docs/GDD.md, then build §2 and §5.1–§5.3 before §6. PROMPT-SENTINEL"),
    );
    expect(m1.timeBoxEscalations).toBe(2);
    expect(m1.status).toBe("green");
    expect(fixture.milestones[1].visualEvidenceBounced).toBe(true);
    expect(fixture.milestones[2].sectionRefs).toEqual(["§1.2"]);
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
      "Judged from `<project>/Recordings/frame_00342.png` by openai.",
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
    expect(sectionRefsOf("build §9, the star table, §2.3, §5.10–§5.14. and §1.1 - §1.3; again §9")).toEqual([
      "§9",
      "§2.3",
      "§5.10–§5.14",
      "§1.1–§1.3",
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
 * The committed replay fixture: what the exporter writes for the invented
 * campaign of tests/fixtures/campaigns/synthetic-campaign.ts. It carries the
 * shape a measured campaign showed — the replay tests read this file, so it
 * has to keep saying it.
 */
describe("the committed synthetic fixture", () => {
  // Read when a test asks, after the first one has had its chance to rewrite it (`-u`).
  let read: { milestones: Array<{ id: string } & Record<string, any>> } & Record<string, any>;
  const fixtureOf = () => (read ??= JSON.parse(readFileSync(SYNTHETIC_FIXTURE, "utf8")));
  const byId = (id: string) => fixtureOf().milestones.find((m) => m.id === id)!;

  it("is the exporter's output for the synthetic campaign, byte for byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "campaign-fixture-synthetic-"));
    try {
      const campaignsDb = join(dir, "campaigns.db");
      const tasksDb = join(dir, "tasks.db");
      seedSyntheticCampaign(campaignsDb, tasksDb);
      const exported = await exportCampaignFixture({
        campaignsDbPath: campaignsDb,
        tasksDbPath: tasksDb,
        campaignId: SYNTHETIC_CAMPAIGN_ID,
        home: SYNTHETIC_HOME,
      });
      // The CLI's own serialisation, so `--out` of the seeded databases writes this file.
      await expect(`${JSON.stringify(exported, null, 2)}\n`).toMatchFileSnapshot(SYNTHETIC_FIXTURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the stamps each milestone's tip carries", () => {
    expect(fixtureOf().campaign.id).toBe(SYNTHETIC_CAMPAIGN_ID);
    expect(byId("m1").tip.stamps).toEqual({ task_stuck: 3 });
    expect(byId("m2").tip.stamps).toEqual({ task_stuck: 6 });
    expect(byId("m3").tip.stamps).toEqual({});
    expect(byId("m4").tip.stamps).toEqual({ task_stuck: 1 });
    expect(byId("m5").tip.stamps).toEqual({ task_stuck: 1 });
    expect(byId("m6").tip.stamps).toEqual({ task_stuck: 10, provider_abort: 1 });
    expect(byId("m7").tip.stamps).toEqual({ task_stuck: 1, provider_abort: 1 });
    // m4's stamp is in its tip only: the stored excerpt never showed it.
    expect(byId("m4").resultExcerpt).not.toContain("I got stuck");
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]) expect(byId(id).status, id).toBe("green");
    expect(byId("mcov1").status).toBe("failed");
    expect(byId("mcov1").tip.status).toBe("cancelled");
    expect(byId("m6").timeBoxEscalations).toBe(2);
    expect(byId("m2").sectionRefs).toContain("§5.1–§5.3");
    // m3's newest task is a retry, not the task the milestone recorded.
    expect(byId("m3").tip.id).not.toBe(byId("m3").taskId);
    // m2's six are what tasks.db kept: its result, like m7's, was stored cut.
    expect(byId("m2").tip.resultCutInStorage).toBe(true);
    expect(byId("m7").tip.resultCutInStorage).toBe(true);
    // Only m7's tip carries verification_json; the others say so instead of being absent.
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) expect(byId(id).tip.verification, id).toBeNull();
    expect(byId("m7").tip.verification).toMatchObject({ testsGreen: true });
  });

  it("decodes to the same stamps from its kept lines alone", async () => {
    const { getResilienceMessage: messages } = await loadProductionModules();
    const pieces = stampPiecesOf(messages);
    for (const m of fixtureOf().milestones) {
      const reduced = m.tip.evidenceLines.map((l: { text: string }) => l.text).join("\n");
      expect(countStamps(reduced, pieces), m.id).toEqual(m.tip.stamps);
    }
  });

  it("is committed without the GDD's text or its quoted passages, prompts, identities or keys", async () => {
    const fixture = fixtureOf();
    expect(fixture.gdd.text).toBeUndefined();
    expect(fixture.gdd.chars).toBe(SYNTHETIC_GDD.length);
    expect(fixture.redaction.gddText).toBe("omitted");
    // m7 and mcov1 each quote the GDD in a structure finding.
    expect(fixture.redaction.gddPassages).toBe(2);
    expect(JSON.stringify(fixture)).toContain("GDD says: …<GDD passage omitted>…");
    // The plan's rows need W04's extractor; the fixture says they are absent rather than look complete.
    expect(fixture.redaction.requirementRows).toMatch(/not exported/);
    for (const m of fixture.milestones) expect(m).not.toHaveProperty("prompt");
    const json = JSON.stringify(fixture);
    expect(json).not.toMatch(/\/Users\/|\/home\/|chat-synthetic|user-synthetic/);
    // m7's visual verdict names the project home-relative; only <project> may remain.
    expect(json).not.toMatch(new RegExp(`~/[^"\\s]*${fixture.campaign.projectName}`));
    expect(json).toContain("`<project>/Recordings/");
    const { applySecretPatterns, DEFAULT_SECRET_PATTERNS } = await loadProductionModules();
    expect(scanFixture(fixture, { applySecretPatterns, DEFAULT_SECRET_PATTERNS })).toEqual([]);
  });
});

/**
 * A real campaign's export, kept only on the machine that measured it: the
 * exporter's promises — stamps that survive the reduction, nothing that may
 * not be published — have to hold on real data too, not only on data written
 * to fit them.
 */
const LOCAL_EXPORT = localFixturePath("campaign-export.json");
describe.skipIf(!LOCAL_EXPORT)(
  `a real campaign export kept locally${LOCAL_EXPORT ? "" : ` (${missingLocalFixture("campaign-export.json", "an export-campaign-fixture.mjs export of a real campaign")})`}`,
  () => {
    const fixture = LOCAL_EXPORT ? JSON.parse(readFileSync(LOCAL_EXPORT, "utf8")) : undefined;

    it("decodes to the same stamps from its kept lines alone", async () => {
      const { getResilienceMessage: messages } = await loadProductionModules();
      const pieces = stampPiecesOf(messages);
      for (const m of fixture.milestones) {
        if (m.tip === null || m.tip.missing) continue;
        const reduced = m.tip.evidenceLines.map((l: { text: string }) => l.text).join("\n");
        expect(countStamps(reduced, pieces), m.id).toEqual(m.tip.stamps);
      }
    });

    it("carries no prompt, identity, home path or key", async () => {
      if (fixture.redaction.gddText === "omitted") expect(fixture.gdd?.text).toBeUndefined();
      for (const m of fixture.milestones) expect(m).not.toHaveProperty("prompt");
      // An included GDD is the approved bytes, never scrubbed (--include-gdd-text); the rest is evidence.
      const evidence = { ...fixture, gdd: fixture.gdd ? { ...fixture.gdd, text: undefined } : null };
      expect(JSON.stringify(evidence)).not.toMatch(/\/Users\/|\/home\//);
      const { applySecretPatterns, DEFAULT_SECRET_PATTERNS } = await loadProductionModules();
      expect(scanFixture(evidence, { applySecretPatterns, DEFAULT_SECRET_PATTERNS })).toEqual([]);
    });
  },
);
