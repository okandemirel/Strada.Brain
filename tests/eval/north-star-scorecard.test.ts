/**
 * The north-star scorecard (roadmap WP-0.2): scripts/eval/north-star-scorecard.mjs.
 *
 * Each rung and proof criterion must come out pass, fail or "not measured:
 * <cause>" from what the databases and the project tree hold — never from
 * prose. The databases here are written by production's own storage classes,
 * so the scorecard reads the schema the system actually writes; the projects
 * and campaigns are invented. Nothing in this file describes a real game.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  EXIT,
  VERDICT,
  formatReport,
  scoreNorthStar,
  stripCSharp,
} from "../../scripts/eval/north-star-scorecard.mjs";
import { CampaignStorage } from "../../src/campaign/campaign-storage.js";
import type { Campaign, CampaignMilestone } from "../../src/campaign/types.js";
import { TaskStorage } from "../../src/tasks/task-storage.js";
import { TaskStatus, type Task, type TaskId } from "../../src/tasks/types.js";
import { LearningStorage } from "../../src/learning/storage/learning-storage.js";
import { MetricsStorage } from "../../src/metrics/metrics-storage.js";
import { SqliteVaultStore } from "../../src/vault/sqlite-vault-store.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPO_ROOT, "scripts", "eval", "north-star-scorecard.mjs");

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const guid = (): string => randomBytes(16).toString("hex");

interface Card {
  rungs: Array<{ id: number; verdict: string; cause: string | null; checks: Array<{ ok: boolean | null; text: string }>; notes: string[]; measured: Record<string, unknown> }>;
  criteria: Array<{ id: string; verdict: string; cause: string | null; checks: Array<{ ok: boolean | null; text: string }> }>;
  score: { rungs: { pass: number; fail: number; notMeasured: number } };
  scope: { proofCampaign: string | null };
  sources: Record<string, unknown>;
}

const rung = (card: Card, id: number) => card.rungs.find((r) => r.id === id)!;
const criterion = (card: Card, id: string) => card.criteria.find((c) => c.id === id)!;

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/** A C# file plus the .meta Unity writes next to it; returns the script guid. */
function script(root: string, rel: string, source: string): string {
  const id = guid();
  write(root, { [rel]: source, [`${rel}.meta`]: `fileFormatVersion: 2\nguid: ${id}\n` });
  return id;
}

function asset(root: string, rel: string, body: string): string {
  const id = guid();
  write(root, { [rel]: `%YAML 1.1\n--- !u!114 &11400000\nMonoBehaviour:\n${body}`, [`${rel}.meta`]: `fileFormatVersion: 2\nguid: ${id}\n` });
  return id;
}

/** An invented, Strada-conformant project: every check the tree can answer holds. */
function cleanProject(root: string): void {
  const config = script(
    root,
    "Assets/Modules/Beacon/Scripts/BeaconModuleConfig.cs",
    `using Strada.Core.Modules;
namespace Invented.Beacon
{
    public sealed class BeaconModuleConfig : ModuleConfig
    {
        protected override void Configure(IModuleBuilder builder)
        {
            builder.RegisterService<IBeaconService, BeaconService>();
        }
    }
}
`,
  );
  script(
    root,
    "Assets/Modules/Beacon/Scripts/BeaconService.cs",
    `using Strada.Core.Patterns;
namespace Invented.Beacon
{
    public interface IBeaconService { void Sweep(); }
    public sealed class BeaconService : Service, IBeaconService
    {
        // A literal holding "//" and a brace must not end the line or open a block.
        private const string Probe = "http://example.invalid/{";
        public void Sweep() { UnityEngine.Application.targetFrameRate = 60; }
    }
}
`,
  );
  script(
    root,
    "Assets/Modules/Beacon/Scripts/BeaconSystem.cs",
    `using Strada.Core.ECS;
namespace Invented.Beacon
{
    public struct BeamComponent : IComponent { public float Angle; }
    public sealed class BeaconSystem : SystemBase
    {
        protected override void OnUpdate(float deltaTime)
        {
            ForEach<BeamComponent>((int entity, ref BeamComponent beam) => { beam.Angle += deltaTime; });
        }
    }
}
`,
  );
  script(
    root,
    "Assets/Modules/Beacon/Scripts/BeaconScreens.cs",
    `using Strada.Core.Modules;
using Strada.Modules.Screen;
namespace Invented.Beacon
{
    public sealed class BeaconScreens { private readonly IScreenService _screens; }
}
`,
  );
  const moduleAsset = asset(root, "Assets/Settings/BeaconModuleConfig.asset", `  m_Script: {fileID: 11500000, guid: ${config}, type: 3}\n  m_Name: BeaconModuleConfig\n`);
  const gameConfig = asset(
    root,
    "Assets/Settings/GameConfig.asset",
    `  m_Script: {fileID: 11500000, guid: ${guid()}, type: 3}\n  _modules:\n  - _config: {fileID: 11400000, guid: ${moduleAsset}, type: 2}\n    _enabled: 1\n`,
  );
  const clip = guid();
  const pipeline = guid();
  write(root, {
    "Assets/Scenes/Harbor.unity": `--- !u!114 &1\nMonoBehaviour:\n  _gameConfig: {fileID: 11400000, guid: ${gameConfig}, type: 2}\n`,
    "Assets/Scenes/Harbor.unity.meta": `fileFormatVersion: 2\nguid: ${guid()}\n`,
    "Assets/Audio/chime.wav": "RIFF",
    "Assets/Audio/chime.wav.meta": `fileFormatVersion: 2\nguid: ${clip}\n`,
    "Assets/Prefabs/Sound.prefab": `AudioSource:\n  m_audioClip: {fileID: 8300000, guid: ${clip}, type: 3}\n`,
    "ProjectSettings/EditorBuildSettings.asset": "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Harbor.unity\n    guid: 0\n",
    "ProjectSettings/ProjectSettings.asset": [
      "PlayerSettings:",
      "  defaultScreenOrientation: 0",
      "  companyName: Invented Studio",
      "  productName: Beacon Keeper",
      "  allowedAutorotateToLandscapeRight: 0",
      "  allowedAutorotateToLandscapeLeft: 0",
      "  applicationIdentifier:",
      "    Android: com.invented.beaconkeeper",
      "    iPhone: com.invented.beaconkeeper",
      "  buildNumber: {}",
      "",
    ].join("\n"),
    "ProjectSettings/GraphicsSettings.asset": `GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 11400000, guid: ${pipeline}, type: 2}\n`,
    "ProjectSettings/QualitySettings.asset": [
      "QualitySettings:",
      "  m_QualitySettings:",
      "  - serializedVersion: 4",
      "    name: Low",
      `    customRenderPipeline: {fileID: 11400000, guid: ${pipeline}, type: 2}`,
      "  - serializedVersion: 4",
      "    name: High",
      `    customRenderPipeline: {fileID: 11400000, guid: ${pipeline}, type: 2}`,
      "",
    ].join("\n"),
    "Packages/manifest.json": JSON.stringify({
      dependencies: { "com.unity.render-pipelines.universal": "17.0.3", "com.strada.modules": "file:../Vendor/Strada.Modules" },
    }),
    "Builds/BeaconKeeper.apk": "apk",
  });
}

/** An invented project that breaks each conformance measure once. */
function brokenProject(root: string): void {
  script(
    root,
    "Assets/Modules/Orchard/Scripts/OrchardModuleConfig.cs",
    `using Strada.Core.Modules;
public sealed class OrchardModuleConfig : ModuleConfig
{
    protected override void Configure(IModuleBuilder builder) { builder.RegisterService<IGroveService, GroveService>(); }
}
`,
  );
  script(root, "Assets/Modules/Orchard/Scripts/OrchardService.cs", "using Strada.Core.Patterns;\npublic sealed class OrchardService : Service { }\n");
  script(
    root,
    "Assets/Modules/Orchard/Scripts/OrchardSystem.cs",
    `using Strada.Core.ECS;
public sealed class OrchardSystem : SystemBase
{
    protected override void OnUpdate(float deltaTime)
    {
        // TODO: Implement system logic
        // ForEach<PickerComponent>((int entity, ref PickerComponent p) => { });
        /* nothing here yet { } */
    }
}
`,
  );
  // The same service again in another module: a parallel implementation.
  script(root, "Assets/Modules/Grove/Scripts/OrchardService.cs", "using Strada.Core.Patterns;\nnamespace Grove { public sealed class OrchardService : Service { } }\n");
  script(root, "Assets/Modules/Grove/Scripts/GroveService.cs", "using Strada.Core.Patterns;\npublic interface IGroveService { }\npublic sealed class GroveService : Service, IGroveService { }\n");
  script(root, "Assets/Modules/Grove/Scripts/GroveSystem.cs", "using Strada.Core.ECS;\npublic sealed class GroveSystem : SystemBase { protected override void OnUpdate(float dt) { Tick(dt); } }\n");
  script(
    root,
    "Assets/Scripts/Finder.cs",
    `using UnityEngine;
// Strada.Core is named only in this comment.
public sealed class Finder : MonoBehaviour
{
    private void Start()
    {
        var self = FindObjectOfType<Finder>();
        var grove = new GroveService();
        var label = "Strada.Core";
    }
}
`,
  );
  // Tests are not game code: a third OrchardService there is no duplicate.
  script(root, "Assets/Tests/OrchardTests.cs", "public sealed class OrchardService { }\n");
}

function milestone(id: string, fields: Partial<CampaignMilestone> = {}): CampaignMilestone {
  return { id, title: `Sprint ${id}`, prompt: "(synthetic)", status: "green", attempts: 1, ...fields } as CampaignMilestone;
}

function row(rid: string, kind: string, owner: string | null, fields: Record<string, unknown> = {}) {
  return {
    rid,
    encoded: rid,
    text: `invented requirement ${rid}`,
    section: "3",
    line: 1,
    span: { start: 0, end: 1 },
    kind,
    source: "extracted",
    ...(owner ? { owner, ownership: [{ milestoneId: owner, reason: "covered-section", atMs: T0 }] } : { ownership: [] }),
    status: "passing",
    checks: [],
    gddRevision: 1,
    construct: "SystemBase",
    ...fields,
  };
}

function ledger(rows: unknown[]) {
  return { version: 1, gddSha256: "0".repeat(64), gddRevision: 1, extractedAtMs: T0, rows, overflow: { count: 0, sections: [] }, numberingGaps: [], llmAdded: 0 };
}

function campaign(fields: Partial<Campaign>): Campaign {
  return {
    id: "campaign_x",
    chatId: "chat-invented",
    channelType: "cli",
    userId: "user-invented",
    projectRoot: "/nonexistent/invented-project",
    state: "executing",
    draftAttempts: 0,
    milestones: [],
    currentMilestone: 0,
    createdAt: T0,
    updatedAt: T0 + 10 * HOUR,
    ...fields,
  } as Campaign;
}

function task(id: string, createdAt: number, fields: Partial<Task> = {}): Task {
  return {
    id: id as TaskId,
    chatId: "chat-invented",
    channelType: "cli",
    userId: "user-invented",
    title: `Task ${id}`,
    status: TaskStatus.completed,
    prompt: "(synthetic)",
    progress: [],
    origin: "user",
    createdAt,
    updatedAt: createdAt,
    ...fields,
  } as Task;
}

const PROOF_ID = "campaign_1800000000000_beacn";
const RUN = { admitted: true, revision: "rev-b", expected: ["Lit_lane_saves_ship"], total: 1, failedNames: [], unattributed: 0, flaky: [], acceptanceCompileErrors: [], tamper: [], failures: [] };
const WRITER = { provider: "second-provider", model: "model-b", independence: "different-model" };

/** Databases of a campaign that did everything the north star asks. */
function seedProof(memory: string, opts: { ownerMessageDuringRun?: boolean } = {}): void {
  const play = { found: true, ok: true, sessions: [{ index: 0, outcome: "Won" }, { index: 1, outcome: "Lost" }], inputRoute: "input" };
  const storage = new CampaignStorage(join(memory, "campaigns.db"));
  try {
    storage.save(
      campaign({
        id: PROOF_ID,
        state: "done",
        ideaText: "make a calm orchard game where you drag a cart between rows, 3 levels",
        gddPath: "docs/Orchard_GDD.md",
        deliveryReported: true,
        scopeGateSince: T0,
        updatedAt: T0 + 30 * HOUR,
        milestones: [
          milestone("m1", { compileVerdict: { ok: true, ran: true }, placeholderArtAtStart: { sprites: 4, placeholders: 0 } }),
          milestone("m2", {
            compileVerdict: { ok: true, ran: true },
            buildVerdict: { ran: true, ok: true },
            playerRunsByTarget: [{ ok: true, detail: "launched" }],
            playthroughVerdict: play as CampaignMilestone["playthroughVerdict"],
          }),
        ],
        requirements: ledger([
          row("R1", "input", "m1"),
          row("R2", "rule", "m2"),
          row("A1", "aspiration", null, { status: "excluded" }),
          row("S9", "screen", null, { status: "excluded", excludedBecause: "deferred past the MVP" }),
        ]) as Campaign["requirements"],
      }),
    );
    for (const [i, id] of ["m1", "m2"].entries()) {
      storage.appendJudgement({
        campaignId: PROOF_ID,
        attemptKey: `${id}#1`,
        atMs: T0 + (i + 1) * HOUR,
        input: { milestoneId: id, mode: "on", revision: "rev-b", run: RUN, sources: [{ writer: WRITER }] } as never,
        judgement: { green: true, basis: "proven", caveats: [] },
      });
    }
  } finally {
    storage.close();
  }
  const tasks = new TaskStorage(join(memory, "tasks.db"));
  tasks.initialize();
  try {
    tasks.save(task("t-before", T0 - HOUR)); // the message that started it
    tasks.save(task("t-m1", T0 + HOUR, { campaignId: PROOF_ID }));
    tasks.save(task("t-m2", T0 + 2 * HOUR, { campaignId: PROOF_ID }));
    tasks.save(task("t-other-chat", T0 + 3 * HOUR, { chatId: "chat-elsewhere" }));
    if (opts.ownerMessageDuringRun) tasks.save(task("t-owner", T0 + 4 * HOUR));
  } finally {
    tasks.close();
  }
  const learningPath = join(memory, "learning.db");
  const learning = new LearningStorage(learningPath);
  learning.initialize();
  learning.close();
  const metrics = new MetricsStorage(learningPath);
  metrics.initialize();
  metrics.close();
  const db = new Database(learningPath);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, created_at, updated_at, tags, origin_session_id)
       VALUES ('ins-1', 'cart lane lesson', 'workflow_pattern', 'active', 0.8, 'cart lane', 'register the lane service', '[]', '{}', ?, ?, '["milestone:m1"]', 'run-1')`,
    ).run(now - 2 * HOUR, now - 2 * HOUR);
    db.prepare("INSERT INTO instinct_exposure_log (instinct_id, session_id, task_run_id, shown_at) VALUES ('ins-1', 'run-2', 't-m2', ?)").run(now - HOUR);
    db.prepare("INSERT INTO retrieval_metrics (id, retrieval_time_ms, instincts_scanned, scope_filtered, insights_returned, recorded_at) VALUES ('r1', 3, 9, 1, 2, ?)").run(now - HOUR);
    const obs = db.prepare("INSERT INTO observations (id, type, session_id, tool_name, success, timestamp) VALUES (?, 'success', 'run-2', ?, 1, ?)");
    obs.run("o1", "unity_build_player", now - HOUR);
    obs.run("o2", "unity_run_player", now - HOUR);
  } finally {
    db.close();
  }
}

/** Databases shaped like the measured state: campaigns from a GDD, no gate, retrieval that returns nothing. */
function seedToday(memory: string): void {
  const storage = new CampaignStorage(join(memory, "campaigns.db"));
  try {
    storage.save(campaign({ id: "campaign_a", state: "done", gddPath: "docs/Invented_GDD.md", deliveryReported: true, milestones: [milestone("m1"), milestone("m2")] }));
    storage.save(campaign({ id: "campaign_b", state: "failed", gddPath: "docs/Invented_GDD.md", createdAt: T0 + HOUR, milestones: [milestone("m1", { status: "failed" })] }));
    // Green in shadow is recorded and not acted on: it proves nothing.
    for (const id of ["m1", "m2"]) {
      storage.appendJudgement({
        campaignId: "campaign_a",
        attemptKey: `${id}#1`,
        atMs: T0 + HOUR,
        input: { milestoneId: id, mode: "shadow", revision: "rev-a", run: RUN, sources: [{ writer: WRITER }] } as never,
        judgement: { green: true, basis: "proven", caveats: [] },
      });
    }
  } finally {
    storage.close();
  }
  const tasks = new TaskStorage(join(memory, "tasks.db"));
  tasks.initialize();
  try {
    tasks.save(task("u1", T0 + HOUR, { status: TaskStatus.blocked }));
    tasks.save(task("u2", T0 + 2 * HOUR));
  } finally {
    tasks.close();
  }
  const learningPath = join(memory, "learning.db");
  const learning = new LearningStorage(learningPath);
  learning.initialize();
  learning.close();
  const metrics = new MetricsStorage(learningPath);
  metrics.initialize();
  metrics.close();
  const db = new Database(learningPath);
  try {
    const now = Date.now();
    const insert = db.prepare("INSERT INTO retrieval_metrics (id, retrieval_time_ms, instincts_scanned, scope_filtered, insights_returned, recorded_at) VALUES (?, 2, 40, 0, 0, ?)");
    for (const id of ["r1", "r2", "r3"]) insert.run(id, now - HOUR);
    db.prepare("INSERT INTO observations (id, type, session_id, tool_name, success, timestamp) VALUES ('o1', 'success', 's', 'unity_playmode_verify', 1, ?)").run(now);
  } finally {
    db.close();
  }
}

function seedVault(projectRoot: string, files: string[]): void {
  const dir = join(projectRoot, ".strada", "vault");
  mkdirSync(dir, { recursive: true });
  const store = new SqliteVaultStore(join(dir, "index.db"));
  try {
    store.migrate();
    for (const path of files) {
      store.upsertFile({ path, blobHash: "h", mtimeMs: T0, size: 1, lang: path.endsWith(".cs") ? "csharp" : "markdown", kind: path.endsWith(".cs") ? "source" : "doc", indexedAt: T0 });
    }
  } finally {
    store.close();
  }
}

const logLine = (fields: Record<string, unknown>): string =>
  `${JSON.stringify({ level: "info", message: "Loaded Strada.MCP tools into main toolchain", service: "strada-brain", ...fields })}\n`;

function hashDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  return out;
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ns-scorecard-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("north-star scorecard: a run that did everything", () => {
  function proofHome(opts: { ownerMessageDuringRun?: boolean } = {}) {
    const home = join(work, "home");
    const memory = join(home, ".strada-memory");
    mkdirSync(memory, { recursive: true });
    seedProof(memory, opts);
    writeFileSync(join(home, "strada-brain.log"), logLine({ registered: 111, bridgeState: "connected", sourcePath: "/invented/Strada.MCP", timestamp: "2099-01-01 00:00:00" }));
    const project = join(work, "BeaconKeeper");
    cleanProject(project);
    seedVault(project, [
      "Packages/Strada.Core/Documentation~/Modules.md",
      "Packages/Strada.Core/Runtime/Bootstrap/Bootstrapper.cs",
      "Packages/Strada.Modules/ScreenModule/Runtime/ScreenService.cs",
      "Packages/Strada.Core/README.md",
      "Assets/Modules/Beacon/Scripts/BeaconService.cs",
    ]);
    const upstream = join(work, "upstream");
    mkdirSync(join(upstream, "Strada.Core"), { recursive: true });
    return { home, memory, project, upstream };
  }

  it("passes all ten rungs, each on a measured number", () => {
    const { home, project, upstream } = proofHome();
    const card = scoreNorthStar({ home, project, upstream }) as Card;
    expect(card.rungs.map((r) => [r.id, r.verdict, r.cause])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i + 1, VERDICT.PASS, null]),
    );
    expect(rung(card, 2).checks[0]!.text).toBe("1 of 1 campaigns started from idea_text; 1 of them reached a plan");
    expect(rung(card, 3).checks[1]!.text).toBe(`${PROOF_ID}: 2 of 2 in-scope rows owned by a milestone of its plan`);
    expect(rung(card, 5).checks[0]!.text).toContain("2 of 2 green milestones were judged green on a proven basis by the scope gate in mode on");
    expect(rung(card, 9).checks.map((c) => c.text)).toEqual([
      "1 of 1 retrievals returned anything",
      "1 of 1 exposures showed a lesson to a later run than the one that learned it",
    ]);
    expect(rung(card, 10).checks[1]!.text).toMatch(/^0 owner messages in the campaign's chat between its start and .* \(2 tasks linked to it\)$/);
    expect(card.scope.proofCampaign).toBe(PROOF_ID);
  });

  it("judges the proof criteria from records, and keeps what no record holds as not measured", () => {
    const { home, project, upstream } = proofHome();
    const card = scoreNorthStar({ home, project, upstream }) as Card;
    const verdicts = Object.fromEntries(card.criteria.map((c) => [c.id, c.verdict]));
    expect(verdicts).toEqual({
      A: VERDICT.NOT_MEASURED,
      B: VERDICT.NOT_MEASURED,
      C: VERDICT.PASS,
      D: VERDICT.NOT_MEASURED,
      E: VERDICT.NOT_MEASURED,
      F: VERDICT.NOT_MEASURED,
      G: VERDICT.PASS,
      // No store holds assumption records: a missing mechanism fails, it is not "not measured".
      H: VERDICT.FAIL,
      I: VERDICT.NOT_MEASURED,
      J: VERDICT.PASS,
      K: VERDICT.PASS,
      L: VERDICT.NOT_MEASURED,
    });
    expect(criterion(card, "A").cause).toBe(
      "LLM calls per campaign are in no database this scorecard reads; restarts during gate work and their re-measurement are not recorded",
    );
    // Every check F can answer from the tree held; only the unanalysed ones remain.
    expect(criterion(card, "F").checks.filter((c) => c.ok === false)).toEqual([]);
  });

  it("fails rung 10 when the owner wrote to the campaign's chat while it ran", () => {
    const { home, project, upstream } = proofHome({ ownerMessageDuringRun: true });
    const card = scoreNorthStar({ home, project, upstream }) as Card;
    expect(rung(card, 10).verdict).toBe(VERDICT.FAIL);
    expect(rung(card, 10).checks[1]).toMatchObject({ ok: false, text: expect.stringMatching(/^1 owner message in the campaign's chat/) });
  });

  it("fails rung 1 on a boot older than HEAD", () => {
    const { home, project, upstream } = proofHome();
    writeFileSync(join(home, "strada-brain.log"), logLine({ registered: 111, bridgeState: "connected", timestamp: "2000-01-02 03:04:05" }));
    const card = scoreNorthStar({ home, project, upstream }) as Card;
    expect(rung(card, 1).verdict).toBe(VERDICT.FAIL);
    expect(rung(card, 1).checks[2]!.text).toMatch(/^the boot predates HEAD/);
  });

  it("opens every database read-only: not one byte of the memory directory changes", () => {
    const { home, memory, project, upstream } = proofHome();
    const before = hashDir(memory);
    scoreNorthStar({ home, project, upstream });
    expect(hashDir(memory)).toEqual(before);
  });

  it("prints JSON from the command line", () => {
    const { home, project, upstream } = proofHome();
    const res = spawnSync(process.execPath, [CLI, "--home", home, "--project", project, "--upstream", upstream, "--json"], { encoding: "utf8", cwd: REPO_ROOT });
    expect(res.status, res.stderr).toBe(EXIT.MEASURED);
    const card = JSON.parse(res.stdout) as Card;
    expect(card.score.rungs).toEqual({ pass: 10, fail: 0, notMeasured: 0 });
    expect(card.criteria.map((c) => c.id).join("")).toBe("ABCDEFGHIJKL");
  });

  it("refuses an unknown --campaign", () => {
    const { home } = proofHome();
    const res = spawnSync(process.execPath, [CLI, "--home", home, "--campaign", "campaign_none"], { encoding: "utf8", cwd: REPO_ROOT });
    expect(res.status).toBe(EXIT.USAGE);
    expect(res.stderr).toContain("campaign campaign_none is not in");
  });
});

describe("north-star scorecard: the measured state", () => {
  function todayHome() {
    const home = join(work, "home");
    const memory = join(home, ".strada-memory");
    mkdirSync(memory, { recursive: true });
    seedToday(memory);
    writeFileSync(join(home, "strada-brain.log"), logLine({ registered: 111, bridgeState: "disconnected", timestamp: "2000-01-02 03:04:05" }));
    const project = join(work, "Orchard");
    brokenProject(project);
    const upstream = join(work, "upstream");
    mkdirSync(join(upstream, "Strada.Core", "docs"), { recursive: true });
    writeFileSync(join(upstream, "Strada.Core", "docs", "Upgrade.md"), "upstream doc");
    seedVault(project, [
      "Packages/Strada.Core/Runtime/Bootstrap/Bootstrapper.cs",
      "Packages/Strada.Core/docs/Upgrade.md",
      "Packages/Strada.Core/notes/sprint-4-report.md",
      "Assets/Modules/Orchard/Scripts/OrchardService.cs",
    ]);
    return { home, project, upstream };
  }

  it("fails every rung with the number that failed it", () => {
    const { home, project, upstream } = todayHome();
    const card = scoreNorthStar({ home, project, upstream }) as Card;
    expect(card.score.rungs).toEqual({ pass: 0, fail: 10, notMeasured: 0 });
    expect(rung(card, 1).checks.map((c) => c.ok)).toEqual([true, false, false]);
    expect(rung(card, 2).checks[0]!.text).toBe("0 of 2 campaigns started from idea_text; 0 of them reached a plan");
    expect(rung(card, 3).checks[0]!.text).toBe("0 of 2 campaigns carry a requirement ledger");
    expect(rung(card, 5).checks[0]!.text).toBe(
      "0 of 2 green milestones were judged green on a proven basis by the scope gate in mode on (judgements: off 0, shadow 2, on 0)",
    );
    expect(rung(card, 9).checks[0]!.text).toBe("0 of 3 retrievals returned anything");
    expect(rung(card, 10).checks[0]!.text).toBe("2 campaigns, 1 done; 0 delivered with every milestone judged green on a proven basis by the scope gate in mode on");
  });

  it("measures Strada.Core conformance in the game's own code", () => {
    const { home, project, upstream } = todayHome();
    const r6 = rung(scoreNorthStar({ home, project, upstream }) as Card, 6);
    expect(r6.checks).toEqual([
      { ok: true, text: "the game declares 1 ModuleConfig subclass" },
      { ok: false, text: "1 type name declared in two or more modules (OrchardService)" },
      { ok: false, text: "1 of 2 systems have an empty OnUpdate (OrchardSystem)" },
      { ok: false, text: "2 of 3 services are never registered (OrchardService, OrchardService)" },
      { ok: false, text: "1 FindObject*/GameObject.Find calls in 1 file" },
      { ok: false, text: "1 `new *Service(` constructions in game code" },
    ]);
    // A Core namespace named only in a comment or a string is no reference.
    expect(r6.measured).toMatchObject({ gameFiles: 7, filesWithoutCore: 1 });
    const r7 = rung(scoreNorthStar({ home, project, upstream }) as Card, 7);
    expect(r7.checks.map((c) => c.text)).toEqual([
      "Strada.Modules is not installed in the project (no Packages folder or manifest entry)",
      "0 of 7 game files reference Strada.Modules",
    ]);
  });

  it("finds notes a run wrote into a framework copy, and only with upstream to compare", () => {
    const { home, project, upstream } = todayHome();
    const withUpstream = criterion(scoreNorthStar({ home, project, upstream }) as Card, "K");
    expect(withUpstream.checks.at(-1)).toEqual({ ok: false, text: "1 indexed notes sit inside framework folders and are not in upstream" });
    const without = criterion(scoreNorthStar({ home, project }) as Card, "K");
    expect(without.checks.at(-1)).toEqual({
      ok: null,
      text: "2 indexed notes inside framework folders cannot be told from upstream docs without --upstream",
    });
  });
});

describe("north-star scorecard: what it cannot read", () => {
  it("reports every rung as not measured, naming the missing source", () => {
    const home = join(work, "empty-home");
    mkdirSync(home);
    const card = scoreNorthStar({ home }) as Card;
    expect(card.score.rungs).toEqual({ pass: 0, fail: 0, notMeasured: 10 });
    const memory = join(home, ".strada-memory");
    expect(rung(card, 1).cause).toBe(`daemon log not found at ${join(home, "strada-brain.log")}`);
    expect(rung(card, 2).cause).toBe(`campaigns.db not read: campaigns.db not found at ${join(memory, "campaigns.db")}`);
    expect(rung(card, 6).cause).toBe("no --project was given");
    expect(rung(card, 9).cause).toBe(`learning.db not read: learning.db not found at ${join(memory, "learning.db")}`);
    const text = formatReport(card);
    expect(text).toContain(`One sentence starts a campaign: not measured: campaigns.db not read: campaigns.db not found at ${join(memory, "campaigns.db")}`);
    expect(text).toContain("Score: 0 of 10 rungs pass, 0 fail, 10 not measured");
  });

  it("counts retrievals that were rolled up past the retention period", () => {
    const path = join(work, "learning.db");
    const metrics = new MetricsStorage(path);
    metrics.initialize();
    metrics.close();
    const db = new Database(path);
    db.prepare("INSERT INTO retrieval_metrics_rollup (day_start, retrievals, retrieval_time_sum, instincts_scanned_sum, insights_returned_sum) VALUES (?, 40, 80, 400, 3)").run(T0);
    db.close();
    const card = scoreNorthStar({ home: join(work, "nohome"), learningDb: path }) as Card;
    expect(rung(card, 9).checks[0]).toEqual({ ok: true, text: "0 of 0 retrievals returned anything; 40 older retrievals rolled up with 3 insights returned in total" });
  });
});

describe("stripCSharp", () => {
  it("empties literals and drops comments without losing code around them", () => {
    const src = [
      'var url = "http://x/{"; var c = \'{\'; Call(); // trailing { comment',
      'var v = @"line ""quoted"" }"; /* block { */ Next();',
      'var i = $"{name} }"; Last();',
    ].join("\n");
    expect(stripCSharp(src)).toBe(['var url = ""; var c = \'\'; Call(); ', 'var v = "";  Next();', 'var i = ""; Last();'].join("\n"));
  });
});
