import { basename } from "node:path";
import type { Task, TaskProgressSignal, TaskProgressUpdate } from "./types.js";

export type ProgressLanguage = "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";

const TURKISH_HINT_RE = /[ğüşöçıİ]|\b(?:ve|için|şu|hata|düzelt|incele|bak|çöz|dosya|ekle|güncelle)\b/iu;

export function toTaskProgressSignal(update: TaskProgressUpdate): TaskProgressSignal {
  if (typeof update === "string") {
    return {
      kind: "other",
      message: update,
    };
  }
  return {
    kind: update.kind,
    message: update.message,
    userSummary: update.userSummary,
    reason: update.reason,
    files: update.files ? [...update.files] : undefined,
    toolNames: update.toolNames ? [...update.toolNames] : undefined,
    delegationType: update.delegationType,
  };
}

export function getTaskProgressMessage(update: TaskProgressUpdate): string {
  return toTaskProgressSignal(update).message;
}

export function buildTaskProgressSummary(
  task: Pick<Task, "title" | "prompt">,
  update: TaskProgressUpdate | undefined,
  defaultLanguage: ProgressLanguage = "en",
  progress?: { current: number; total: number; unit: string },
): string {
  const signal = update ? toTaskProgressSignal(update) : undefined;
  const summary = signal?.userSummary?.trim();
  if (summary) {
    return summary;
  }

  const language = detectProgressLanguage(task.prompt, defaultLanguage);
  const files = formatFiles(signal?.files);
  const joinedFiles = files.join(language === "tr" ? " ve " : " and ");

  let base: string;
  switch (signal?.kind) {
    case "editing":
      base = language === "tr"
        ? joinedFiles
          ? `Strada agent: ${joinedFiles} üzerinde hata düzeltmeleri uyguluyorum.`
          : "Strada agent: ilgili dosyalarda hata düzeltmeleri uyguluyorum."
        : joinedFiles
          ? `Strada agent: applying fixes in ${joinedFiles}.`
          : "Strada agent: applying code fixes.";
      break;
    case "verification":
      base = language === "tr"
        ? "Strada agent: yaptığım değişiklikleri build ve kalite kontrolleriyle doğruluyorum."
        : "Strada agent: verifying the latest changes with build and quality checks.";
      break;
    case "clarification":
      base = language === "tr"
        ? "Strada agent: kararı size sormadan önce projeden ek kanıt topluyorum."
        : "Strada agent: gathering more project evidence before surfacing a question.";
      break;
    case "visibility":
      base = language === "tr"
        ? "Strada agent: sonucu paylaşmadan önce teknik kanıtları tekrar kontrol ediyorum."
        : "Strada agent: validating the technical evidence before surfacing the result.";
      break;
    case "delegation":
      base = language === "tr"
        ? "Strada agent: kök neden analizi için yardımcı agent incelemesi çalıştırıyorum."
        : "Strada agent: running a helper-agent diagnosis for root-cause analysis.";
      break;
    case "loop_recovery":
      base = language === "tr"
        ? "Strada agent: aynı noktaya döndüğümü fark ettim; farklı strateji ve ek kanıtla toparlanıyorum."
        : "Strada agent: I detected a repeated control loop and am recovering with a different strategy.";
      break;
    case "replanning":
      base = language === "tr"
        ? "Strada agent: mevcut yaklaşımı değiştirip yeni bir planla devam ediyorum."
        : "Strada agent: switching to a different plan.";
      break;
    case "analysis":
    case "inspection":
      base = language === "tr"
        ? joinedFiles
          ? `Strada agent: ${joinedFiles} ve ilgili kanıtları inceliyorum.`
          : "Strada agent: proje durumunu ve ilgili kanıtları inceliyorum."
        : joinedFiles
          ? `Strada agent: inspecting ${joinedFiles} and the surrounding evidence.`
          : "Strada agent: inspecting the project state and surrounding evidence.";
      break;
    default:
      base = fallbackSummary(task.title, language);
  }
  return appendMilestone(base, progress);
}

function appendMilestone(
  summary: string,
  progress?: { current: number; total: number; unit: string },
): string {
  if (!progress) return summary;
  return `${summary} — ${progress.current}/${progress.total} ${progress.unit}`;
}

function fallbackSummary(title: string, language: ProgressLanguage): string {
  const normalized = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!normalized) {
    return language === "tr"
      ? "Strada agent: görev üzerinde çalışıyorum."
      : "Strada agent: still working on the task.";
  }
  return language === "tr"
    ? `Strada agent: ${normalized} üzerinde çalışıyorum.`
    : `Strada agent: working on ${normalized}.`;
}

function detectProgressLanguage(
  prompt: string,
  defaultLanguage: ProgressLanguage,
): ProgressLanguage {
  if (defaultLanguage === "tr" || TURKISH_HINT_RE.test(prompt)) {
    return "tr";
  }
  return defaultLanguage;
}

function formatFiles(files: readonly string[] | undefined): string[] {
  if (!files || files.length === 0) {
    return [];
  }
  return [...new Set(files.map((file) => basename(file)).filter(Boolean))].slice(0, 3);
}
