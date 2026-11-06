/**
 * What a supervised run that did not finish says about its steps.
 *
 * Measured 2026-11-06 (golden run): a run whose first step was blocked told
 * the user "Blocked:\n[goal_1793…] blocked\n\nSkipped:\n[goal_1793…] Skipped:
 * dependency failed" — internal goal ids, the bare word "blocked", and no step
 * a person could recognise. Each step is now named by its task text, and a
 * reason that is only a status word is replaced by what the step's terminal
 * key says about how it ended.
 *
 * A reason with content is kept word for word, and in parentheses. This
 * text is read by machines as well as by people: the campaign recognises an
 * outage by "blocked:provider_unavailable" anywhere, or by "All providers
 * failed or unavailable" and the executor's stall sentence as a clause of
 * their own (after a line start, colon, dash or full stop), and the boot
 * re-arm leaves a task that says "ask_user" for its person. Rewording a
 * reason would change what they decide, and so would moving it behind a
 * colon: the "[goal_…] " it used to follow was not a clause start.
 */

import type { TerminalKey } from "../agents/autonomy/terminal-key.js";
import { detectSupervisorFeedbackLanguage, type SupervisorFeedbackLanguage } from "./supervisor-feedback.js";
import type { NodeResult } from "./supervisor-types.js";

/** The plan a run carried out: the request it was made for, and its steps. */
export interface StoppedPlan {
  /** Decides the language the summary is written in. */
  readonly request: string;
  /** The plan's nodes; a step is named by its task text. */
  readonly nodes: Iterable<{ readonly id: string; readonly task: string }>;
}

type Phrase = Readonly<Record<SupervisorFeedbackLanguage, string>>;

/** A step name longer than this is cut: the line is about the step, not its whole brief. */
const MAX_STEP_NAME = 120;

/** A reason made of nothing but a status word says nothing about why. */
const BARE_STATUS_RE = /^(?:worker\s+)?(?:blocked|failed|skipped)\.?$|^no output$/i;

const ENDED_BECAUSE: Readonly<Record<TerminalKey, Phrase>> = {
  task_stuck: { en: "it kept trying without making progress", tr: "ilerleme kaydetmeden denemeyi sürdürdü" },
  max_steps_reached: { en: "it used every step it was allowed", tr: "izin verilen adımların hepsini kullandı" },
  token_budget_exceeded: { en: "it used up its token budget", tr: "token bütçesini bitirdi" },
  cut_short: { en: "a time or cost limit cut it short", tr: "bir süre ya da maliyet sınırı onu yarıda kesti" },
  error: { en: "it stopped on an error", tr: "bir hatayla durdu" },
  provider_quota: { en: "the AI provider's quota ran out", tr: "yapay zekâ sağlayıcısının kotası bitti" },
  provider_abort: { en: "the AI provider stopped answering", tr: "yapay zekâ sağlayıcısı yanıt vermeyi bıraktı" },
  provider_ask_user: { en: "the AI provider kept failing", tr: "yapay zekâ sağlayıcısı art arda hata verdi" },
  interrupted: { en: "it was interrupted", tr: "yarıda kesildi" },
  done: { en: "it ended without a usable result", tr: "kullanılabilir bir sonuç vermeden bitti" },
};
const NO_REASON: Phrase = { en: "it gave no reason", tr: "bir neden bildirmedi" };

/**
 * The dispatcher's two skip reasons. They used to render as the bare word
 * "skipped", so a run the failure budget stopped could not be told from one
 * whose dependencies collapsed (audited 2026-09-02); they still cannot be.
 */
const SKIPPED_BECAUSE: Readonly<Record<string, Phrase>> = {
  "Skipped: dependency failed": {
    en: "a step it depends on did not finish",
    tr: "bağlı olduğu bir adım tamamlanmadı",
  },
  "Skipped: budget exhausted": {
    en: "too many steps had failed, so no new step was started",
    tr: "çok sayıda adım başarısız olduğu için yeni adım başlatılmadı",
  },
};
const SKIPPED: Phrase = { en: "it was skipped", tr: "atlandı" };

function clip(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Why a failed or blocked step stopped: its own words, or its terminal key when it said only a status. */
function failedBecause(result: NodeResult, language: SupervisorFeedbackLanguage): string {
  const said = (result.blockedReason?.trim() ? result.blockedReason : result.output).trim();
  if (said && !BARE_STATUS_RE.test(said)) return said;
  return (result.terminalKey ? ENDED_BECAUSE[result.terminalKey] : NO_REASON)[language];
}

function skippedBecause(result: NodeResult, language: SupervisorFeedbackLanguage): string {
  const said = result.output.trim();
  return SKIPPED_BECAUSE[said]?.[language] ?? (said || SKIPPED[language]);
}

/**
 * The summary of a run that stopped with work left: how many steps finished,
 * what each finished step reported, and why each other step did not finish.
 * Steps keep their plan order. No goal id is ever printed: a step whose task
 * text is unknown is named by its position.
 */
export function describeStoppedPlan(results: readonly NodeResult[], plan?: StoppedPlan): string {
  const language: SupervisorFeedbackLanguage = plan ? detectSupervisorFeedbackLanguage(plan.request) : "en";
  const tr = language === "tr";
  const taskOf = new Map<string, string>();
  for (const node of plan?.nodes ?? []) taskOf.set(String(node.id), node.task);
  const nameOf = (result: NodeResult, index: number): string => {
    const task = taskOf.get(String(result.nodeId))?.trim();
    if (task) return tr ? `"${clip(task, MAX_STEP_NAME)}" adımı` : `"${clip(task, MAX_STEP_NAME)}"`;
    return tr ? `${index + 1}. adım` : `step ${index + 1}`;
  };

  const ok = results.filter((r) => r.status === "ok").length;
  const sections = [tr ? `Tamamlanan adımlar: ${ok}/${results.length}.` : `Steps finished: ${ok} of ${results.length}.`];
  const unfinished: string[] = [];
  results.forEach((result, index) => {
    const name = nameOf(result, index);
    const output = result.output.trim();
    switch (result.status) {
      case "ok":
        sections.push(`${tr ? `${name} tamamlandı` : `Finished ${name}`}${output ? `:\n${output}` : "."}`);
        break;
      case "failed":
        unfinished.push(`${tr ? `${name} tamamlanamadı` : `Could not finish ${name}`} (${failedBecause(result, language)})`);
        break;
      case "skipped":
        unfinished.push(`${tr ? `${name} başlamadı` : `Did not start ${name}`} (${skippedBecause(result, language)})`);
        break;
      case "cancelled":
        unfinished.push(tr ? `${name} bitmeden durduruldu` : `Stopped ${name} before it finished`);
        break;
    }
  });
  if (unfinished.length > 0) sections.push(unfinished.join("\n"));
  return sections.join("\n\n");
}
