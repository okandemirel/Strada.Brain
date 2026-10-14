/**
 * An invented campaign, seeded into a campaigns.db and a tasks.db so the
 * exporter (scripts/eval/export-campaign-fixture.mjs) writes it as the
 * committed replay fixture, tests/fixtures/campaigns/synthetic-campaign.json
 * (tests/eval/export-campaign-fixture.test.ts holds the file to that output;
 * `npx vitest run tests/eval/export-campaign-fixture.test.ts -u` rewrites it).
 *
 * It keeps the kinds of record a measured campaign showed, not its numbers
 * (that campaign's own export is not committed; a real one may be kept in the
 * gitignored tests/fixtures/local/): milestones stored green while their
 * lineage tips carry the system's own stamps — one only in the tip, never in
 * the 500-character excerpt the campaign kept, others beside an outage or a
 * step-limit stamp — verifier flags under the attempts, a tip stored cut,
 * retries that minted newer tasks, a refused structure check that quotes the
 * GDD, and a last milestone that failed on a cancelled task. Every count,
 * name, path and line of prose is made up.
 */
import { CampaignStorage } from "../../../src/campaign/campaign-storage.js";
import type { Campaign, CampaignMilestone } from "../../../src/campaign/types.js";
import { getResilienceMessage } from "../../../src/agents/resilience-messages.js";
import { TaskStorage } from "../../../src/tasks/task-storage.js";
import { TaskStatus, type Task, type TaskId } from "../../../src/tasks/types.js";

export const SYNTHETIC_CAMPAIGN_ID = "campaign_1700000000000_a1b2c";
export const SYNTHETIC_HOME = "/Users/sample";
const PROJECT_ROOT = `${SYNTHETIC_HOME}/Games/SyntheticObservatory`;
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/** Quoted by the structure findings below, so the export has a GDD passage to leave out. */
const GDD_STYLE = "The sky is drawn in deep ink blues with chalk-white stars and a faint pencilled grid of right ascension.";

export const SYNTHETIC_GDD = [
  "# Comet Watch — Game Design Document (synthetic test fixture)",
  "",
  "## 1 Night Sky",
  "The sky turns through the year; comets cross it on orbits the almanac prints a month ahead.",
  GDD_STYLE,
  "",
  "## 2 Telescope",
  "### 2.1 Mirrors",
  "The primary mirror is thirty-one segments that sag out of true as the dome cools; the player trims them one at a time.",
  "### 2.2 Mount",
  "The mount slews between booked targets, and every slew spends minutes of dark time.",
  "",
  "## 3 Weather",
  "A cloud forecast opens and closes observing windows; a night lost to cloud returns its booked hours.",
  "",
  "## 4 Catalogue",
  "### 4.1 Naming",
  "A confirmed comet carries its first observer's name and the year it was sighted.",
  "### 4.2 Confirmation",
  "A sighting stays provisional until another observatory recovers it on a later clear night; one nobody recovers before it fades from view is withdrawn but kept on file.",
  "",
  "## 5 Night log",
  "### 5.1 Plates",
  "Every plate is logged with its start time, its filter and the seeing the observer measured.",
  "### 5.2 Dome care",
  "A night that ends with the shutter still open costs the next night its first hour.",
  "### 5.3 Log viewer",
  "The log opens on the newest night and pages back one night at a time.",
  "",
  "## 6 Funding",
  "A research council pays for observing nights and rereads the night log before it renews.",
  "",
].join("\n");

const STUCK = getResilienceMessage("task_stuck", "en");
const ABORT_ES = getResilienceMessage("provider_abort", "es");
const MAX_STEPS = getResilienceMessage("max_steps_reached", "en");
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
  "Stop reflecting and make a concrete edit to Assets/Observatory/Dome/DomeRotator.cs, then run the PlayMode verification again.",
  "Stop further reflection and inspect Assets/Observatory/Prefabs/MirrorSegment.prefab before the next edit.",
  "Stop reflecting and make the next concrete mutation in CometTracker.cs, then run the Unity PlayMode verification again.",
  "Stop inspecting and use a mutation tool now to set the shutter timing in the observatory module's config, then verify once.",
];

const planStep = (i: number): string[] => [
  "{",
  `  "step": ${i},`,
  `  "goal": "wire the sky dome into scene ${i}",`,
  `  "actions": ["open Assets/Scenes/Observatory.unity", "place the dome prefab", "save the scene"]`,
  "}",
  "",
];

const RESULTS: Record<string, string> = {
  m1: ["The dome scene opens; trimming the mirror segments next.", "", ...attempt(STUCK, NUDGES[0]!), ...attempt(STUCK, NUDGES[2]!)]
    .join("\n")
    .trimEnd(),
  // The stamp sits at the top, followed by more prose than the excerpt keeps.
  m2: [
    "Retrying from the slew table the first attempt left half-written.",
    "",
    ...attempt(STUCK, NUDGES[1]!),
    "The slew table now reads the booked targets; here is what each slew does:",
    "",
    ...Array.from({ length: 12 }, (_, i) => `- slew ${i + 1}: the mount waits for the dome to stop before it moves`),
  ].join("\n"),
  m3: storedCut(
    [
      "The night log compiles; wiring the seeing field next.",
      "",
      ...Array.from({ length: 4 }, (_, i) => [...planStep(i + 1), ...attempt(STUCK, NUDGES[(i + 1) % NUDGES.length]!)]).flat(),
    ],
    (i) => `progress note ${i}: the worker kept describing the seeing field instead of changing it`,
  ),
  m4: [
    "The forecast panel draws; the booking table is still read-only.",
    "Cloud cover now closes the window it should, and the dome waits for it to reopen.",
    "",
    FLAGS,
    ...REASONING,
    "2. **Check the diff:** the observing window opens, but no booking it should hand back moved.",
    "3. **Verdict:** not verified.",
  ].join("\n"),
  m5: [
    ...attempt(STUCK, NUDGES[3]!),
    ...attempt(STUCK, NUDGES[0]!, QUOTA),
    ...attempt(STUCK, NUDGES[1]!, QUOTA),
    MAX_STEPS,
    "",
    FLAGS,
    NO_VERIFIER,
  ].join("\n"),
  m6: [
    ...attempt(STUCK, "Stop reflecting and make the renewal form read the night log, then run the PlayMode verification again."),
    ABORT_ES,
    "",
    FLAGS,
    QUOTA,
  ].join("\n"),
  m7: [
    "Integration plan for the review build:",
    "",
    ...planStep(1),
    FLAGS,
    `${NO_VERIFIER} (log: ${SYNTHETIC_HOME}/Library/Logs/Unity/Editor.log)`,
    "",
    ...planStep(2),
    MAX_STEPS,
    "",
    "The review build is assembled; the dome and the star field load in the entry scene.",
  ].join("\n"),
  mcov1: [
    ...attempt(STUCK, "Stop reflecting and give each confirmed comet its observer's name, then verify once."),
    ...attempt(STUCK, NUDGES[2]!, `- verification_skipped: the review build under ${PROJECT_ROOT}/Builds/Review never finished`),
  ]
    .join("\n")
    .trimEnd(),
  "mcov1-2": "Cancelled from the dashboard after the log viewer pass came back a third time without changing a file.",
};

/** Where each milestone's lineage starts and, oldest first, the newer tasks its retries minted. */
const LINEAGE: Record<string, { root: string; retries?: string[] }> = {
  m1: { root: "task_0000a001" },
  m2: { root: "task_0000a002", retries: ["task_0000a012"] },
  m3: { root: "task_0000a003" },
  m4: { root: "task_0000a004" },
  m5: { root: "task_0000a005", retries: ["task_0000a015", "task_0000a025"] },
  m6: { root: "task_0000a006" },
  m7: { root: "task_0000a007" },
  mcov1: { root: "task_0000a008" },
  "mcov1-2": { root: "task_0000a009" },
};
const tipOf = (id: string): string => LINEAGE[id]!.retries?.at(-1) ?? LINEAGE[id]!.root;

const excerpt = (id: string): string => RESULTS[id]!.slice(-500);
const GDD_SAYS = `GDD says: …${GDD_STYLE}…`;
/** A gap sprint's title carries the start of the requirement it closes, here a GDD sentence word for word. */
const LAST_GAP_TITLE = `Coverage completion 1.2 — ${"The log opens on the newest night and pages back one night at a time.".slice(0, 60)}`;

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
    green("m1", 1, "the dome, the sky and the mirror segments", "Read docs/GDD.md and implement §1 and §2.1."),
    green("m2", 2, "the mount and its slews", "Implement §2.2.", {
      attempts: 2,
      visualEvidenceBounced: true,
      noWorkBounced: false,
    }),
    green("m3", 3, "the night log", "Implement §5.1–§5.3 and keep every plate the log records."),
    green("m4", 4, "weather windows and bookings", "Implement §3 and the booked hours it returns.", {
      startedAtMs: T0 + 40 * HOUR,
      reconcileDeferredSince: T0 + 39 * HOUR,
    }),
    green("m5", 5, "the catalogue", "Implement §4.1, then the confirmation of §4.2.", {
      attempts: 3,
      reconcileDeferred: false,
      visualEvidenceBounced: true,
      noWorkBounced: false,
      timeBoxEscalations: 1,
    }),
    green("m6", 6, "funding renewals", "Implement §6 against the log of §5.", { reconcileDeferred: false }),
    green("m7", 7, "the review build", "Assemble §1 to §6 into one build, then deliver.", {
      visualEvidenceBounced: false,
      noWorkBounced: false,
      timeBoxEscalations: 0,
      deliveryVerificationBounced: false,
      deliveryVerificationBounces: 1,
      visualEvidence: "observed",
      startedAtMs: T0 + 70 * HOUR,
      commitNote: "Committed 63 file(s) as `9c8b7a6`.",
      testVerdict: "PlayMode verification passed: 37 of 39 tests ran clean.",
      structureRefused: true,
      structureFindings: [
        "REFUSAL STANDS, bounce budget spent: the shipped scenes render NOTHING — 0 renderer components in the entry scene Assets/Scenes/Observatory.unity and the prefabs it places.",
        "2 scenes enabled in Build Settings; entry scene (build index 0): Assets/Scenes/Observatory.unity",
        "3 runtime scripts build geometry with CreatePrimitive/PrimitiveType: Assets/Observatory/Dome/DomeRotator.cs, Assets/Observatory/Sky/StarField.cs, +1 more",
        GDD_SAYS,
      ],
      visualConformance: [
        "**Does it look like the GDD?**",
        "- Partly: the dome and its star field read, but the coordinate grid over them is missing.",
        "- Judged from `~/Games/SyntheticObservatory/Recordings/night-review/frame_00342.png` by openai.",
      ].join("\n"),
    }),
    // The coverage audit's round: one sprint per gap, titled with the gap it closes.
    {
      id: "mcov1",
      title: "Coverage completion 1.1 — confirmed comets carry the observer's name",
      prompt: "Close the gap the coverage audit listed: §4.1.",
      status: "green",
      attempts: 1,
      fromAudit: true,
      taskId: LINEAGE["mcov1"]!.root,
      resultExcerpt: excerpt("mcov1"),
      placeholderArtAtStart: { sprites: 73, placeholders: 38 },
      commitNote: "Committed 23 file(s) as `3f4e5d6`.",
      visualEvidence: "observed",
    } as CampaignMilestone,
    {
      id: "mcov1-2",
      title: LAST_GAP_TITLE,
      prompt: "Close the gap the coverage audit listed: §5.3.",
      status: "failed",
      attempts: 3,
      fromAudit: true,
      startedAtMs: T0 + 90 * HOUR,
      taskId: LINEAGE["mcov1-2"]!.root,
      visualEvidenceBounced: false,
      noWorkBounced: false,
      deliveryVerificationBounced: false,
      deliveryVerificationBounces: 0,
      sceneHygieneBounces: 1,
      timeBoxEscalations: 0,
      structureRefused: false,
      structureFindings: [
        "2 scenes enabled in Build Settings; entry scene (build index 0): Assets/Scenes/Observatory.unity",
        "Shipped scenes PLACE 47 renderer components (16 mesh, 31 sprite).",
        GDD_SAYS,
      ],
      artBounced: false,
      prosOnlyBounced: false,
      resultExcerpt: excerpt("mcov1-2"),
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
      ideaText: "a quiet observatory-scheduling sim",
      gddPath: "docs/GDD.md",
      gddText: SYNTHETIC_GDD,
      draftAttempts: 0,
      milestones: milestones(),
      currentMilestone: 8,
      createdAt: T0,
      updatedAt: T0 + 96 * HOUR,
      lastError: `NOT DELIVERED — ${LAST_GAP_TITLE} was cancelled`,
      // Round 1's audit ran and listed the gaps above; the audit after it threw.
      coverageAuditNote: "coverage audit could not run: coverage audit output failed schema validation",
      deliveryReported: true,
    } as Campaign);
  } finally {
    campaigns.close();
  }

  const tasks = new TaskStorage(tasksDb);
  tasks.initialize();
  try {
    Object.entries(LINEAGE).forEach(([id, { root, retries = [] }], i) => {
      const createdAt = T0 + (i + 1) * 10 * HOUR;
      const chain = [root, ...retries];
      const doneAt = createdAt + (chain.length + 1) * HOUR;
      const cancelled = id === "mcov1-2";
      const last = {
        status: cancelled ? TaskStatus.cancelled : TaskStatus.completed,
        ...(cancelled ? { cancelReason: "user" as const } : {}),
        result: RESULTS[id]!,
        completedAt: doneAt,
        updatedAt: doneAt,
      };
      chain.forEach((taskId, n) => {
        tasks.save(
          task(taskId, createdAt + n * HOUR, {
            ...(n > 0 ? { parentId: chain[n - 1] as TaskId } : {}),
            ...(n === chain.length - 1 ? last : { result: `Attempt ${n + 1} changed nothing.` }),
          }),
        );
      });
    });
    tasks.setVerification(
      tipOf("m6") as TaskId,
      JSON.stringify({
        testsGreen: false,
        detail: `PlayMode verification failed: 3 of 31 tests failed (log: ${SYNTHETIC_HOME}/Library/Logs/Unity/Editor.log)`,
      }),
    );
    tasks.setVerification(
      tipOf("m7") as TaskId,
      JSON.stringify({ testsGreen: true, detail: "PlayMode verification passed: 37 of 39 tests ran clean." }),
    );
  } finally {
    tasks.close();
  }
}
