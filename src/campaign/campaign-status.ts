// ---------------------------------------------------------------------------
// Campaign status — the measured state of the build, for the channels.
//
// Added 2026-09-09 after the channel survey: the campaign, the mission
// keep-alive, the delivery gate and the real-tree guardian all learned to
// measure, but the only way to see any of it from Telegram or the web portal
// was to wait for a notice. `/campaign` (`/kampanya`) and the portal's
// campaign card read THIS snapshot. Every number here is copied from state the
// campaign already persisted or the task manager already holds; nothing is
// estimated at render time. A field the campaign never measured stays absent
// and renders as "not measured", never as zero.
// ---------------------------------------------------------------------------
import type { Campaign, CampaignMilestone, CampaignState, MilestoneStatus } from "./types.js";
import type { Task } from "../tasks/types.js";
import { ACTIVE_STATUSES } from "../tasks/types.js";
import type { RealTreeGuardianSnapshot } from "../daemon/real-tree-guardian.js";
import type { BuiltAsSpecifiedReport } from "../agents/autonomy/built-as-specified.js";

export interface MilestoneStatusSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: MilestoneStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly taskId?: string;
  /** Epoch ms when the current run began; undefined when it never ran. */
  readonly startedAtMs?: number;
  readonly timeBoxEscalations: number;
  readonly compileVerdict?: CampaignMilestone["compileVerdict"];
  readonly placeholderArtAtStart?: CampaignMilestone["placeholderArtAtStart"];
  readonly structureRefused: boolean;
  readonly lastStructureFinding?: string;
  readonly resultExcerpt?: string;
}

export interface TaskStatusSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastProgress?: string;
  readonly lastProgressAt?: number;
}

export interface CampaignStatusSnapshot {
  readonly id: string;
  readonly chatId: string;
  readonly channelType: string;
  readonly state: CampaignState;
  readonly projectRoot: string;
  readonly gddPath?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly currentMilestone: number;
  readonly milestones: readonly MilestoneStatusSnapshot[];
  readonly milestoneTimeBoxMs: number;
  readonly deliveryReported: boolean;
  readonly autoReviveAt?: number;
  readonly lastError?: string;
  /** True when "kampanya devam" / `/campaign revive` would act on this campaign. */
  readonly revivable: boolean;
  /** The milestone's own task, when the task manager still knows it. */
  readonly currentTask?: TaskStatusSnapshot;
  /** Every active task on the campaign's chat — the mission keep-alive lives here after delivery. */
  readonly activeTasks: readonly TaskStatusSnapshot[];
  readonly independentReview?: Campaign["independentReview"];
}

/** Whether a revive command would act on this campaign (mirrors CampaignStorage.findLatestRevivable). */
export function isRevivable(campaign: Pick<Campaign, "state" | "milestones">): boolean {
  if (campaign.state === "failed" || campaign.state === "cancelled") return true;
  return campaign.state === "done" && campaign.milestones.some((m) => m.structureRefused === true);
}

export function snapshotTask(task: Task): TaskStatusSnapshot {
  const last = task.progress.length > 0 ? task.progress[task.progress.length - 1] : undefined;
  return {
    id: String(task.id),
    title: task.title,
    status: String(task.status),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    lastProgress: last?.message,
    lastProgressAt: last?.timestamp,
  };
}

export function buildCampaignStatus(
  campaign: Campaign,
  opts: {
    readonly maxMilestoneAttempts: number;
    readonly milestoneTimeBoxMs: number;
    readonly getTask: (taskId: string) => Task | null | undefined;
    readonly listTasks: (chatId: string) => readonly Task[];
  },
): CampaignStatusSnapshot {
  const milestones = campaign.milestones.map<MilestoneStatusSnapshot>((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    attempts: m.attempts,
    maxAttempts: opts.maxMilestoneAttempts,
    taskId: m.taskId,
    startedAtMs: m.startedAtMs,
    timeBoxEscalations: m.timeBoxEscalations ?? 0,
    compileVerdict: m.compileVerdict,
    placeholderArtAtStart: m.placeholderArtAtStart,
    structureRefused: m.structureRefused === true,
    lastStructureFinding: m.structureFindings?.[m.structureFindings.length - 1],
    resultExcerpt: m.resultExcerpt,
  }));
  const current = campaign.milestones[campaign.currentMilestone];
  const currentTaskRaw = current?.taskId ? opts.getTask(current.taskId) : undefined;
  const activeTasks = opts
    .listTasks(campaign.chatId)
    .filter((t) => ACTIVE_STATUSES.has(t.status))
    .map(snapshotTask);
  return {
    id: campaign.id,
    chatId: campaign.chatId,
    channelType: campaign.channelType,
    state: campaign.state,
    projectRoot: campaign.projectRoot,
    gddPath: campaign.gddPath,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    currentMilestone: campaign.currentMilestone,
    milestones,
    milestoneTimeBoxMs: opts.milestoneTimeBoxMs,
    deliveryReported: campaign.deliveryReported === true,
    autoReviveAt: campaign.autoReviveAt,
    lastError: campaign.lastError,
    revivable: isRevivable(campaign),
    currentTask: currentTaskRaw ? snapshotTask(currentTaskRaw) : undefined,
    activeTasks,
    independentReview: campaign.independentReview,
  };
}

// ---------------------------------------------------------------------------
// Rendering — one markdown shape for Telegram and the web chat.
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const STATE_ICON: Record<CampaignState, string> = {
  "drafting-gdd": "📝",
  "awaiting-approval": "⏸️",
  planning: "🗺️",
  executing: "🏗️",
  done: "✅",
  failed: "❌",
  cancelled: "🚫",
};

const MILESTONE_ICON: Record<MilestoneStatus, string> = {
  pending: "⬜",
  running: "🔄",
  green: "🟢",
  failed: "🔴",
};

function shorten(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatCampaignStatus(snapshot: CampaignStatusSnapshot, now: number = Date.now()): string {
  const lines: string[] = [];
  const stateIcon = STATE_ICON[snapshot.state] ?? "•";
  lines.push(`${stateIcon} *Campaign* \`${snapshot.id}\` — ${snapshot.state}`);
  if (snapshot.gddPath) lines.push(`GDD: \`${snapshot.gddPath}\``);
  lines.push(`Started ${formatDuration(now - snapshot.createdAt)} ago · updated ${formatDuration(now - snapshot.updatedAt)} ago`);

  const green = snapshot.milestones.filter((m) => m.status === "green").length;
  lines.push("", `*Milestones* ${green}/${snapshot.milestones.length} green · time box ${formatDuration(snapshot.milestoneTimeBoxMs)} each`);
  snapshot.milestones.forEach((m, i) => {
    const icon = MILESTONE_ICON[m.status] ?? "•";
    const marker = i === snapshot.currentMilestone && snapshot.state === "executing" ? " ◀" : "";
    const parts = [`${icon} ${m.id} ${m.title} — ${m.status}, attempt ${m.attempts}/${m.maxAttempts}${marker}`];
    if (m.status === "running" && m.startedAtMs !== undefined) {
      const elapsed = now - m.startedAtMs;
      const left = snapshot.milestoneTimeBoxMs - elapsed;
      parts.push(`   ⏱ ${formatDuration(elapsed)} elapsed, ${left > 0 ? `${formatDuration(left)} left` : "time box exceeded"}${m.timeBoxEscalations > 0 ? `, ${m.timeBoxEscalations} scope narrowing(s)` : ""}`);
    }
    if (m.compileVerdict) {
      parts.push(
        m.compileVerdict.ran
          ? `   🔧 compile ${m.compileVerdict.ok ? "ok" : `RED${m.compileVerdict.errors !== undefined ? ` (${m.compileVerdict.errors} errors)` : ""}`}`
          : "   🔧 compile NOT MEASURED (verifier did not run)",
      );
    }
    if (m.placeholderArtAtStart) {
      parts.push(`   🎨 placeholder sprites at start: ${m.placeholderArtAtStart.placeholders}/${m.placeholderArtAtStart.sprites}`);
    }
    if (m.structureRefused) {
      parts.push(`   🚧 delivery refused by the structural gate${m.lastStructureFinding ? `: ${shorten(m.lastStructureFinding, 160)}` : ""}`);
    }
    lines.push(...parts);
  });

  const task = snapshot.currentTask;
  if (task) {
    lines.push("", `*Current task* \`${task.id}\` — ${task.status}, running ${formatDuration(now - task.createdAt)}`);
    if (task.lastProgress) {
      const age = task.lastProgressAt !== undefined ? ` (${formatDuration(now - task.lastProgressAt)} ago)` : "";
      lines.push(`Last progress${age}: ${shorten(task.lastProgress, 200)}`);
    }
  }
  const others = snapshot.activeTasks.filter((t) => t.id !== task?.id);
  if (others.length > 0) {
    lines.push("", `*Other active tasks on this chat* (${others.length})`);
    for (const t of others.slice(0, 5)) {
      const progress = t.lastProgress ? ` — ${shorten(t.lastProgress, 120)}` : "";
      lines.push(`• \`${t.id}\` ${t.status}, ${formatDuration(now - t.createdAt)}${progress}`);
    }
    if (others.length > 5) lines.push(`• …and ${others.length - 5} more`);
  }

  if (snapshot.independentReview) {
    const r = snapshot.independentReview;
    lines.push("", `*Independent review* (${r.model}): ${r.error ? `not obtained — ${shorten(r.error, 120)}` : r.ok ? "agreed" : "disagreed"}`);
  }
  if (snapshot.state === "done") {
    lines.push("", snapshot.deliveryReported ? "📦 Delivery report was sent." : "📦 Delivery report is pending (not yet handed to the channel).");
  }
  if (snapshot.lastError && snapshot.state !== "executing") {
    lines.push(`Last error: ${shorten(snapshot.lastError, 200)}`);
  }
  if (snapshot.autoReviveAt !== undefined) {
    const inMs = snapshot.autoReviveAt - now;
    lines.push(inMs > 0 ? `⏰ Self-revival armed in ${formatDuration(inMs)}.` : "⏰ Self-revival is due.");
  }
  if (snapshot.revivable) {
    lines.push("", "↩️ Revivable — send `/campaign revive` (or `kampanya devam`) to continue it.");
  }
  return lines.join("\n");
}

export function formatGuardianStatus(g: RealTreeGuardianSnapshot, now: number = Date.now()): string {
  const icon = { unknown: "❔", green: "🟢", red: "🔴", blind: "🙈" }[g.lastVerdict];
  const checked = g.lastCheckedAt > 0 ? `${formatDuration(now - g.lastCheckedAt)} ago` : "never";
  const lines = [`${icon} *Real-tree guardian* — tree ${g.lastVerdict}, last verified ${checked}`];
  if (g.lastVerdict === "red") {
    lines.push(`Errors: ${g.lastErrorCount ?? "not counted"}${g.bestErrorCount !== undefined ? ` (best this episode ${g.bestErrorCount})` : ""}`);
  }
  if (g.fixTaskId) {
    lines.push(`Fix task \`${g.fixTaskId}\` running ${formatDuration(now - g.fixTaskStartedAt)} (attempt ${g.fixAttempts}/${g.maxFixAttempts})`);
  } else if (g.lastVerdict === "red") {
    lines.push(`Fix attempts on these errors: ${g.fixAttempts}/${g.maxFixAttempts}, ${g.attemptsWithoutProgress} without progress`);
  }
  if (g.escalated) lines.push("❌ Escalated — autonomous repair stopped; a person must look.");
  if (g.lastVerdict === "blind") lines.push(`Verifier could not run for ${g.blindStreak} consecutive check(s): ${shorten(g.lastDetail, 200)}`);
  if (g.nextVerifyAt > now) lines.push(`Next verification in ${formatDuration(g.nextVerifyAt - now)}.`);
  if (g.lastVerdict === "red" && g.lastDetail) lines.push("```", g.lastDetail.slice(0, 300), "```");
  return lines.join("\n");
}

export function formatMeasurement(report: BuiltAsSpecifiedReport, projectRoot: string, now: number = Date.now()): string {
  if (!report.measured) {
    return `⚠️ *Not measured* — \`${projectRoot}\` has no readable Assets/ or the walk did not complete. Nothing here is a count.`;
  }
  const inv = report.artInventory;
  const lines = [
    `📏 *Delivery measurement* — ${new Date(now).toISOString()}`,
    `Project: \`${projectRoot}\``,
    report.refusal ? `🚧 Structural refusal: ${shorten(report.refusal, 240)}` : "🟢 No structural refusal",
    "",
    `*Shipped scenes* (${report.shippedScenes.length}): ${report.shippedScenes.map((s) => s.scene).join(", ") || "none"}`,
    `Renderers in shipped scenes: ${report.shippedRenderers} (${report.shippedWorldRenderers} world, ${report.shippedSpriteRenderers} sprite, ${report.shippedMeshRenderers} mesh)`,
    `Project vs built-in references: ${report.shippedProjectRefs} / ${report.shippedBuiltInRefs}`,
    "",
    "*Art inventory*",
    `Prefabs ${inv.prefabs} · models ${inv.models} · sprites ${inv.sprites}`,
    `Placeholder-grade sprites: ${inv.placeholderSprites} (${report.boundPlaceholderSprites} bound in shipped scenes)`,
    `Audio ${inv.audio} (${inv.shortAudio} short, ${inv.duplicateAudio} duplicate)`,
    `Unbound: ${report.unboundPrefabs.length} prefabs, ${report.unboundModels.length} models, ${report.unboundSprites.length} sprites`,
  ];
  if (report.primitiveScripts.length > 0) {
    lines.push(`Geometry built in code: ${report.primitiveCallSites} call site(s) in ${report.primitiveScripts.length} script(s)`);
  }
  if (report.incomplete.length > 0) {
    lines.push("", `⚠️ Incomplete: ${report.incomplete.map((i) => shorten(i, 120)).join("; ")}`);
  }
  return lines.join("\n");
}
