import type { GoalNode, GoalNodeId, GoalTree } from "./types.js";
import { calculateProgress } from "./goal-progress.js";

const TURKISH_HINT_RE = /[ğüşöçıİ]|\b(?:ve|için|şu|hata|düzelt|incele|bak|çöz|dosya|ekle|güncelle)\b/iu;

export interface GoalNarrativeFeedback {
  readonly language: "en" | "tr";
  readonly narrative: string;
  readonly milestone: {
    current: number;
    total: number;
    label: string;
  };
  readonly focusTasks: readonly string[];
}

function detectLanguage(seedText: string): "en" | "tr" {
  return TURKISH_HINT_RE.test(seedText) ? "tr" : "en";
}

function getChildren(tree: GoalTree, parentId: GoalNodeId): GoalNode[] {
  const children: GoalNode[] = [];
  for (const [, node] of tree.nodes) {
    if (node.parentId === parentId) {
      children.push(node);
    }
  }
  return children.sort((left, right) => left.createdAt - right.createdAt);
}

function truncateTask(task: string, max = 84): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function quoteTask(task: string): string {
  return `"${task}"`;
}

function getReadyPendingNodes(tree: GoalTree): GoalNode[] {
  const completed = new Set<GoalNodeId>();
  for (const [id, node] of tree.nodes) {
    if (node.status === "completed" || id === tree.rootId) {
      completed.add(id);
    }
  }

  const ready: GoalNode[] = [];
  for (const [id, node] of tree.nodes) {
    if (id === tree.rootId || node.status !== "pending") continue;
    if (node.dependsOn.every((dependency) => completed.has(dependency))) {
      ready.push(node);
    }
  }
  return ready.sort((left, right) => left.createdAt - right.createdAt);
}

function getFocusNodes(tree: GoalTree): GoalNode[] {
  const executing = [...tree.nodes.values()]
    .filter((node) => node.id !== tree.rootId && node.status === "executing")
    .sort((left, right) => left.createdAt - right.createdAt);
  if (executing.length > 0) return executing;

  const ready = getReadyPendingNodes(tree);
  if (ready.length > 0) return ready;

  return [...tree.nodes.values()]
    .filter((node) => node.id !== tree.rootId && node.status === "pending")
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function buildGoalNarrativeFeedback(
  tree: GoalTree,
  seedText = tree.taskDescription,
): GoalNarrativeFeedback {
  const language = detectLanguage(seedText);
  const progress = calculateProgress(tree);
  const focusTasks = getFocusNodes(tree).slice(0, 2).map((node) => truncateTask(node.task));
  const currentFocus = focusTasks[0];
  const nextFocus = focusTasks[1];
  const currentFocusText = currentFocus ? quoteTask(currentFocus) : (language === "tr" ? "\"uygun sonraki adım\"" : "\"the next ready step\"");
  const nextFocusText = nextFocus
    ? quoteTask(nextFocus)
    : language === "tr"
      ? "bu adımı tamamlayıp bağımlı sonraki adıma geçeceğim"
      : "I'll finish this step and unlock the next dependency";

  let narrative: string;
  if (progress.total === 0) {
    narrative = language === "tr"
      ? `Aşama: tek adımlı yürütme. Durum: ayrıştırılmış alt adım yok. Şu an odak ${quoteTask(truncateTask(tree.taskDescription, 100))}. Sıradaki adım: görevi doğrudan çalıştıracağım.`
      : `Stage: single-path execution. Status: no decomposed sub-steps. Current focus: ${quoteTask(truncateTask(tree.taskDescription, 100))}. Next: I'll execute the task directly.`;
  } else if (progress.completed >= progress.total) {
    narrative = language === "tr"
      ? `Aşama: kapanış. Durum: ${progress.completed}/${progress.total} adım tamamlandı. Son aksiyon: son doğrulama turunu kapatıyorum. Sıradaki adım: sonucu net şekilde paylaşacağım.`
      : `Stage: closeout. Status: ${progress.completed}/${progress.total} steps complete. Last action: closing the final verification pass. Next: I'll package the result clearly for you.`;
  } else {
    narrative = language === "tr"
      ? `Aşama: plan yürütme. Durum: ${progress.completed}/${progress.total} adım tamamlandı. Şu an odak ${currentFocusText}. Sıradaki adım: ${nextFocusText}.`
      : `Stage: plan execution. Status: ${progress.completed}/${progress.total} steps complete. Current focus: ${currentFocusText}. Next: ${nextFocusText}.`;
  }

  return {
    language,
    narrative,
    milestone: {
      current: progress.completed,
      total: progress.total,
      label: language === "tr" ? "adım" : "steps",
    },
    focusTasks,
  };
}

export function formatGoalPlanMarkdown(
  tree: GoalTree,
  options?: {
    readonly seedText?: string;
    readonly updated?: boolean;
    readonly maxSteps?: number;
  },
): string {
  const feedback = buildGoalNarrativeFeedback(tree, options?.seedText ?? tree.taskDescription);
  const language = feedback.language;
  const maxSteps = options?.maxSteps ?? 5;
  const children = getChildren(tree, tree.rootId);
  const visibleSteps = children.slice(0, maxSteps);
  const remainingCount = Math.max(0, children.length - visibleSteps.length);
  const heading = options?.updated
    ? (language === "tr" ? "**Plan Güncellendi**" : "**Plan Updated**")
    : (language === "tr" ? "**Çalışma Planı**" : "**Execution Plan**");

  const lines = [
    heading,
    "",
    language === "tr"
      ? `Bu işi ${feedback.milestone.total} adıma ayırdım.`
      : `I broke this work into ${feedback.milestone.total} steps.`,
    "",
    `- ${feedback.narrative}`,
    `- ${language === "tr" ? "Hedef" : "Goal"}: ${truncateTask(tree.taskDescription, 120)}`,
  ];

  if (visibleSteps.length > 0) {
    lines.push("");
    lines.push(language === "tr" ? "Sıradaki adımlar:" : "Next steps:");
    for (const [index, node] of visibleSteps.entries()) {
      lines.push(`${index + 1}. ${truncateTask(node.task, 110)}`);
    }
    if (remainingCount > 0) {
      lines.push(
        language === "tr"
          ? `... ve ${remainingCount} adım daha`
          : `... and ${remainingCount} more step${remainingCount === 1 ? "" : "s"}`,
      );
    }
  }

  lines.push("");
  lines.push(
    language === "tr"
      ? "İlerledikçe kısa durum güncellemeleri paylaşacağım."
      : "I'll keep sharing short progress updates as I move through these steps.",
  );

  return lines.join("\n");
}
