/**
 * LRN-20b — A REACTION IS ABOUT THE MESSAGE IT IS ON.
 *
 * Channels kept only "the instincts applied last in this chat", so a thumbs up
 * or down on any message, however old, credited whatever had run last, and the
 * trust ladder attributed it to the instinct's latest run. Now each final
 * response records what it is attributed to (the run, the person who asked for
 * it, the instincts the run applied, the warn-tier rules its footer named),
 * keyed by the sent message. A reaction resolves through the message it names;
 * a message with no record teaches nothing.
 *
 * The same record carries the run's warnings to the person: a warn-tier match
 * used to reach only the tool result the model reads, so nobody could say the
 * warning was useless. The response now ends with a short footer naming the
 * rules that warned, and the requester's reaction on it is their verdict.
 */

import { capLearnedText } from "./learned-text.js";
import { sanitizePromptInjection } from "../../agents/orchestrator-text-utils.js";
import type { FeedbackReactionEvent } from "../../core/event-bus.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import { getLoggerSafe } from "../../utils/logger.js";

/** A warn-tier rule named in a response's footer, and the tool it warned before. */
export interface WarnedRule {
  readonly instinctId: string;
  readonly toolName: string;
}

/** What a reaction on one sent response is attributed to. */
export interface ResponseAttribution {
  /** The instincts the run applied. */
  readonly instinctIds: readonly string[];
  /** The warn-tier rules the response's footer named; empty when it had none. */
  readonly warnedRules: readonly WarnedRule[];
  /** The run that produced the response: a trust signal is keyed by it. */
  readonly runId?: string;
  /** Who sent the message the run answered: the only person whose reaction moves trust. */
  readonly requesterUserId?: string;
}

/** A warn-tier rule as it fired during a run, before it becomes footer text. */
export interface RunWarning extends WarnedRule {
  /** The rule's stored name. Learned text: filtered when rendered. */
  readonly name: string;
  /** A curated seed rule rather than a learned one. */
  readonly seed: boolean;
}

/** A run's final response: its attribution and the footer to append ("" for none). */
export interface RunResponse {
  readonly attribution: ResponseAttribution;
  readonly footer: string;
}

/** The footer never takes more than this many lines. */
export const WARNING_FOOTER_MAX_LINES = 3;
const FOOTER_NAME_MAX_CHARS = 80;
const FOOTER_TOOL_MAX_CHARS = 40;

/** Learned text for one footer line: the prompt-injection filter, one line, capped. */
function footerText(text: string, max: number): string {
  return capLearnedText(sanitizePromptInjection(text).replace(/\s+/gu, " ").trim(), max);
}

/**
 * The run's response for its warnings: a footer naming each rule that warned
 * (at most {@link WARNING_FOOTER_MAX_LINES} lines; past that, the last line
 * counts the rest) and the attribution the requester's reaction judges. Only
 * the rules the footer names are judged by that reaction.
 */
export function buildRunResponse(params: {
  instinctIds: readonly string[];
  warnings: readonly RunWarning[];
  runId?: string;
  requesterUserId?: string;
}): RunResponse {
  const unique = [...new Map(params.warnings.map((w) => [w.instinctId, w])).values()];
  const named = unique.length > WARNING_FOOTER_MAX_LINES
    ? unique.slice(0, WARNING_FOOTER_MAX_LINES - 1)
    : unique;
  const lines = named.map((w) =>
    `⚠️ ${w.seed ? "Curated" : "Learned"} rule warned before ${footerText(w.toolName, FOOTER_TOOL_MAX_CHARS)}: ` +
    footerText(w.name, FOOTER_NAME_MAX_CHARS),
  );
  if (named.length < unique.length) {
    lines.push(`⚠️ …and ${unique.length - named.length} more rule warnings`);
  }
  return {
    attribution: {
      instinctIds: [...new Set(params.instinctIds)],
      warnedRules: named.map((w) => ({ instinctId: w.instinctId, toolName: w.toolName })),
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.requesterUserId ? { requesterUserId: params.requesterUserId } : {}),
    },
    footer: lines.join("\n"),
  };
}

/** `text` with the footer after a blank line, or unchanged when there is none. */
export function appendWarningFooter(text: string, footer: string): string {
  return footer ? `${text}\n\n${footer}` : text;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A reaction on a response older than this teaches nothing. */
export const RESPONSE_ATTRIBUTION_TTL_MS = 7 * DAY_MS;
/** The most sent-response records kept. */
export const RESPONSE_ATTRIBUTION_MAX_ENTRIES = 5_000;
/** How long a background run's response waits for the task system to send it. */
const STAGED_TTL_MS = 60 * 60 * 1000;
const STAGED_MAX_ENTRIES = 200;
const PRUNE_EVERY_WRITES = 100;

/**
 * The central registry: sent responses by (channel, chat, message ref), in
 * learning storage, bounded by age and count. Also holds, in memory, a
 * background run's response until the task system delivers it.
 */
export class ResponseAttributionLedger {
  private readonly staged = new Map<string, { response: RunResponse; at: number }>();
  private writesSincePrune = 0;

  constructor(
    private readonly storage: LearningStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** Hold a background run's response until its result is sent. */
  stageForRun(runId: string, response: RunResponse): void {
    const at = this.now();
    for (const [key, entry] of this.staged) {
      if (at - entry.at > STAGED_TTL_MS) this.staged.delete(key);
    }
    this.staged.delete(runId);
    this.staged.set(runId, { response, at });
    while (this.staged.size > STAGED_MAX_ENTRIES) {
      const oldest = this.staged.keys().next().value;
      if (oldest === undefined) break;
      this.staged.delete(oldest);
    }
  }

  /** The staged response for a run, once. */
  takeForRun(runId: string): RunResponse | undefined {
    const entry = this.staged.get(runId);
    this.staged.delete(runId);
    if (!entry || this.now() - entry.at > STAGED_TTL_MS) return undefined;
    return entry.response;
  }

  /** Remember what one sent message is attributed to. */
  record(channel: string, chatId: string, messageRef: string, attribution: ResponseAttribution): void {
    try {
      this.storage.recordResponseAttribution({
        channel,
        chatId,
        messageRef,
        ...(attribution.runId ? { runId: attribution.runId } : {}),
        ...(attribution.requesterUserId ? { requesterUserId: attribution.requesterUserId } : {}),
        instinctIds: [...attribution.instinctIds],
        warnedRules: attribution.warnedRules.map((r) => ({ instinctId: r.instinctId, toolName: r.toolName })),
        createdAt: this.now(),
      });
      this.writesSincePrune += 1;
      if (this.writesSincePrune >= PRUNE_EVERY_WRITES) {
        this.writesSincePrune = 0;
        this.prune();
      }
    } catch (err) {
      // Bookkeeping: a failed write must never fail the send it follows.
      getLoggerSafe().debug("Response attribution not recorded", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * What a reaction on `messageRef` is attributed to. Without a ref, the chat's
   * most recent recorded response: only for channels whose feedback cannot name
   * a message. Null when nothing (recent enough) was recorded.
   */
  resolve(channel: string, chatId: string, messageRef?: string): ResponseAttribution | null {
    try {
      const row = this.storage.getResponseAttribution(
        channel,
        chatId,
        messageRef,
        this.now() - RESPONSE_ATTRIBUTION_TTL_MS,
      );
      if (!row) return null;
      return {
        instinctIds: row.instinctIds,
        warnedRules: row.warnedRules,
        ...(row.runId ? { runId: row.runId } : {}),
        ...(row.requesterUserId ? { requesterUserId: row.requesterUserId } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Drop records past the TTL and past the count bound; returns how many went. */
  prune(): number {
    return this.storage.pruneResponseAttributions(
      this.now() - RESPONSE_ATTRIBUTION_TTL_MS,
      RESPONSE_ATTRIBUTION_MAX_ENTRIES,
    );
  }
}

/** The message a reaction is on. No `messageRef`: the chat's latest response. */
export interface ReactionTarget {
  readonly chatId: string;
  readonly messageRef?: string;
}

/**
 * What a channel is handed for feedback: it records each final response it
 * sends under the sent message's ref, and reports reactions by the ref of the
 * message they are on.
 */
export interface ResponseFeedbackPort {
  recordResponse(chatId: string, messageRef: string, attribution: ResponseAttribution): void;
  /** True when the reaction reached a recorded response that names something to learn about. */
  react(
    type: "thumbs_up" | "thumbs_down",
    target: ReactionTarget,
    userId: string | undefined,
    source: "reaction" | "button",
  ): boolean;
}

/**
 * The port for one channel: records go to the ledger, and a reaction becomes
 * a feedback:reaction event carrying the reacted-to response's own
 * attribution. A reaction whose message has no record, or whose record names
 * nothing, is dropped.
 */
export function createResponseFeedbackPort(params: {
  ledger: ResponseAttributionLedger;
  channel: string;
  emit: (event: FeedbackReactionEvent) => void;
}): ResponseFeedbackPort {
  const { ledger, channel, emit } = params;
  return {
    recordResponse: (chatId, messageRef, attribution) => ledger.record(channel, chatId, messageRef, attribution),
    react: (type, target, userId, source) => {
      const attribution = ledger.resolve(channel, target.chatId, target.messageRef);
      if (!attribution) return false;
      if (attribution.instinctIds.length === 0 && attribution.warnedRules.length === 0) return false;
      emit({
        type,
        instinctIds: [...attribution.instinctIds],
        userId,
        source,
        channel,
        timestamp: Date.now(),
        ...(attribution.runId ? { runId: attribution.runId } : {}),
        ...(attribution.requesterUserId ? { requesterUserId: attribution.requesterUserId } : {}),
        ...(attribution.warnedRules.length > 0 ? { warnedRules: [...attribution.warnedRules] } : {}),
      });
      return true;
    },
  };
}
