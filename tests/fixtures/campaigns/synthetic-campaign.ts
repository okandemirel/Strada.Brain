/**
 * An invented campaign, seeded into a campaigns.db and a tasks.db so the
 * exporter (scripts/eval/export-campaign-fixture.mjs) writes it as the
 * committed replay fixture, tests/fixtures/campaigns/synthetic-campaign.json
 * (tests/eval/export-campaign-fixture.test.ts holds the file to that output;
 * `npx vitest run tests/eval/export-campaign-fixture.test.ts -u` rewrites it).
 *
 * The shape is the one a measured campaign showed, whose own export is not
 * committed (a real one may be kept in the gitignored tests/fixtures/local/):
 * seven milestones stored green while every lineage tip but one carried the
 * system's own task_stuck stamp — m4's only in the tip, never in the
 * 500-character excerpt the campaign kept, m6's ten of them with an outage
 * stamp — verifier flags under each attempt, two tips stored cut, a refused
 * structure check that quotes the GDD, and a coverage milestone that failed
 * on a cancelled task. Every name, path and line of prose is made up.
 */
import { CampaignStorage } from "../../../src/campaign/campaign-storage.js";
import type { Campaign, CampaignMilestone } from "../../../src/campaign/types.js";
import { getResilienceMessage } from "../../../src/agents/resilience-messages.js";
import { TaskStorage } from "../../../src/tasks/task-storage.js";
import { TaskStatus, type Task, type TaskId } from "../../../src/tasks/types.js";

export const SYNTHETIC_CAMPAIGN_ID = "campaign_1700000000000_a1b2c";
export const SYNTHETIC_HOME = "/Users/sample";
const PROJECT_ROOT = `${SYNTHETIC_HOME}/Games/SyntheticPuzzle`;
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/** Quoted by the structure findings below, so the export has a GDD passage to leave out. */
const GDD_STYLE = "Lanterns glow softly over a painted lake at dusk, drawn in loose watercolour with warm paper grain.";

export const SYNTHETIC_GDD = [
  "# Lantern Drift — Game Design Document (synthetic test fixture)",
  "",
  "## 2.5 Platforms",
  "Phones and tablets in portrait orientation; a desktop build for internal playtests.",
  "",
  "## 3.1 Board",
  "A hex board of still water. Lanterns drift in from the left edge, one cell per beat.",
  "## 3.2 Lanterns",
  "Each lantern carries one of five glow colours and a wick count from one to four.",
  "## 3.3 Core Rules",
  "Tapping a shrine pulls the nearest lantern of its colour; a matched lantern burns one wick.",
  ...Array.from({ length: 8 }, (_, i) => `## 3.${i + 4} Rule set ${i + 4}\nRule ${i + 4} keeps the drift readable at every board size.`),
  "",
  "## 4 Obstacles",
  "Reeds slow a lantern for one beat; ice holds it until a neighbour clears.",
  "## 5 Power-ups",
  "A gust moves every lantern one cell; a spark lights a whole row.",
  "## 6 Levels",
  "Levels are authored as JSON and validated by a solver before release.",
  "## 7 Screens",
  "Title, map, level, results and settings.",
  "## 8 Progression",
  "Stars unlock new ponds; events rotate weekly.",
  "## 12 Art Direction",
  GDD_STYLE,
  "## 15 Technology",
  "Unity with the Strada.Core module layout; saves sync through a cloud service.",
  "## 16 Production",
  "Seven sprints, then a coverage pass against this document.",
  "",
].join("\n");

const STUCK = getResilienceMessage("task_stuck", "en");
const ABORT = getResilienceMessage("provider_abort", "en");
const ABORT_TR = getResilienceMessage("provider_abort", "tr");
const FLAGS = "[VERIFIER FLAGS — unresolved; this node was NOT positively verified]";
const NO_VERIFIER =
  "- verification_skipped: no HEALTHY cross-provider verifier (every other provider is in cooldown or unconfigured) — this node was NOT independently verified";
const QUOTA = "- Provider #2 usage quota exhausted (resets in ~2h): Rate limit exceeded. Please try again later.";
const REASONING = ["- <reasoning>", "Here is how the review went:", "", "1. **Read the request:** a verification pass over another agent's work."];
const CUT_MARK = "\n... (truncated)";
/** What the runtime's sanitizer keeps of a long result before it appends its cut mark. */
const STORED_MAX = 8192;

/** One stuck attempt as a tip records it: the stamp, the nudge it got, the flags it ended on. */
function attempt(stamp: string, nudge: string, reason = NO_VERIFIER): string[] {
  return [stamp, "", `**${nudge}**`, "", FLAGS, reason, ""];
}

/** A result longer than the store keeps, cut the way the sanitizer cuts it. */
function storedCut(lines: string[], filler: (i: number) => string): string {
  let text = lines.join("\n");
  for (let i = 0; text.length < STORED_MAX; i++) text += `\n${filler(i)}`;
  return `${text.slice(0, STORED_MAX)}${CUT_MARK}`;
}

const NUDGES = [
  "Stop reflecting and make a concrete edit to Assets/Scripts/Board/BoardShell.cs, then run the PlayMode verification again.",
  "Stop further reflection and inspect Assets/Prefabs/Generated/ShrinePanel.prefab before the next edit.",
  "Stop reflecting and make the next concrete mutation in LanternSpawner.cs, then run the Unity PlayMode verification again.",
  "Stop inspecting and use a mutation tool now to implement the planned change in the relevant ModuleConfig.asset under Assets/Modules.",
];

const planStep = (i: number): string[] => [
  "{",
  `  "step": ${i},`,
  `  "goal": "wire the lantern board into scene ${i}",`,
  `  "actions": ["open Assets/Scenes/Main.unity", "place the board prefab", "save the scene"]`,
  "}",
  "",
];

const RESULTS: Record<string, string> = {
  m1: [...attempt(STUCK, NUDGES[0]!), ...attempt(STUCK, NUDGES[1]!), ...attempt(STUCK, NUDGES[2]!)].join("\n").trimEnd(),
  m2: storedCut(
    [
      "The rule engine compiles; wiring the drift beat next.",
      "",
      ...Array.from({ length: 6 }, (_, i) => [...planStep(i + 1), ...attempt(STUCK, NUDGES[i % NUDGES.length]!)]).flat(),
    ],
    (i) => `progress note ${i}: the worker kept describing the drift beat instead of changing it`,
  ),
  m3: [
    "Let me take the workspace path the system redirected me to and run the build from there:",
    "",
    FLAGS,
    ...REASONING,
    "2. **Check the diff:** no file under Assets/ changed in this attempt.",
  ].join("\n"),
  m4: [
    STUCK,
    "",
    "**Make a targeted code change to Assets/Scripts/Levels/LevelCatalog.cs to resolve the failed build verification, then run the verification pipeline to confirm the fix**",
    "",
    FLAGS,
    ...REASONING,
    "2. **Check the diff:** the catalog loader was rewritten but never compiled.",
    "3. **Check the tests:** none ran; the build failed before them.",
    "4. **Verdict:** not verified.",
  ].join("\n"),
  m5: [STUCK, "", FLAGS, ...REASONING].join("\n"),
  m6: [
    ...Array.from({ length: 10 }, (_, i) => attempt(STUCK, NUDGES[i % NUDGES.length]!, QUOTA)).flat(),
    ...attempt(ABORT, "Retry once the provider answers again.", QUOTA),
  ]
    .join("\n")
    .trimEnd(),
  m7: storedCut(
    [
      "Integration plan for the delivery build:",
      "",
      ...planStep(1),
      FLAGS,
      `${NO_VERIFIER} (log: ${SYNTHETIC_HOME}/Library/Logs/Unity/Editor.log)`,
      "",
      ...attempt(STUCK, "Stop reflecting and inspect the latest unity_verify_change failure, then make one targeted edit."),
      ...planStep(2),
      FLAGS,
      NO_VERIFIER,
      "",
      ABORT_TR,
      "",
      FLAGS,
      NO_VERIFIER,
      "",
      ...Array.from({ length: 4 }, (_, i) => planStep(i + 3)).flat(),
    ],
    (i) => `  "note ${i}": "keep the camera, the bootstrapper and the input adapter in the saved scene",`,
  ),
  mcov1: "Cancelled: the coverage pass stalled twice without changing a file, so the campaign stopped it before a third try.",
};

/** Where each milestone's lineage starts and, when a retry minted a newer task, where it ends. */
const LINEAGE: Record<string, { root: string; tip?: string }> = {
  m1: { root: "task_0000a001" },
  m2: { root: "task_0000a002" },
  m3: { root: "task_0000a003", tip: "task_0000a013" },
  m4: { root: "task_0000a004" },
  m5: { root: "task_0000a005" },
  m6: { root: "task_0000a006" },
  m7: { root: "task_0000a007" },
  mcov1: { root: "task_0000a008" },
};

const excerpt = (id: string): string => RESULTS[id]!.slice(-500);
const GDD_SAYS = `GDD says: …${GDD_STYLE}…`;

function milestones(): CampaignMilestone[] {
  const green = (id: string, n: number, title: string, prompt: string, fields: Partial<CampaignMilestone> = {}) =>
    ({
      id,
      title: `Sprint ${n} — ${title}`,
      prompt,
      status: "green",
      attempts: 1,
      taskId: LINEAGE[id]!.root,
      resultExcerpt: excerpt(id),
      ...fields,
    }) as CampaignMilestone;
  return [
    green("m1", 1, "engine foundations and an empty board shell", "Read docs/GDD.md and implement §2.5, §3.1–§3.2, §15 and §16.", {
      reconcileDeferred: false,
    }),
    green("m2", 2, "core rules and the drift loop", "Implement §3.3–§3.11 completely, with the art of §12.", { reconcileDeferred: false }),
    green("m3", 3, "obstacles and power-ups", "Implement §4 and §5.", {
      attempts: 2,
      reconcileDeferred: false,
      visualEvidenceBounced: true,
      noWorkBounced: false,
    }),
    green("m4", 4, "level data, the solver and launch content", "Implement §6, §3.5 and §16.1–§16.2.", { visualEvidenceBounced: true }),
    green("m5", 5, "screens, onboarding and progression", "Implement §7, §8.1–§8.4 and §12.", { visualEvidenceBounced: true }),
    green("m6", 6, "cloud saves and weekly events", "Implement §8.5–§8.9 and §15.3–§15.8.", {
      attempts: 2,
      visualEvidenceBounced: true,
      noWorkBounced: false,
      timeBoxEscalations: 2,
      startedAtMs: T0 + 60 * HOUR,
      reconcileDeferredSince: T0 + 58 * HOUR,
    }),
    green("m7", 7, "integration and delivery", "Integrate §2.5, §15 and §16, then deliver.", {
      attempts: 2,
      visualEvidenceBounced: false,
      noWorkBounced: false,
      timeBoxEscalations: 0,
      deliveryVerificationBounced: false,
      deliveryVerificationBounces: 2,
      visualEvidence: "observed",
      startedAtMs: T0 + 80 * HOUR,
      commitNote: "Committed 212 file(s) as `1a2b3c4`.",
      testVerdict: "PlayMode verification passed: 41 of 42 tests ran clean.",
      structureRefused: true,
      structureFindings: [
        "REFUSAL STANDS, bounce budget spent: the shipped scenes render NOTHING — 0 renderer components in the entry scene Assets/Scenes/Main.unity and the prefabs it places.",
        "1 scene enabled in Build Settings; entry scene (build index 0): Assets/Scenes/Main.unity",
        "3 runtime scripts build geometry with CreatePrimitive/PrimitiveType: Assets/Scripts/Board/BoardShell.cs, Assets/Scripts/LanternSpawner.cs, +1 more",
        GDD_SAYS,
      ],
      visualConformance: [
        "**Does it look like the GDD?**",
        "- Partly: the board and its lanterns read, but the painted lake backdrop is missing.",
        "- Judged from `~/Games/SyntheticPuzzle/Recordings/verification-final/frame_00119.png` by openai.",
      ].join("\n"),
    }),
    {
      id: "mcov1",
      title: "Coverage completion 1 — close the GDD gaps",
      prompt: "Close the gaps the coverage audit listed.",
      status: "failed",
      attempts: 2,
      startedAtMs: T0 + 100 * HOUR,
      taskId: LINEAGE["mcov1"]!.root,
      visualEvidenceBounced: false,
      noWorkBounced: false,
      deliveryVerificationBounced: false,
      deliveryVerificationBounces: 0,
      sceneHygieneBounces: 0,
      timeBoxEscalations: 0,
      placeholderArtAtStart: { sprites: 120, placeholders: 97 },
      structureRefused: false,
      structureFindings: ["Shipped scenes PLACE 9 renderer components (2 mesh, 7 sprite).", GDD_SAYS],
      artBounced: false,
      prosOnlyBounced: false,
      resultExcerpt: excerpt("mcov1"),
      commitNote: "Committed 37 file(s) as `5d6e7f8`.",
      visualEvidence: "observed",
      compileVerdict: { ok: true, ran: true, errors: 0, detail: "Runtime assemblies compile; test assemblies are not built by this check." },
    } as CampaignMilestone,
  ];
}

function task(id: string, createdAt: number, fields: Partial<Task>): Task {
  return {
    id: id as TaskId,
    chatId: "chat-synthetic",
    channelType: "cli",
    userId: "user-synthetic",
    title: `Campaign task ${id}`,
    status: TaskStatus.completed,
    prompt: "(synthetic)",
    progress: [],
    createdAt,
    updatedAt: createdAt,
    ...fields,
  } as Task;
}

/** Write the synthetic campaign into `campaignsDb` and its milestones' tasks into `tasksDb`. */
export function seedSyntheticCampaign(campaignsDb: string, tasksDb: string): void {
  const campaigns = new CampaignStorage(campaignsDb);
  try {
    campaigns.save({
      id: SYNTHETIC_CAMPAIGN_ID,
      chatId: "chat-synthetic",
      channelType: "cli",
      userId: "user-synthetic",
      projectRoot: PROJECT_ROOT,
      state: "done",
      ideaText: "a calm lantern-matching puzzle",
      gddPath: "docs/GDD.md",
      gddText: SYNTHETIC_GDD,
      draftAttempts: 0,
      milestones: milestones(),
      currentMilestone: 7,
      createdAt: T0,
      updatedAt: T0 + 110 * HOUR,
      lastError:
        "Coverage completion 1 — close the GDD gaps blocked after 2 attempts: The task stalled without making progress, so it was stopped. Please try again or break the request into smaller steps.",
      coverageAuditNote: "coverage audit could not run: coverage audit returned malformed JSON",
      deliveryReported: true,
    } as Campaign);
  } finally {
    campaigns.close();
  }

  const tasks = new TaskStorage(tasksDb);
  tasks.initialize();
  try {
    Object.entries(LINEAGE).forEach(([id, { root, tip }], i) => {
      const createdAt = T0 + (i + 1) * 10 * HOUR;
      const status = id === "mcov1" ? TaskStatus.cancelled : TaskStatus.completed;
      const last = { status, result: RESULTS[id]!, completedAt: createdAt + 2 * HOUR, updatedAt: createdAt + 2 * HOUR };
      if (tip) {
        tasks.save(task(root, createdAt, { result: "The first attempt changed nothing." }));
        tasks.save(task(tip, createdAt + HOUR, { parentId: root as TaskId, ...last }));
      } else {
        tasks.save(task(root, createdAt, last));
      }
    });
    tasks.setVerification(
      LINEAGE["m7"]!.root as TaskId,
      JSON.stringify({ testsGreen: true, detail: "PlayMode verification passed: 41 of 42 tests ran clean." }),
    );
  } finally {
    tasks.close();
  }
}
