import type { WorkspaceEventMap } from "../dashboard/workspace-events.js";
import type { TaggedGoalNode, SupervisorResult } from "./supervisor-types.js";

const TURKISH_HINT_RE = /[ğüşöçıİ]|\b(?:ve|için|şu|hata|düzelt|incele|bak|çöz|dosya|ekle|güncelle|görev|dağıt)\b/iu;
const MAX_CANVAS_TITLE = 84;
const MAX_WAVE_TASKS = 3;

export type SupervisorFeedbackLanguage = "en" | "tr";
export type SupervisorCanvasTaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "skipped";

interface SupervisorFeedbackShape {
  id: string;
  type?: string;
  props: Record<string, unknown>;
}

export function normalizeSupervisorProgressMarkdown(markdown: string): string {
  return markdown
    .replace(/\*\*/g, "")
    .replace(/^[ \t]*-\s+/gm, "")
    .trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summarizeProviders(
  nodes: readonly Pick<TaggedGoalNode, "assignedProvider">[],
  language: SupervisorFeedbackLanguage,
): string {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const provider = node.assignedProvider ?? "unknown";
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  const summary = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([provider, count]) => `${provider}(${count})`);

  if (summary.length === 0) {
    return language === "tr" ? "atanmamis" : "unassigned";
  }
  return summary.join(language === "tr" ? ", " : ", ");
}

function summarizeWaveTasks(
  nodes: readonly Pick<TaggedGoalNode, "task">[],
  language: SupervisorFeedbackLanguage,
): string {
  const labels = nodes
    .slice(0, MAX_WAVE_TASKS)
    .map((node) => `"${truncate(node.task.trim(), 40)}"`);

  if (labels.length === 0) {
    return language === "tr" ? "hazir isler" : "ready tasks";
  }

  const joined = labels.join(language === "tr" ? ", " : ", ");
  if (nodes.length <= MAX_WAVE_TASKS) {
    return joined;
  }

  return language === "tr"
    ? `${joined} ve ${nodes.length - MAX_WAVE_TASKS} is daha`
    : `${joined} and ${nodes.length - MAX_WAVE_TASKS} more`;
}

function mapCanvasPriority(node: Pick<TaggedGoalNode, "capabilityProfile">): string {
  switch (node.capabilityProfile.preference) {
    case "quality":
      return "high";
    case "speed":
      return "medium";
    case "cost":
      return "low";
    default:
      return "medium";
  }
}

function formatCanvasTaskTitle(node: Pick<TaggedGoalNode, "task" | "assignedProvider">): string {
  const provider = node.assignedProvider ?? "agent";
  return truncate(`${provider} · ${node.task.trim()}`, MAX_CANVAS_TITLE);
}

export function detectSupervisorFeedbackLanguage(task: string): SupervisorFeedbackLanguage {
  return TURKISH_HINT_RE.test(task) ? "tr" : "en";
}

export function supervisorSummaryShapeId(rootId: string): string {
  return `supervisor-summary-${rootId}`;
}

export function supervisorNodeShapeId(nodeId: string): string {
  return `supervisor-node-${nodeId}`;
}

export function buildSupervisorActivationNarrative(task: string): {
  language: SupervisorFeedbackLanguage;
  narrative: string;
  markdown: string;
} {
  const language = detectSupervisorFeedbackLanguage(task);
  if (language === "tr") {
    return {
      language,
      narrative:
        "Aşama: analiz ve dağıtım. Son aksiyon: isteği çok ajanlı yürütme için ayırmaya başladım. Sıradaki adım: görevleri uygun provider ve worker akışlarına dağıtacağım.",
      markdown: [
        "**Aşama:** analiz ve dağıtım",
        "- İsteği çok ajanlı yürütme için parçalıyorum.",
        "- Sıradaki adım: görevleri uygun provider ve worker akışlarına dağıtacağım.",
      ].join("\n"),
    };
  }

  return {
    language,
    narrative:
      "Stage: analysis and routing. Last action: I started splitting the request for multi-agent execution. Next: I'll distribute the work across the best-fit providers and workers.",
    markdown: [
      "**Stage:** analysis and routing",
      "- I started breaking the request into multi-agent work.",
      "- Next: I'll distribute the work across the best-fit providers and workers.",
    ].join("\n"),
  };
}

export function buildSupervisorPlanNarrative(params: {
  task: string;
  nodeCount: number;
  nodes: readonly TaggedGoalNode[];
  totalWaves: number;
}): {
  language: SupervisorFeedbackLanguage;
  narrative: string;
  markdown: string;
  canvasSummary: string;
} {
  const language = detectSupervisorFeedbackLanguage(params.task);
  const providerSummary = summarizeProviders(params.nodes, language);

  if (language === "tr") {
    return {
      language,
      narrative:
        `Aşama: planlama. Son aksiyon: ${params.nodeCount} görevi ${providerSummary} arasında dağıttım. ` +
        `Sıradaki adım: ${params.totalWaves} dalgalı yürütmeyi başlatıp ilk uygun işleri çalıştıracağım.`,
      markdown: [
        "**Aşama:** planlama",
        `- ${params.nodeCount} görev üretildi.`,
        `- Provider dağıtımı: ${providerSummary}.`,
        `- Dalga planı: ${params.totalWaves}.`,
        "- Sıradaki adım: ilk uygun işleri çalıştırıyorum.",
      ].join("\n"),
      canvasSummary: [
        "Supervisor planı hazır",
        "",
        `Görevler: ${params.nodeCount}`,
        `Provider dağıtımı: ${providerSummary}`,
        `Dalga sayısı: ${params.totalWaves}`,
      ].join("\n"),
    };
  }

  return {
    language,
    narrative:
      `Stage: planning. Last action: I distributed ${params.nodeCount} tasks across ${providerSummary}. ` +
      `Next: I'll start the ${params.totalWaves}-wave execution path and launch the first ready tasks.`,
    markdown: [
      "**Stage:** planning",
      `- ${params.nodeCount} tasks were generated.`,
      `- Provider distribution: ${providerSummary}.`,
      `- Wave plan: ${params.totalWaves}.`,
      "- Next: I'm launching the first ready tasks.",
    ].join("\n"),
    canvasSummary: [
      "Supervisor plan ready",
      "",
      `Tasks: ${params.nodeCount}`,
      `Provider distribution: ${providerSummary}`,
      `Wave count: ${params.totalWaves}`,
    ].join("\n"),
  };
}

export function buildSupervisorWaveNarrative(params: {
  task: string;
  waveIndex: number;
  totalWaves: number;
  nodes: readonly TaggedGoalNode[];
}): {
  language: SupervisorFeedbackLanguage;
  narrative: string;
  markdown: string;
  canvasSummary: string;
} {
  const language = detectSupervisorFeedbackLanguage(params.task);
  const taskSummary = summarizeWaveTasks(params.nodes, language);

  if (language === "tr") {
    return {
      language,
      narrative:
        `Aşama: yürütme. Son aksiyon: ${params.waveIndex + 1}/${Math.max(params.totalWaves, 1)} dalgasında ${taskSummary} için işi başlattım. ` +
        "Sıradaki adım: tamamlanan işleri doğrulayıp sıradaki hazır dalgayı açacağım.",
      markdown: [
        "**Aşama:** yürütme",
        `- Dalga ${params.waveIndex + 1}/${Math.max(params.totalWaves, 1)} başladı.`,
        `- Bu dalga: ${taskSummary}.`,
        "- Sıradaki adım: tamamlanan işleri doğrulayıp sıradaki hazır dalgayı açacağım.",
      ].join("\n"),
      canvasSummary: [
        `Dalga ${params.waveIndex + 1}/${Math.max(params.totalWaves, 1)} çalışıyor`,
        "",
        `Aktif işler: ${taskSummary}`,
      ].join("\n"),
    };
  }

  return {
    language,
    narrative:
      `Stage: execution. Last action: I launched wave ${params.waveIndex + 1}/${Math.max(params.totalWaves, 1)} for ${taskSummary}. ` +
      "Next: I'll verify the completed work and unlock the next ready wave.",
    markdown: [
      "**Stage:** execution",
      `- Wave ${params.waveIndex + 1}/${Math.max(params.totalWaves, 1)} started.`,
      `- This wave: ${taskSummary}.`,
      "- Next: I'll verify the completed work and unlock the next ready wave.",
    ].join("\n"),
    canvasSummary: [
      `Wave ${params.waveIndex + 1}/${Math.max(params.totalWaves, 1)} running`,
      "",
      `Active tasks: ${taskSummary}`,
    ].join("\n"),
  };
}

export function buildSupervisorVerificationNarrative(task: string): {
  language: SupervisorFeedbackLanguage;
  narrative: string;
  markdown: string;
  canvasSummary: string;
} {
  const language = detectSupervisorFeedbackLanguage(task);
  if (language === "tr") {
    return {
      language,
      narrative:
        "Aşama: doğrulama ve sentez. Son aksiyon: paralel çıktıları birleştirip çapraz kontrol etmeye geçtim. Sıradaki adım: son cevabı tutarlı bir özet halinde kapatacağım.",
      markdown: [
        "**Aşama:** doğrulama ve sentez",
        "- Paralel çıktıları birleştirip çapraz kontrole geçtim.",
        "- Sıradaki adım: son cevabı tutarlı bir özet halinde kapatacağım.",
      ].join("\n"),
      canvasSummary: [
        "Doğrulama sürüyor",
        "",
        "Paralel çıktılar çapraz kontrol ediliyor.",
      ].join("\n"),
    };
  }

  return {
    language,
    narrative:
      "Stage: verification and synthesis. Last action: I moved into cross-checking the parallel outputs. Next: I'll close with a coherent final answer.",
    markdown: [
      "**Stage:** verification and synthesis",
      "- I moved into cross-checking the parallel outputs.",
      "- Next: I'll close with a coherent final answer.",
    ].join("\n"),
    canvasSummary: [
      "Verification in progress",
      "",
      "Parallel outputs are being cross-checked.",
    ].join("\n"),
  };
}

export function buildSupervisorCompletionNarrative(params: {
  task: string;
  result: SupervisorResult;
}): {
  language: SupervisorFeedbackLanguage;
  narrative: string;
  canvasSummary: string;
} {
  const language = detectSupervisorFeedbackLanguage(params.task);
  if (language === "tr") {
    return {
      language,
      narrative:
        `Aşama: kapanış. Son aksiyon: ${params.result.succeeded}/${params.result.totalNodes} görevi tamamlayıp çıktıları birleştirdim. ` +
        "Sıradaki adım: doğrulanmış sonucu kullanıcıya teslim ediyorum.",
      canvasSummary: [
        "Supervisor tamamlandı",
        "",
        `Başarılı: ${params.result.succeeded}/${params.result.totalNodes}`,
        `Başarısız: ${params.result.failed}`,
        `Atlandı: ${params.result.skipped}`,
      ].join("\n"),
    };
  }

  return {
    language,
    narrative:
      `Stage: closure. Last action: I merged the outputs after completing ${params.result.succeeded}/${params.result.totalNodes} tasks. ` +
      "Next: I'm delivering the verified result to the user.",
    canvasSummary: [
      "Supervisor completed",
      "",
      `Succeeded: ${params.result.succeeded}/${params.result.totalNodes}`,
      `Failed: ${params.result.failed}`,
      `Skipped: ${params.result.skipped}`,
    ].join("\n"),
  };
}

export function buildSupervisorAbortNarrative(params: {
  task: string;
  reason: string;
}): {
  language: SupervisorFeedbackLanguage;
  narrative: string;
  canvasSummary: string;
} {
  const language = detectSupervisorFeedbackLanguage(params.task);
  const reason = truncate(params.reason.trim(), 140);
  if (language === "tr") {
    return {
      language,
      narrative:
        `Aşama: kesinti. Son aksiyon: supervisor akışı "${reason}" nedeniyle durdu. ` +
        "Sıradaki adım: güvenli şekilde kısmi sonucu bırakıp normal akışa geri döneceğim.",
      canvasSummary: [
        "Supervisor kesildi",
        "",
        `Neden: ${reason}`,
      ].join("\n"),
    };
  }

  return {
    language,
    narrative:
      `Stage: interruption. Last action: the supervisor flow stopped because "${reason}". ` +
      "Next: I'll fall back safely with the partial result or the standard path.",
    canvasSummary: [
      "Supervisor interrupted",
      "",
      `Reason: ${reason}`,
    ].join("\n"),
  };
}

export function buildSupervisorNodeNarrative(params: {
  task: string;
  node: Pick<TaggedGoalNode, "task" | "assignedProvider">;
  status: SupervisorCanvasTaskStatus;
  reason?: string;
}): {
  language: SupervisorFeedbackLanguage;
  narrative: string;
} {
  const language = detectSupervisorFeedbackLanguage(params.task);
  const provider = params.node.assignedProvider ?? (language === "tr" ? "atanmamis" : "unassigned");
  const label = truncate(params.node.task.trim(), 72);

  switch (params.status) {
    case "running":
      return {
        language,
        narrative: language === "tr"
          ? `Aşama: yürütme. Son aksiyon: "${label}" işi ${provider} üzerinde çalışmaya başladı. Sıradaki adım: bu çıktıyı tamamlayıp doğrulama kuyruğuna alacağım.`
          : `Stage: execution. Last action: "${label}" started running on ${provider}. Next: I'll finish this output and move it into verification.`,
      };
    case "verifying":
      return {
        language,
        narrative: language === "tr"
          ? `Aşama: doğrulama. Son aksiyon: "${label}" çıktısını gözden geçirmeye aldım. Sıradaki adım: onaylayıp senteze bağlayacağım.`
          : `Stage: verification. Last action: I moved "${label}" into review. Next: I'll approve it and fold it into synthesis.`,
      };
    case "done":
      return {
        language,
        narrative: language === "tr"
          ? `Aşama: tamamlama. Son aksiyon: "${label}" işi ${provider} üzerinde bitti. Sıradaki adım: bağımlı işleri ve sentezi güncelleyeceğim.`
          : `Stage: completion. Last action: "${label}" finished on ${provider}. Next: I'll update the dependent work and synthesis state.`,
      };
    case "failed":
      return {
        language,
        narrative: language === "tr"
          ? `Aşama: hata yönetimi. Son aksiyon: "${label}" işi ${provider} üzerinde başarısız oldu. Sıradaki adım: hatayı değerlendirip kalan planı buna göre güncelleyeceğim.${params.reason ? ` Neden: ${truncate(params.reason, 100)}` : ""}`
          : `Stage: failure handling. Last action: "${label}" failed on ${provider}. Next: I'll assess the failure and adjust the remaining plan accordingly.${params.reason ? ` Reason: ${truncate(params.reason, 100)}` : ""}`,
      };
    case "skipped":
      return {
        language,
        narrative: language === "tr"
          ? `Aşama: akış uyarlama. Son aksiyon: "${label}" işi atlandı. Sıradaki adım: bağımlılıkları yeniden hizalayıp yürütmeye devam edeceğim.`
          : `Stage: flow adjustment. Last action: "${label}" was skipped. Next: I'll realign the remaining dependencies and continue execution.`,
      };
    case "pending":
    default:
      return {
        language,
        narrative: language === "tr"
          ? `Aşama: planlama. Son aksiyon: "${label}" işi kuyruğa alındı. Sıradaki adım: hazır olduğunda yürütmeye başlayacağım.`
          : `Stage: planning. Last action: "${label}" is queued. Next: I'll start it as soon as it becomes ready.`,
      };
  }
}

export function buildSupervisorCanvasPlan(params: {
  rootId: string;
  task: string;
  nodes: readonly TaggedGoalNode[];
  summary: string;
}): WorkspaceEventMap["canvas:agent_draw"] {
  const summaryShape: SupervisorFeedbackShape = {
    type: "note-block",
    id: supervisorSummaryShapeId(params.rootId),
    props: {
      w: 320,
      h: 180,
      content: params.summary,
      color: "#89b4fa",
    },
  };

  const nodeShapes: SupervisorFeedbackShape[] = params.nodes.map((node) => ({
    type: "task-card",
    id: supervisorNodeShapeId(String(node.id)),
    props: {
      w: 260,
      h: 132,
      title: formatCanvasTaskTitle(node),
      status: "pending",
      priority: mapCanvasPriority(node),
    },
  }));

  return {
    action: "draw",
    layout: "flow",
    intent: "supervisor:plan",
    autoSwitch: false,
    shapes: [summaryShape, ...nodeShapes],
  };
}

export function buildSupervisorCanvasSummaryUpdate(params: {
  rootId: string;
  summary: string;
  tone?: "info" | "active" | "success" | "error";
}): WorkspaceEventMap["canvas:agent_draw"] {
  const color = params.tone === "success"
    ? "#a6e3a1"
    : params.tone === "error"
      ? "#f38ba8"
      : params.tone === "active"
        ? "#f9e2af"
        : "#89b4fa";

  return {
    action: "update",
    intent: "supervisor:summary",
    autoSwitch: false,
    shapes: [{
      type: "note-block",
      id: supervisorSummaryShapeId(params.rootId),
      props: {
        content: params.summary,
        color,
      },
    }],
  };
}

export function buildSupervisorCanvasNodeUpdate(params: {
  node: Pick<TaggedGoalNode, "id" | "task" | "assignedProvider" | "capabilityProfile">;
  status: SupervisorCanvasTaskStatus;
}): WorkspaceEventMap["canvas:agent_draw"] {
  return {
    action: "update",
    intent: "supervisor:node-status",
    autoSwitch: false,
    shapes: [{
      type: "task-card",
      id: supervisorNodeShapeId(String(params.node.id)),
      props: {
        ...(params.status === "pending" ? { w: 260, h: 132 } : {}),
        title: formatCanvasTaskTitle(params.node),
        status: params.status,
        priority: mapCanvasPriority(params.node),
      },
    }],
  };
}
