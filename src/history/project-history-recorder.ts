/**
 * THE SEAM BETWEEN A PRODUCER AND THE DURABLE HISTORY (improvement 6.6).
 *
 * The things worth remembering are known in places that have no business
 * opening daemon.db: the approval queue decides, the campaign manager delivers
 * and closes milestones. So each of those takes an injected recorder — the same
 * shape as `setCampaignSpendReader` — and this module is the only place that
 * knows the schema. Nothing wired ⇒ nothing recorded, and the producer does not
 * care.
 *
 * TWO RULES THAT MATTER MORE THAN VOLUME.
 *
 * 1. A RECORDER NEVER TAKES THE PRODUCER DOWN. History is a side effect of
 *    doing the work; the work is the product. Every failure here is caught and
 *    logged, and the producer is handed `undefined`. (Producers wrap their call
 *    as well, because an injected recorder may be someone else's.)
 *
 * 2. AN OWNER IS PROVEN, NEVER WIDENED. A producer that cannot name a person
 *    passes no identity, and the event is recorded with scope 'unknown', which
 *    reaches nobody. 'shared' is only ever used when the producer says so
 *    explicitly (`shared: true`) — it is never the fallback for a missing
 *    identity, because that would hand one person's event to everybody.
 */

import type { DaemonStorage } from "../daemon/daemon-storage.js";
import { getLoggerSafe } from "../utils/logger.js";
import {
  getProjectHistoryStore,
  isAlreadyRecordedError,
  projectHistoryEventIdFor,
  type ProjectHistoryEvent,
  type ProjectHistoryEventKind,
  type ProjectHistoryVersion,
} from "./project-history.js";

/**
 * Ownership as a PRODUCER knows it. No scope field: a producer states the facts
 * it has (an identity, or an explicit decision to share) and the recorder turns
 * that into a scope. An input with neither becomes 'unknown'.
 */
export interface ProjectHistoryRecorderOwner {
  userId?: string;
  /** The web portal's profile id. */
  profileId?: string;
  /** Explicitly project-wide. Never inferred from a missing identity. */
  shared?: boolean;
  /** Identities to share this one event with, beyond its owner. */
  sharedWith?: string[];
}

export interface ProjectHistoryRecorderInput {
  kind: ProjectHistoryEventKind;
  summary: string;
  owner?: ProjectHistoryRecorderOwner;
  version?: ProjectHistoryVersion;
  payload?: Record<string, unknown>;
  /** Defaults to the project the recorder was built for. */
  projectId?: string;
  /**
   * WHAT THIS FACT IS, for producers that are called again on the same fact:
   * `persist()` runs on every campaign save, and a delivery report is rebuilt
   * whenever it is re-sent. The key becomes the event id, so the append-only
   * table refuses the second write instead of accumulating duplicates — and it
   * keeps refusing after a restart, which an in-memory guard cannot.
   */
  dedupeKey?: string;
}

/**
 * What a producer is given. Returns the recorded event, or undefined when
 * nothing was recorded — which is never an error the producer must handle.
 */
export type ProjectHistoryRecorder = (
  input: ProjectHistoryRecorderInput,
) => ProjectHistoryEvent | undefined;

/**
 * Build a recorder over one DaemonStorage connection, for one project.
 *
 * Wired at bootstrap, where the storage and the project are both known; the
 * producers only ever see the function.
 */
export function createProjectHistoryRecorder(
  storage: DaemonStorage,
  options: { projectId: string },
): ProjectHistoryRecorder {
  const fallbackProject = options.projectId.trim();
  return (input: ProjectHistoryRecorderInput): ProjectHistoryEvent | undefined => {
    try {
      const projectId = (input.projectId ?? "").trim() || fallbackProject;
      return getProjectHistoryStore(storage).record({
        kind: input.kind,
        projectId,
        summary: input.summary,
        owner: toOwner(input.owner),
        ...(input.version ? { version: input.version } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
        ...(input.dedupeKey ? { id: projectHistoryEventIdFor(input.kind, input.dedupeKey) } : {}),
      });
    } catch (error) {
      // A fact already on the record is the dedupe working, not a failure.
      if (isAlreadyRecordedError(error)) {
        getLoggerSafe().debug("Project history event already recorded", {
          kind: input.kind,
          dedupeKey: input.dedupeKey,
        });
        return undefined;
      }
      // Losing a history row is a reporting defect; failing the decision, the
      // delivery or the milestone because of one would be a product defect.
      getLoggerSafe().warn("Project history event was not recorded", {
        kind: input.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
}

/**
 * Producer facts → a stored scope. `shared: true` is the ONLY route to
 * 'shared'; an input with no identity stays attributable to nobody.
 */
function toOwner(owner: ProjectHistoryRecorderOwner | undefined): {
  scope: "user" | "shared" | "unknown";
  userId?: string;
  profileId?: string;
  sharedWith?: string[];
} {
  if (owner?.shared === true) {
    return {
      scope: "shared",
      ...(owner.sharedWith && owner.sharedWith.length > 0 ? { sharedWith: owner.sharedWith } : {}),
    };
  }
  return {
    // 'user' with no identity is downgraded to 'unknown' by
    // normalizeProjectHistoryOwner — that downgrade is the point.
    scope: "user",
    ...(owner?.userId ? { userId: owner.userId } : {}),
    ...(owner?.profileId ? { profileId: owner.profileId } : {}),
    ...(owner?.sharedWith && owner.sharedWith.length > 0 ? { sharedWith: owner.sharedWith } : {}),
  };
}

/**
 * Call a recorder that may be anybody's, and never let it interrupt the caller.
 * Producers use this so a hostile or broken injection cannot turn a recorded
 * decision into a thrown one.
 */
export function safeRecordProjectHistory(
  recorder: ProjectHistoryRecorder | undefined,
  input: ProjectHistoryRecorderInput,
): ProjectHistoryEvent | undefined {
  if (!recorder) return undefined;
  try {
    return recorder(input);
  } catch (error) {
    getLoggerSafe().warn("Project history recorder threw; the work is unaffected", {
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
