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
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "düzenleme" : "editing",
        lastAction: language === "tr"
          ? joinedFiles
            ? `${joinedFiles} üzerinde düzeltme uyguluyorum`
            : "ilgili dosyalarda düzeltme uyguluyorum"
          : joinedFiles
            ? `I started applying fixes in ${joinedFiles}`
            : "I started applying code fixes",
        nextStep: language === "tr"
          ? "değişiklikleri hemen doğrulayacağım"
          : "I'll verify the changes immediately",
      });
      break;
    case "verification":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "doğrulama" : "verification",
        lastAction: language === "tr"
          ? "son değişiklikleri build ve kalite kontrollerine soktum"
          : "I ran the latest changes through build and quality checks",
        nextStep: language === "tr"
          ? "çıkan sinyalleri teyit edip sonucu paylaşacağım"
          : "I'll confirm the signals and package the result",
      });
      break;
    case "clarification":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "ek kanıt toplama" : "evidence gathering",
        lastAction: language === "tr"
          ? "eksik kararı netleştirmek için projeden ek sinyal topluyorum"
          : "I gathered extra project evidence to close the missing decision",
        nextStep: language === "tr"
          ? "gerekirse bunu size net bir soruya çevireceğim"
          : "I'll turn any remaining gap into a direct question if needed",
      });
      break;
    case "visibility":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "son kontrol" : "final review",
        lastAction: language === "tr"
          ? "paylaşmadan önce teknik kanıtları tekrar çapraz kontrol ediyorum"
          : "I cross-checked the technical evidence before surfacing the result",
        nextStep: language === "tr"
          ? "sonucu gereksiz iç detay olmadan özetleyeceğim"
          : "I'll summarize the outcome without dumping internal noise",
      });
      break;
    case "delegation":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "yardımcı inceleme" : "delegated diagnosis",
        lastAction: language === "tr"
          ? "kök neden için yardımcı agent incelemesi başlattım"
          : "I started a helper-agent pass for root-cause analysis",
        nextStep: language === "tr"
          ? "bulguları ana akışa bağlayıp ilerleyeceğim"
          : "I'll merge the findings back into the main execution path",
      });
      break;
    case "loop_recovery":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "toparlanma" : "recovery",
        lastAction: language === "tr"
          ? "aynı döngüye girdiğimi fark edip yaklaşımı değiştirdim"
          : "I detected a repeated loop and switched strategies",
        nextStep: language === "tr"
          ? "alternatif yolu yeni kanıtla test edeceğim"
          : "I'll test the alternative path against fresh evidence",
      });
      break;
    case "replanning":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "plan revizyonu" : "replanning",
        lastAction: language === "tr"
          ? "mevcut planı revize ettim"
          : "I revised the current plan",
        nextStep: language === "tr"
          ? "güncellenen planla yürütmeye devam edeceğim"
          : "I'll resume execution with the updated plan",
      });
      break;
    case "analysis":
    case "inspection":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "inceleme" : "inspection",
        lastAction: language === "tr"
          ? joinedFiles
            ? `${joinedFiles} ve ilgili akışı tarıyorum`
            : "proje durumunu ve ilgili kanıtları tarıyorum"
          : joinedFiles
            ? `I'm scanning ${joinedFiles} and the surrounding path`
            : "I'm scanning the project state and surrounding evidence",
        nextStep: language === "tr"
          ? "ilk somut müdahale noktasını çıkaracağım"
          : "I'll line up the first concrete intervention point",
      });
      break;
    case "goal":
      base = buildLabeledSummary(language, {
        stage: language === "tr" ? "plan yürütme" : "plan execution",
        lastAction: language === "tr"
          ? "çalışma planını güncelledim"
          : "I refreshed the execution plan",
        nextStep: language === "tr"
          ? "hazır olan bir sonraki adıma geçiyorum"
          : "I'm moving into the next ready step",
      });
      break;
    default:
      base = fallbackSummary(task.title, language);
  }
  return appendMilestone(base, progress, language);
}

function appendMilestone(
  summary: string,
  progress?: { current: number; total: number; unit: string },
  language: ProgressLanguage = "en",
): string {
  if (!progress) return summary;
  return `${summary} ${progressStatus(progress, language)}`;
}

function fallbackSummary(title: string, language: ProgressLanguage): string {
  const normalized = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!normalized) {
    return buildLabeledSummary(language, {
      stage: language === "tr" ? "çalışma" : "working",
      lastAction: language === "tr"
        ? "görevin yürütme hattını açık tutuyorum"
        : "I'm keeping the task execution path moving",
      nextStep: language === "tr"
        ? "doğruladığım sonucu paylaşacağım"
        : "I'll share the verified result once it is ready",
    });
  }
  return buildLabeledSummary(language, {
    stage: language === "tr" ? "çalışma" : "working",
    lastAction: language === "tr"
      ? `"${normalized}" üzerinde ilerliyorum`
      : `I'm moving through "${normalized}"`,
    nextStep: language === "tr"
      ? "doğruladığım sonucu paylaşacağım"
      : "I'll share the verified result once it is ready",
  });
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

function buildLabeledSummary(
  language: ProgressLanguage,
  parts: {
    stage: string;
    lastAction: string;
    nextStep: string;
  },
): string {
  if (language === "tr") {
    return `Aşama: ${parts.stage}. Son aksiyon: ${parts.lastAction}. Sıradaki adım: ${parts.nextStep}.`;
  }

  return `Stage: ${parts.stage}. Last action: ${parts.lastAction}. Next: ${parts.nextStep}.`;
}

function progressStatus(
  progress: { current: number; total: number; unit: string },
  language: ProgressLanguage,
): string {
  if (language === "tr") {
    return `Durum: ${progress.current}/${progress.total} ${progress.unit}.`;
  }
  return `Status: ${progress.current}/${progress.total} ${progress.unit}.`;
}
