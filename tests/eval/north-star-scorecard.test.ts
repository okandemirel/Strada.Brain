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
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import {
  EXIT,
  VERDICT,
  defaultPaths,
  formatReport,
  scoreNorthStar,
  stripCSharp,
} from "../../scripts/eval/north-star-scorecard.mjs";
import { resolveRuntimePaths } from "../../src/common/runtime-paths.js";
import { CampaignStorage } from "../../src/campaign/campaign-storage.js";
import type { Campaign, CampaignMilestone } from "../../src/campaign/types.js";
import { TaskStorage } from "../../src/tasks/task-storage.js";
import { TaskStatus, type Task, type TaskId } from "../../src/tasks/types.js";
import { LearningStorage } from "../../src/learning/storage/learning-storage.js";
import type { Instinct } from "../../src/learning/types.js";
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
      "  productName: Thistle Mill",
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

interface ProofOptions {
  ownerMessageDuringRun?: boolean;
  /** The session that minted the lesson (instincts.origin_session_id); production writes none. */
  lessonOrigin?: string;
  /**
   * The records rungs 4, 8 and 9 need and no production code writes yet: a
   * framework construct on each ledger row, the play-through's input route, and
   * the lesson's origin session. Without this the fixture is what production writes.
   */
  futureRecords?: boolean;
}

/** Databases of a campaign that did everything the north star asks. */
function seedProof(memory: string, opts: ProofOptions = {}): void {
  const play = {
    found: true,
    ok: true,
    sessions: [{ index: 0, outcome: "Won" }, { index: 1, outcome: "Lost" }],
    ...(opts.futureRecords ? { inputRoute: "input" } : {}),
  };
  // The construct a row maps to is read from its own acceptance check, not
  // claimed on the row: a check may not use reflection, so the framework types
  // its body names are what the row's behaviour went through
  // (src/campaign/acceptance-constructs.ts).
  const construct = opts.futureRecords
    ? {
        checks: [
          {
            kind: "test",
            testName: "Strada.Acceptance.M1.Acceptance_M1.R1",
            path: "Assets/StradaAcceptance/Acceptance_M1.cs",
            bodySha: "a".repeat(64),
            constructs: ["Strada.Core.DI:Game.Modules.Harbor.IBeamService", "Strada.Core.Sync.EntityView"],
          },
        ],
      }
    : {};
  const storage = new CampaignStorage(join(memory, "campaigns.db"));
  try {
    storage.save(
      campaign({
        id: PROOF_ID,
        state: "done",
        ideaText: "make a calm orchard game where you drag a cart between rows, 3 levels",
        gddPath: "docs/Orchard_GDD.md",
        startedFrom: "idea",
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
          row("R1", "input", "m1", construct),
          row("R2", "rule", "m2", construct),
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
  const now = Date.now();
  const learning = new LearningStorage(learningPath);
  learning.initialize();
  try {
    // Written the way learning-pipeline.ts mints a lesson: no origin session,
    // because no production code sets one. A test that needs it says so.
    learning.createInstinct({
      id: "ins-1",
      name: "cart lane lesson",
      type: "workflow_pattern",
      status: "active",
      confidence: 0.8,
      triggerPattern: "cart lane",
      action: "register the lane service",
      contextConditions: [],
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
      createdAt: now - 2 * HOUR,
      updatedAt: now - 2 * HOUR,
      sourceTrajectoryIds: [],
      tags: ["milestone:m1"],
      ...(opts.lessonOrigin || opts.futureRecords ? { originSessionId: opts.lessonOrigin ?? "run-1" } : {}),
    } as unknown as Instinct);
    learning.recordInstinctExposure({ instinctId: "ins-1", sessionId: "run-2", taskRunId: "t-m2", shownAt: now - HOUR });
  } finally {
    learning.close();
  }
  const metrics = new MetricsStorage(learningPath);
  metrics.initialize();
  metrics.close();
  const db = new Database(learningPath);
  try {
    db.prepare("INSERT INTO retrieval_metrics (id, retrieval_time_ms, candidates_loaded, instincts_scanned, scope_filtered, insights_returned, recorded_at) VALUES ('r1', 3, 24, 9, 1, 2, ?)").run(now - HOUR);
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
    const insert = db.prepare("INSERT INTO retrieval_metrics (id, retrieval_time_ms, candidates_loaded, instincts_scanned, scope_filtered, insights_returned, recorded_at) VALUES (?, 2, 40, 40, 0, 0, ?)");
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

// The daemon log as the logger's file transport writes it: one JSON object a line.
const logEntry = (message: string, timestamp: string, fields: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ level: "info", message, service: "strada-brain", timestamp, ...fields })}\n`;
/** bootstrap.ts: the first line every boot writes. */
const booted = (at: string): string => logEntry("Bootstrapping Strada Brain", at, { channel: "cli", projectPath: "/invented/project", readOnly: false });
/** tool-registry.ts: the line a boot writes once Strada.MCP's tools are registered. */
const mcpLoaded = (at: string, fields: Record<string, unknown> = {}): string =>
  logEntry("Loaded Strada.MCP tools into main toolchain", at, { sourcePath: "/invented/Strada.MCP", registered: 111, bridgeState: "connected", ...fields });
/**
 * provider-call-log.ts: one line per LLM call, naming the chat it served when
 * it had one — the campaign planner's own asks and the daemon's housekeeping
 * do not.
 */
const providerCall = (at: string, chatId?: string, ok = true): string =>
  logEntry(ok ? "Provider call" : "Provider call failed", at, {
    label: "turn",
    provider: "invented",
    ms: 1200,
    ...(chatId === undefined ? {} : { chatId }),
  });
/** stage-finalization.ts: the last line of a boot that finished. */
const bootReport = (at: string): string => logEntry("Boot report", at, { summary: "Boot report clean." });
/** One boot that loaded Strada.MCP: its marker, the load, its report. */
const goodBoot = (day: string, fields: Record<string, unknown> = {}): string =>
  `${booted(`${day} 00:00:00`)}${mcpLoaded(`${day} 00:00:05`, fields)}${bootReport(`${day} 00:00:09`)}`;

/**
 * A Brain checkout of its own, so rung 1 compares the boot with a HEAD the test
 * chose and never needs this repository's .git (a tree from `git archive` has none).
 */
function brainCheckout(root: string, committedAt = "2050-01-01T00:00:00Z"): string {
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt };
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  git("init", "-q");
  writeFileSync(join(root, "README.md"), "invented checkout\n");
  git("add", "README.md");
  git("-c", "user.name=invented", "-c", "user.email=invented@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "head");
  return root;
}

function hashDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  return out;
}

let work: string;
let brainRoot: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ns-scorecard-"));
  brainRoot = brainCheckout(join(work, "brain"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("north-star scorecard: a run that did everything", () => {
  function proofHome(opts: ProofOptions = {}) {
    const home = join(work, "home");
    const memory = join(home, ".strada-memory");
    mkdirSync(memory, { recursive: true });
    seedProof(memory, opts);
    // The campaign's own LLM calls, and one before its window, and one that
    // named no chat: criterion A counts what it spent and says whose.
    writeFileSync(
      join(home, "strada-brain.log"),
      [
        goodBoot("2099-01-01"),
      // Mid-window on purpose: the logger writes LOCAL wall time, so a stamp
      // near an edge would leave the window on a machine in another zone.
      providerCall("2027-01-15 23:00:00", "chat-invented"),
      providerCall("2027-01-16 00:00:00", "chat-invented"),
      providerCall("2027-01-16 01:00:00", "chat-invented", false),
      providerCall("2027-01-16 02:00:00"),
      providerCall("2027-01-14 02:00:00", "chat-invented"),
      ].join(""),
    );
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

  it("scores what production records: rung 4 fails for want of a construct map, rungs 8 and 9 are not measured, the rest pass", () => {
    const { home, project, upstream } = proofHome();
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(card.rungs.map((r) => r.verdict)).toEqual([
      VERDICT.PASS,
      VERDICT.PASS,
      VERDICT.PASS,
      VERDICT.FAIL,
      VERDICT.PASS,
      VERDICT.PASS,
      VERDICT.PASS,
      VERDICT.NOT_MEASURED,
      VERDICT.NOT_MEASURED,
      VERDICT.PASS,
    ]);
    expect(rung(card, 4).checks[0]!.text).toBe(`${PROOF_ID}: 0 of 2 in-scope rows name a construct, 2 an owner`);
    expect(rung(card, 8).cause).toBe("no play-through record states its input route, so play driven through the game's own Act cannot be told from real input");
    expect(rung(card, 9).cause).toMatch(/^lesson provenance not recorded: 1 of 1 exposures/);
  });

  it("passes all ten rungs, each on a measured number, once the records production does not write yet are there", () => {
    const { home, project, upstream } = proofHome({ futureRecords: true });
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(card.rungs.map((r) => [r.id, r.verdict, r.cause])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i + 1, VERDICT.PASS, null]),
    );
    expect(rung(card, 2).checks[0]!.text).toBe(
      "1 of 1 campaigns that started from one message reached a plan (1 from an idea, 0 from a design the message named)",
    );
    expect(rung(card, 3).checks[1]!.text).toBe(`${PROOF_ID}: 2 of 2 in-scope rows owned by a milestone of its plan`);
    expect(rung(card, 5).checks[0]!.text).toContain("2 of 2 green milestones in 1 campaign since the scope gate first decided were judged green on a proven basis by the scope gate in mode on");
    expect(rung(card, 9).checks.map((c) => c.text)).toEqual([
      "1 of 1 retrievals returned anything; 24 candidates were loaded across them",
      "1 of 1 exposures showed a lesson to a later run than the one that learned it",
    ]);
    expect(rung(card, 10).checks[1]!.text).toMatch(/^0 owner messages in the campaign's chat between its start and .* \(2 tasks linked to it\)$/);
    expect(card.scope.proofCampaign).toBe(PROOF_ID);
  });

  it("judges the proof criteria from records, and keeps what no record holds as not measured", () => {
    const { home, project, upstream } = proofHome();
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    const verdicts = Object.fromEntries(card.criteria.map((c) => [c.id, c.verdict]));
    expect(verdicts).toEqual({
      A: VERDICT.NOT_MEASURED,
      B: VERDICT.NOT_MEASURED,
      // Rows are owned, but no store maps a row to a framework construct.
      C: VERDICT.FAIL,
      D: VERDICT.NOT_MEASURED,
      E: VERDICT.NOT_MEASURED,
      F: VERDICT.NOT_MEASURED,
      // The proof fixture's spec states no orientation, frame rate or render
      // pipeline, and a value the spec does not state is not measured.
      G: VERDICT.NOT_MEASURED,
      // No store holds assumption records: a missing mechanism fails, it is not "not measured".
      H: VERDICT.FAIL,
      I: VERDICT.NOT_MEASURED,
      J: VERDICT.PASS,
      K: VERDICT.PASS,
      L: VERDICT.NOT_MEASURED,
    });
    expect(criterion(card, "C").checks.map((c) => c.ok)).toEqual([true, false, true]);
    expect(criterion(card, "A").cause).toBe(
      "restarts during gate work and their re-measurement are not recorded",
    );
    // Its own calls, counted in its own chat and window: the one before the
    // campaign started and the one that named no chat are not its own.
    expect(criterion(card, "A").checks.map((c) => c.text)).toContain(
      "3 provider calls in chat-invented between the campaign's start and its last update (1 of them failed); 1 more calls in that window named no chat (a planner ask, the daemon's own work)",
    );
    // Every check F can answer from the tree held; only the unanalysed ones remain.
    expect(criterion(card, "F").checks.filter((c) => c.ok === false)).toEqual([]);
  });

  /**
   * A SPRINT'S HOURS ARE ON ITS TASK, NOT ON THE CAMPAIGN ROW. Measured
   * 2026-10-14: a campaign in flight had `updated_at` three minutes after its
   * creation — the row stops being written once a milestone starts — so
   * everything counted inside its window read as zero while the run had made
   * hundreds of calls.
   */
  it("counts the calls of a campaign whose row stopped updating before its sprint did", () => {
    const { home, project, upstream } = proofHome();
    const memory = join(home, ".strada-memory");
    // The campaign's row ends an hour in; its linked task works for twenty.
    const campaigns = new CampaignStorage(join(memory, "campaigns.db"));
    try {
      const run = campaigns.get(PROOF_ID)!;
      campaigns.save({ ...run, updatedAt: T0 + HOUR, milestones: run.milestones.map((m) => ({ ...m, startedAtMs: T0 + HOUR })) });
    } finally {
      campaigns.close();
    }
    const tasks = new TaskStorage(join(memory, "tasks.db"));
    tasks.initialize();
    try {
      // Another task of the same campaign, still working twenty hours in: the
      // window reaches the sprints' own hours, not only the campaign row's.
      tasks.save(task("t-m1-late", T0 + HOUR, { campaignId: PROOF_ID, updatedAt: T0 + 20 * HOUR }));
    } finally {
      tasks.close();
    }
    writeFileSync(
      join(home, "strada-brain.log"),
      [goodBoot("2099-01-01"), providerCall("2027-01-15 23:00:00", "chat-invented")].join(""),
    );

    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    const texts = criterion(card, "A").checks.map((c) => c.text);
    expect(texts.find((x) => x.includes("provider calls"))).toContain("1 provider calls in chat-invented");
  });

  it("fails rung 10 when the owner wrote to the campaign's chat while it ran", () => {
    const { home, project, upstream } = proofHome({ ownerMessageDuringRun: true });
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(rung(card, 10).verdict).toBe(VERDICT.FAIL);
    expect(rung(card, 10).checks[1]).toMatchObject({ ok: false, text: expect.stringMatching(/^1 owner message in the campaign's chat/) });
  });

  it("fails rung 1 on a boot older than HEAD", () => {
    const { home, project, upstream } = proofHome();
    writeFileSync(join(home, "strada-brain.log"), goodBoot("2000-01-02"));
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(rung(card, 1).verdict).toBe(VERDICT.FAIL);
    expect(rung(card, 1).checks[2]!.text).toMatch(/^the boot predates HEAD/);
  });

  it("opens every database read-only: not one byte of the memory directory changes", () => {
    const { home, memory, project, upstream } = proofHome();
    const before = hashDir(memory);
    scoreNorthStar({ home, project, upstream, brainRoot });
    expect(hashDir(memory)).toEqual(before);
  });

  it("prints JSON from the command line", () => {
    const { home, project, upstream } = proofHome();
    const res = spawnSync(process.execPath, [CLI, "--home", home, "--project", project, "--upstream", upstream, "--brain-root", brainRoot, "--json"], { encoding: "utf8", cwd: REPO_ROOT });
    expect(res.status, res.stderr).toBe(EXIT.MEASURED);
    const card = JSON.parse(res.stdout) as Card;
    expect(card.score.rungs).toEqual({ pass: 7, fail: 1, notMeasured: 2 });
    expect(card.criteria.map((c) => c.id).join("")).toBe("ABCDEFGHIJKL");
  });

  it("does not pass rung 9 on a lesson that records no origin session, which is how production writes every lesson", () => {
    const { home, project, upstream } = proofHome();
    const r9 = rung(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, 9);
    expect(r9.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(r9.cause).toBe(
      "lesson provenance not recorded: 1 of 1 exposures show an instinct with no origin session, so a later run cannot be told from the run that learned it",
    );
  });

  it("fails rung 9 when the only exposure went to the run that learned the lesson", () => {
    const { home, project, upstream } = proofHome({ lessonOrigin: "run-2" });
    const r9 = rung(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, 9);
    expect(r9.verdict).toBe(VERDICT.FAIL);
    expect(r9.checks[1]).toEqual({ ok: false, text: "0 of 1 exposures showed a lesson to a later run than the one that learned it" });
  });

  /** Adds campaigns to the proof home's store, each older than the proof run. */
  function addCampaigns(memory: string, campaigns: Campaign[], judgements: Array<{ campaignId: string; milestoneId: string; mode: string; green: boolean }> = []): void {
    const storage = new CampaignStorage(join(memory, "campaigns.db"));
    try {
      for (const c of campaigns) storage.save(c);
      for (const j of judgements) {
        storage.appendJudgement({
          campaignId: j.campaignId,
          attemptKey: `${j.milestoneId}#1`,
          atMs: T0 - 50 * HOUR,
          input: { milestoneId: j.milestoneId, mode: j.mode, revision: "rev-old", run: RUN, sources: [{ writer: WRITER }] } as never,
          judgement: { green: j.green, basis: "proven", caveats: [] },
        });
      }
    } finally {
      storage.close();
    }
  }

  it("scopes rung 5 to campaigns under the scope gate when no --campaign is given, as rungs 2, 3 and 10 are", () => {
    const { home, memory, project, upstream } = proofHome();
    // Greens from before the gate existed: no scope_gate_since, judged in shadow at most.
    addCampaigns(
      memory,
      [campaign({ id: "campaign_before_gate", state: "done", createdAt: T0 - 100 * HOUR, updatedAt: T0 - 60 * HOUR, milestones: [milestone("m1"), milestone("m2")] })],
      [{ campaignId: "campaign_before_gate", milestoneId: "m1", mode: "shadow", green: true }],
    );
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(rung(card, 5).verdict).toBe(VERDICT.PASS);
    expect(rung(card, 5).checks[0]!.text).toBe(
      "2 of 2 green milestones in 1 campaign since the scope gate first decided were judged green on a proven basis by the scope gate in mode on (judgements: off 0, shadow 1, on 2)",
    );
    expect(rung(card, 5).notes).toEqual(["2 green milestones not counted: 0 marked legacy (green before the ledger), 2 in 1 campaign from before the gate first decided"]);
    // One campaign, scored on its own, is held to every green it has.
    const legacy = scoreNorthStar({ home, project, upstream, brainRoot, campaign: "campaign_before_gate" }) as Card;
    expect(rung(legacy, 5).verdict).toBe(VERDICT.FAIL);
    expect(rung(legacy, 5).checks[0]!.text).toBe(
      "0 of 2 green milestones were judged green on a proven basis by the scope gate in mode on (judgements: off 0, shadow 1, on 0)",
    );
  });

  it("still fails rung 5 on a green the gate never proved in a campaign under the gate, and counts only legacy greens out", () => {
    const { home, memory, project, upstream } = proofHome();
    addCampaigns(memory, [
      campaign({
        id: "campaign_gated_bypass",
        createdAt: T0 - 100 * HOUR,
        scopeGateSince: T0 - 90 * HOUR,
        milestones: [milestone("m1", { judgementBasis: "legacy" } as Partial<CampaignMilestone>), milestone("m2")],
      }),
    ]);
    const r5 = rung(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, 5);
    expect(r5.verdict).toBe(VERDICT.FAIL);
    expect(r5.checks[0]!.text).toMatch(/^2 of 3 green milestones in 2 campaigns since the scope gate first decided were judged green/);
    expect(r5.notes).toEqual(["1 green milestone not counted: 1 marked legacy (green before the ledger), 0 in 0 campaigns from before the gate first decided"]);
  });

  it("counts the greens of a campaign created after the gate first decided that never ran under it", () => {
    const { home, memory, project, upstream } = proofHome();
    // The proof run's gate decided at T0; this one started later with the gate off.
    addCampaigns(memory, [campaign({ id: "campaign_gate_off", createdAt: T0 + 5 * HOUR, milestones: [milestone("m1")] })]);
    const r5 = rung(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, 5);
    expect(r5.verdict).toBe(VERDICT.FAIL);
    expect(r5.checks[0]!.text).toMatch(/^2 of 3 green milestones in 2 campaigns since the scope gate first decided/);
  });

  /** Replaces one database of the proof home with a table of an older, invented shape. */
  function replaceDb(path: string, sql: string): void {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
    const db = new Database(path);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }

  it("makes owner messages and task facts not measured, not a crash, when tasks.db lacks the columns they read", () => {
    const { home, memory, project, upstream } = proofHome();
    replaceDb(
      join(memory, "tasks.db"),
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, chat_id TEXT, campaign_id TEXT, status TEXT, created_at INTEGER);
       INSERT INTO tasks VALUES ('t-m1', 'chat-invented', '${PROOF_ID}', 'completed', ${T0 + HOUR});`,
    );
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card & { facts: { tasks: { cause?: string } } };
    expect(rung(card, 10).verdict).toBe(VERDICT.NOT_MEASURED);
    expect(rung(card, 10).cause).toMatch(/^owner messages: .*tasks\.db could not be read: no such column: parent_id$/);
    expect(card.facts.tasks.cause).toMatch(/tasks\.db could not be read: no such column: origin$/);
    expect(rung(card, 2).verdict).toBe(VERDICT.PASS);
  });

  it("makes rung 9's later-run check not measured when instincts has no provenance column", () => {
    const { home, memory, project, upstream } = proofHome();
    const learning = join(memory, "learning.db");
    replaceDb(
      learning,
      `CREATE TABLE instincts (id TEXT PRIMARY KEY, created_at INTEGER, tags TEXT);
       CREATE TABLE instinct_exposure_log (instinct_id TEXT, session_id TEXT, task_run_id TEXT, shown_at INTEGER);
       CREATE TABLE observations (id TEXT PRIMARY KEY, tool_name TEXT, success INTEGER, timestamp INTEGER);
       INSERT INTO instincts VALUES ('ins-1', ${T0}, '[]');
       INSERT INTO instinct_exposure_log VALUES ('ins-1', 'run-2', 't-m2', ${T0 + HOUR});
       INSERT INTO observations VALUES ('o1', 'unity_build_player', 1, ${T0});`,
    );
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(rung(card, 9).checks[1]).toEqual({ ok: null, text: "lesson provenance not recorded: instincts has no origin_session_id column" });
    expect(rung(card, 8).checks[0]!.text).toMatch(/^unity_build_player: 1 calls \(1 succeeded\)/);
  });

  it("makes the campaign rungs not measured when campaigns.db holds a judgements table of another shape", () => {
    const { home, memory, project, upstream } = proofHome();
    const db = new Database(join(memory, "campaigns.db"));
    try {
      db.exec("DROP TABLE campaign_judgements; CREATE TABLE campaign_judgements (seq INTEGER PRIMARY KEY, campaign_id TEXT, milestone_id TEXT);");
    } finally {
      db.close();
    }
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(rung(card, 5).verdict).toBe(VERDICT.NOT_MEASURED);
    expect(rung(card, 5).cause).toMatch(/^campaigns\.db not read: .*campaigns\.db could not be read: no such column: at$/);
    expect(rung(card, 6).verdict).toBe(VERDICT.PASS);
  });

  it("makes a vault index of another shape not measured, not a crash", () => {
    const { home, project, upstream } = proofHome();
    replaceDb(join(project, ".strada", "vault", "index.db"), "CREATE TABLE vault_files (id INTEGER PRIMARY KEY);");
    const k = criterion(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, "K");
    expect(k.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(k.cause).toMatch(/index\.db could not be read: no such column: path$/);
  });

  it("refuses an unknown --campaign", () => {
    const { home } = proofHome();
    const res = spawnSync(process.execPath, [CLI, "--home", home, "--campaign", "campaign_none"], { encoding: "utf8", cwd: REPO_ROOT });
    expect(res.status).toBe(EXIT.USAGE);
    expect(res.stderr).toContain("campaign campaign_none is not in");
  });

  /**
   * "0 returned" is two different facts. A retrieval that loaded candidates and
   * matched none is a scoring problem; one that loaded none is an empty scope —
   * and 4854 rows of zeros could not say which, because only the matches were
   * ever counted (measured 2026-10-14).
   */
  describe("rung 9 says which half of a retrieval was empty", () => {
    function cardWithRetrievals(rows: Array<{ id: string; loaded: number }>, legacy = false): Card {
      const { home, project, upstream } = proofHome();
      const learningPath = join(home, ".strada-memory", "learning.db");
      const db = new Database(learningPath);
      try {
        db.exec("DROP TABLE retrieval_metrics");
        if (legacy) {
          // A store written before the column existed keeps its older shape.
          db.exec(
            `CREATE TABLE retrieval_metrics (id TEXT PRIMARY KEY, retrieval_time_ms INTEGER NOT NULL,
               instincts_scanned INTEGER NOT NULL DEFAULT 0, scope_filtered INTEGER NOT NULL DEFAULT 0,
               insights_returned INTEGER NOT NULL DEFAULT 0, recorded_at INTEGER NOT NULL)`,
          );
          const old = db.prepare(
            "INSERT INTO retrieval_metrics (id, retrieval_time_ms, instincts_scanned, scope_filtered, insights_returned, recorded_at) VALUES (?, 2, 0, 0, 0, ?)",
          );
          for (const r of rows) old.run(r.id, Date.now() - 1000);
        } else {
          db.exec(
            `CREATE TABLE retrieval_metrics (id TEXT PRIMARY KEY, retrieval_time_ms INTEGER NOT NULL,
               candidates_loaded INTEGER NOT NULL DEFAULT 0, instincts_scanned INTEGER NOT NULL DEFAULT 0,
               scope_filtered INTEGER NOT NULL DEFAULT 0, insights_returned INTEGER NOT NULL DEFAULT 0,
               recorded_at INTEGER NOT NULL)`,
          );
          const insert = db.prepare(
            "INSERT INTO retrieval_metrics (id, retrieval_time_ms, candidates_loaded, instincts_scanned, scope_filtered, insights_returned, recorded_at) VALUES (?, 2, ?, 0, 0, 0, ?)",
          );
          for (const r of rows) insert.run(r.id, r.loaded, Date.now() - 1000);
        }
      } finally {
        db.close();
      }
      return scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    }

    it("names learning that was loaded and did not match", () => {
      const card = cardWithRetrievals([{ id: "a", loaded: 31 }, { id: "b", loaded: 11 }]);
      expect(rung(card, 9).checks[0]!.text).toBe(
        "0 of 2 retrievals returned anything; 42 candidates were loaded across them",
      );
    });

    it("names a scope that held no learning at all", () => {
      const card = cardWithRetrievals([{ id: "a", loaded: 0 }, { id: "b", loaded: 0 }]);
      expect(rung(card, 9).checks[0]!.text).toBe(
        "0 of 2 retrievals returned anything; no candidate was ever loaded (the scope held no learning to match against)",
      );
    });

    it("says so when the rows predate the candidate count", () => {
      const card = cardWithRetrievals([{ id: "a", loaded: 0 }], true);
      expect(rung(card, 9).checks[0]!.text).toBe(
        "0 of 1 retrievals returned anything; the rows predate the candidate count, so an empty scope cannot be told from an unmatched one",
      );
    });
  });
});

describe("north-star scorecard: rung 1 judges the newest boot", () => {
  function logHome(files: Record<string, string | Buffer>): string {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body);
    return home;
  }
  const rung1 = (home: string) => rung(scoreNorthStar({ home, brainRoot }) as Card, 1);

  it.each([
    ["failed to load it", "Failed to load Strada.MCP tools"],
    ["refused to load it", "Refused to load Strada.MCP from inside the Unity project"],
  ])("fails when a later boot %s, whatever an older boot loaded", (_label, failure) => {
    const home = logHome({
      "strada-brain.log":
        goodBoot("2099-01-01") +
        booted("2099-01-02 00:00:00") +
        logEntry(failure, "2099-01-02 00:00:04", { level: "error", error: "Cannot find package 'invented-dep'" }) +
        bootReport("2099-01-02 00:00:09"),
    });
    const r = rung1(home);
    expect(r.verdict).toBe(VERDICT.FAIL);
    expect(r.checks[0]).toEqual({
      ok: false,
      text: `the newest boot (2099-01-02 00:00:00) loaded no Strada.MCP tools: ${failure} (Cannot find package 'invented-dep')`,
    });
    expect(r.measured).toMatchObject({ boots: 2, bootsWithTools: 1, bootAt: "2099-01-02 00:00:00" });
  });

  it("fails when a later boot found no Strada.MCP install and so logged nothing about it", () => {
    const home = logHome({ "strada-brain.log": goodBoot("2099-01-01") + booted("2099-01-02 00:00:00") + bootReport("2099-01-02 00:00:09") });
    const r = rung1(home);
    expect(r.verdict).toBe(VERDICT.FAIL);
    expect(r.checks[0]!.text).toBe(
      "the newest boot (2099-01-02 00:00:00) loaded no Strada.MCP tools: it reached its boot report without a Strada.MCP load line (no install was found)",
    );
  });

  it("reads the rotated archives, oldest first, when the current file holds no boot", () => {
    const noise = logEntry("Heartbeat", "2099-01-03 00:00:00");
    const passing = rung1(logHome({ "strada-brain.log": noise, "strada-brain1.log.gz": gzipSync(goodBoot("2099-01-02")) }));
    expect(passing.verdict).toBe(VERDICT.PASS);
    expect(passing.checks[0]!.text).toBe("the newest boot (2099-01-02 00:00:00) registered 111 Unity tools from /invented/Strada.MCP");

    rmSync(join(work, "home"), { recursive: true });
    // strada-brain2 is older than strada-brain1 (the logger rotates tailable).
    const failing = rung1(
      logHome({
        "strada-brain.log": noise,
        "strada-brain1.log.gz": gzipSync(booted("2099-01-02 00:00:00") + bootReport("2099-01-02 00:00:09")),
        "strada-brain2.log.gz": gzipSync(goodBoot("2099-01-01")),
      }),
    );
    expect(failing.verdict).toBe(VERDICT.FAIL);
    expect(failing.checks[0]!.text).toMatch(/^the newest boot \(2099-01-02 00:00:00\) loaded no Strada\.MCP tools/);
  });

  it("is not measured when no file holds a boot marker, not failed for a boot that rotated away", () => {
    const r = rung1(logHome({ "strada-brain.log": mcpLoaded("2099-01-02 00:00:05") }));
    expect(r.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(r.cause).toBe(`no boot marker ("Bootstrapping Strada Brain") in ${join(work, "home", "strada-brain.log")} or its rotated archives`);
  });

  it("is not measured when the newest boot may sit in an archive that cannot be read", () => {
    const home = logHome({
      "strada-brain.log": logEntry("Heartbeat", "2099-01-03 00:00:00"),
      "strada-brain1.log.gz": Buffer.from("not gzip"),
      "strada-brain2.log.gz": gzipSync(goodBoot("2099-01-01")),
    });
    const r = rung1(home);
    expect(r.verdict).toBe(VERDICT.NOT_MEASURED);
    expect(r.cause).toMatch(new RegExp(`^the newest boot may be in ${join(home, "strada-brain1.log.gz").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which could not be read`));
  });
});

describe("north-star scorecard: who owns a ledger row", () => {
  it("counts a queued row as unowned, whatever owners its history names", () => {
    const home = join(work, "home");
    const memory = join(home, ".strada-memory");
    mkdirSync(memory, { recursive: true });
    // reownLedger drops `owner` and keeps `ownership` across a replan, and the
    // new plan reuses the ids m1…mN: the history names a milestone still in it.
    const queued = { ...row("R2", "rule", null), ownership: [{ milestoneId: "m2", reason: "covered-section", atMs: T0 }] };
    const storage = new CampaignStorage(join(memory, "campaigns.db"));
    try {
      storage.save(
        campaign({
          id: "campaign_q",
          ideaText: "an invented puzzle about lanterns",
          milestones: [milestone("m1"), milestone("m2", { status: "pending" })],
          requirements: ledger([row("R1", "input", "m1"), queued]) as Campaign["requirements"],
        }),
      );
    } finally {
      storage.close();
    }
    const card = scoreNorthStar({ home, brainRoot }) as Card;
    expect(rung(card, 3).verdict).toBe(VERDICT.FAIL);
    expect(rung(card, 3).checks[1]).toEqual({ ok: false, text: "campaign_q: 1 of 2 in-scope rows owned by a milestone of its plan" });
    expect(rung(card, 4).checks[0]!.text).toMatch(/, 1 an owner$/);
    expect(criterion(card, "C").checks[0]).toEqual({ ok: false, text: "1 of 2 in-scope rows have an owner in the plan" });
  });
});

describe("north-star scorecard: the measured state", () => {
  function todayHome() {
    const home = join(work, "home");
    const memory = join(home, ".strada-memory");
    mkdirSync(memory, { recursive: true });
    seedToday(memory);
    writeFileSync(join(home, "strada-brain.log"), goodBoot("2000-01-02", { bridgeState: "disconnected" }));
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
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(card.score.rungs).toEqual({ pass: 0, fail: 10, notMeasured: 0 });
    expect(rung(card, 1).checks.map((c) => c.ok)).toEqual([true, false, false]);
    // They predate started_from, so the door cannot be told — and a rung
    // nobody can read is not a rung that passed.
    expect(rung(card, 2).checks.map((c) => [c.ok, c.text])).toEqual([
      [false, "0 of 0 campaigns that started from one message reached a plan (0 from an idea, 0 from a design the message named)"],
      [null, "2 of 2 campaigns predate started_from, so which door they came through cannot be told"],
    ]);
    expect(rung(card, 3).checks[0]!.text).toBe("0 of 2 campaigns carry a requirement ledger");
    expect(rung(card, 5).checks[0]!.text).toBe(
      "no campaign ran under the scope gate in mode on (scope_gate_since is unset on all 2 campaigns); 0 of 2 green milestones were judged green on a proven basis by the scope gate in mode on (judgements: off 0, shadow 2, on 0)",
    );
    // Which half was empty: here the learning was loaded and none of it matched.
    expect(rung(card, 9).checks[0]!.text).toBe(
      "0 of 3 retrievals returned anything; 120 candidates were loaded across them",
    );
    expect(rung(card, 10).checks[0]!.text).toBe("2 campaigns, 1 done; 0 delivered with every milestone judged green on a proven basis by the scope gate in mode on");
  });

  it("measures Strada.Core conformance in the game's own code", () => {
    const { home, project, upstream } = todayHome();
    const r6 = rung(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, 6);
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
    const r7 = rung(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, 7);
    expect(r7.checks.map((c) => c.text)).toEqual([
      "Strada.Modules is not installed in the project (no Packages folder or manifest entry)",
      "0 of 7 game files reference Strada.Modules",
    ]);
  });

  it("does not read framework copies installed under Assets as the game's code", () => {
    const { home, project, upstream } = todayHome();
    // strada-deps.ts can install Strada.MCP at Assets/Strada.MCP; a Modules copy can sit under Assets too.
    script(
      project,
      "Assets/Strada.Modules/Runtime/Screen/ScreenService.cs",
      "using Strada.Core.Patterns;\nnamespace Strada.Modules.Screen { public sealed class ScreenService : Service { } }\n",
    );
    script(project, "Assets/ThirdParty/Strada.MCP/Runtime/Bridge.cs", "namespace Strada.Mcp { public sealed class OrchardService { } }\n");
    write(project, { "Assets/Strada.Modules/Audio/click.wav": "RIFF", "Assets/Strada.Modules/Audio/click.wav.meta": `fileFormatVersion: 2\nguid: ${guid()}\n` });
    const card = scoreNorthStar({ home, project, upstream, brainRoot }) as Card;
    expect(rung(card, 7).checks).toEqual([
      { ok: true, text: "Strada.Modules is installed in the project" },
      { ok: false, text: "0 of 7 game files reference Strada.Modules" },
    ]);
    expect(rung(card, 6).measured).toMatchObject({ gameFiles: 7, duplicateTypeNames: 1, services: 3 });
    // The framework's own sound is not a clip the game left unreferenced.
    expect(criterion(card, "I").checks.find((c) => /audio clip/.test(c.text))).toEqual({ ok: false, text: "no audio clip in Assets" });
  });

  it("finds notes a run wrote into a framework copy, and only with upstream to compare", () => {
    const { home, project, upstream } = todayHome();
    const withUpstream = criterion(scoreNorthStar({ home, project, upstream, brainRoot }) as Card, "K");
    expect(withUpstream.checks.at(-1)).toEqual({ ok: false, text: "1 indexed notes sit inside framework folders and are not in upstream" });
    const without = criterion(scoreNorthStar({ home, project, brainRoot }) as Card, "K");
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
    const card = scoreNorthStar({ home, brainRoot }) as Card;
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

describe("defaultPaths", () => {
  const homeDir = "/invented-user";
  /** A Brain install root: a source checkout when it holds .git, as resolveRuntimePaths probes. */
  function installRoot(name: string, checkout: boolean): string {
    const dir = join(work, name);
    mkdirSync(checkout ? join(dir, ".git") : dir, { recursive: true });
    return dir;
  }

  it("finds the log and the databases where the runtime keeps them: in a source checkout, the checkout itself", () => {
    const checkout = installRoot("checkout", true);
    expect(defaultPaths({}, homeDir, checkout, "darwin")).toEqual({
      home: checkout,
      memoryDir: join(checkout, ".strada-memory"),
      log: join(checkout, "strada-brain.log"),
      sourceCheckout: true,
    });
  });

  it("agrees with resolveRuntimePaths on the config root", () => {
    const checkout = installRoot("checkout", true);
    const installed = installRoot("installed", false);
    const cases: Array<[NodeJS.ProcessEnv, string, NodeJS.Platform]> = [
      [{}, checkout, "darwin"],
      [{ STRADA_HOME: join(work, "elsewhere") }, checkout, "linux"],
      [{ STRADA_SOURCE_CHECKOUT: "false", STRADA_HOME: join(work, "elsewhere") }, checkout, "linux"],
      [{ STRADA_SOURCE_CHECKOUT: "false" }, checkout, "linux"],
      [{}, installed, "linux"],
      [{ STRADA_HOME: join(work, "elsewhere") }, installed, "darwin"],
      [{ STRADA_SOURCE_CHECKOUT: "true" }, installed, "linux"],
      [{ LOCALAPPDATA: join(work, "appdata") }, installed, "win32"],
    ];
    for (const [env, root, platform] of cases) {
      const runtime = resolveRuntimePaths({ env, homeDir, installRoot: root, platform, cwd: work });
      expect(defaultPaths(env, homeDir, root, platform).home, JSON.stringify(env)).toBe(runtime.configRoot);
    }
  });

  it("resolves MEMORY_DB_PATH and LOG_FILE against that root, as the runtime does after it moves there", () => {
    const checkout = installRoot("checkout", true);
    const paths = defaultPaths({ MEMORY_DB_PATH: "state/memory", LOG_FILE: "logs/brain.log" }, homeDir, checkout, "linux");
    expect(paths.memoryDir).toBe(join(checkout, "state", "memory"));
    expect(paths.log).toBe(join(checkout, "logs", "brain.log"));
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
