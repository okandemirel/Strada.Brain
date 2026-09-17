/**
 * DURABLE PROJECT HISTORY (improvement 6.6).
 *
 * THE GAP THIS CLOSES. "Kalıcı proje geçmişi: sunucu tarafı, izin kapsamlı,
 * sürüme bağlı" — until now the portal's history was whatever the browser still
 * held. The web channel replays cached monitor state and buffered frames, and
 * the tasks database records tasks, but nothing could answer "which decision was
 * taken, on which build, by whom, and when" after a daemon restart or on a
 * second device. This module is that answer: an append-only, server-side log in
 * the daemon's own SQLite (src/daemon/daemon-storage.ts), scoped by owner and
 * bound to a version.
 *
 * THREE KINDS, because those are the things a person comes back and asks about:
 *   - `decision`  an approval, a rejection, a gate verdict
 *   - `delivery`  a build that shipped: campaign revision + commit sha + verdict
 *   - `milestone` a campaign milestone
 *
 * WHAT EVERY ROW CARRIES: a stable event id, the owner identity (userId and/or
 * the portal's profileId), the project, the version it refers to (campaign
 * revision and/or commit sha), a monotonic timestamp, and the payload.
 *
 * PERMISSION SCOPE. A caller reads their own events plus what is explicitly
 * shared ('shared' scope, or their identity named in `sharedWith`). An event
 * nobody can be attributed to is stored with scope 'unknown' and reaches NOBODY
 * — there is deliberately no "show me everything" read here. The gate is
 * enforced in SQL before any LIMIT (DaemonStorage.listProjectHistoryRows), not
 * by filtering in JS afterwards, because a post-LIMIT filter lets one person's
 * events eat another person's page.
 *
 * APPEND-ONLY. There is no update and no delete. Recording an id twice throws
 * instead of overwriting, so a replayed writer cannot rewrite what was decided.
 *
 * MONOTONIC TIME. `recordedAt` never goes backwards, even when the wall clock
 * does (an NTP step, a laptop resuming, a caller passing an older stamp): the
 * store takes max(now, highWaterMark + 1), and the watermark is re-read from the
 * table on the first write after a restart. Ordering therefore survives the
 * restart that this improvement exists for.
 */

import { randomBytes } from "node:crypto";
import type { DaemonStorage, ProjectHistoryRow } from "../daemon/daemon-storage.js";

// =============================================================================
// TYPES
// =============================================================================

/** The things a person later asks about. */
export const PROJECT_HISTORY_KINDS = ["decision", "delivery", "milestone"] as const;
export type ProjectHistoryEventKind = (typeof PROJECT_HISTORY_KINDS)[number];

/**
 * 'user'    → reaches the named identity (and anyone in sharedWith)
 * 'shared'  → reaches every caller of the project
 * 'unknown' → reaches nobody (an event we could not attribute)
 */
export type ProjectHistoryOwnerScope = "user" | "shared" | "unknown";

export interface ProjectHistoryOwner {
  scope: ProjectHistoryOwnerScope;
  /** Cross-channel identity. */
  userId?: string;
  /** The web portal's profile id — the identity a browser read carries. */
  profileId?: string;
  /** Identities this event was EXPLICITLY shared with. */
  sharedWith?: string[];
}

/** The build the event refers to. */
export interface ProjectHistoryVersion {
  campaignRevision?: string;
  commitSha?: string;
}

export interface ProjectHistoryEvent {
  id: string;
  kind: ProjectHistoryEventKind;
  projectId: string;
  owner: ProjectHistoryOwner;
  version: ProjectHistoryVersion;
  summary: string;
  payload: Record<string, unknown>;
  /** Monotonic, milliseconds. */
  recordedAt: number;
}

export interface RecordProjectHistoryInput {
  kind: ProjectHistoryEventKind;
  projectId: string;
  summary: string;
  owner: ProjectHistoryOwner;
  version?: ProjectHistoryVersion;
  payload?: Record<string, unknown>;
  /** Supply an id only to reconcile an event recorded elsewhere. */
  id?: string;
  /** Wall-clock hint; the monotonic rule still applies. */
  recordedAt?: number;
}

export interface ReadProjectHistoryQuery {
  /** The identity doing the reading. Absent ⇒ 'shared' events only. */
  viewer?: string;
  projectId?: string;
  kinds?: ProjectHistoryEventKind[];
  limit?: number;
}

// =============================================================================
// LIMITS AND VALIDATION
// =============================================================================

export const PROJECT_HISTORY_DEFAULT_LIMIT = 50;
export const PROJECT_HISTORY_MAX_LIMIT = 500;
/** An identity longer than this, or one holding a comma, is not an identity. */
export const PROJECT_HISTORY_MAX_IDENTITY_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_SHARED_WITH = 64;

/** `hist_<kind>_<base36 millis>_<8 hex>` — checkable without touching storage. */
const EVENT_ID_RE = /^hist_(decision|delivery|milestone)_[0-9a-z]{6,12}_[0-9a-f]{8}$/;

/** True for a well-formed event id. Routes call this BEFORE any storage read. */
export function isProjectHistoryEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID_RE.test(value);
}

/** Mint an id for a new event of `kind`. */
export function newProjectHistoryEventId(kind: ProjectHistoryEventKind, now = Date.now()): string {
  return `hist_${kind}_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** True for one of the three kinds. */
export function isProjectHistoryKind(value: unknown): value is ProjectHistoryEventKind {
  return typeof value === "string" && (PROJECT_HISTORY_KINDS as readonly string[]).includes(value);
}

/**
 * An identity as stored: trimmed, or undefined when it is not usable. A comma
 * would break the shared_with matching, so it is rejected loudly rather than
 * silently splitting one identity into two.
 */
function normalizeIdentity(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > PROJECT_HISTORY_MAX_IDENTITY_LENGTH) {
    throw new Error(`${field} is too long (max ${PROJECT_HISTORY_MAX_IDENTITY_LENGTH})`);
  }
  if (trimmed.includes(",")) throw new Error(`${field} must not contain a comma`);
  return trimmed;
}

/** A commit sha, lowercased — or a thrown error. Abbreviated shas are fine. */
function normalizeCommitSha(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("commitSha must be a string");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^[0-9a-fA-F]{7,64}$/.test(trimmed)) {
    throw new Error(`commitSha ${JSON.stringify(trimmed)} is not a commit sha`);
  }
  return trimmed.toLowerCase();
}

function normalizeRevision(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("campaignRevision must be a string");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200) throw new Error("campaignRevision is too long (max 200)");
  return trimmed;
}

/**
 * Ownership as it will be stored.
 *
 * THE "UNKNOWN REACHES NOBODY" RULE. A caller may ask for scope 'user' and yet
 * supply no identity — a background writer with no session, a reconciliation
 * replay. That event is not attributable, so it is DOWNGRADED to 'unknown'
 * rather than being handed to whoever reads next. It is still recorded: history
 * we cannot attribute is still history, it is just unreadable until something
 * can prove whose it is.
 */
export function normalizeProjectHistoryOwner(owner: ProjectHistoryOwner | undefined): ProjectHistoryOwner {
  const scope = owner?.scope;
  if (scope !== "user" && scope !== "shared" && scope !== "unknown") {
    throw new Error(`owner.scope must be one of user | shared | unknown (got ${String(scope)})`);
  }
  const userId = normalizeIdentity(owner?.userId, "owner.userId");
  const profileId = normalizeIdentity(owner?.profileId, "owner.profileId");
  const sharedRaw = owner?.sharedWith;
  if (sharedRaw !== undefined && !Array.isArray(sharedRaw)) {
    throw new Error("owner.sharedWith must be an array");
  }
  if (Array.isArray(sharedRaw) && sharedRaw.length > MAX_SHARED_WITH) {
    throw new Error(`owner.sharedWith holds too many identities (max ${MAX_SHARED_WITH})`);
  }
  const sharedWith = Array.isArray(sharedRaw)
    ? [...new Set(sharedRaw.map((id) => normalizeIdentity(id, "owner.sharedWith[]")).filter((id): id is string => !!id))]
    : [];

  if (scope === "user" && !userId && !profileId) {
    // Unattributable: reaches nobody. A sharedWith list cannot rescue it —
    // nobody can be shown an event whose owner does not exist.
    return { scope: "unknown" };
  }
  return {
    scope,
    ...(userId ? { userId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(sharedWith.length > 0 ? { sharedWith } : {}),
  };
}

// =============================================================================
// STORE
// =============================================================================

/**
 * The append-only history, over one DaemonStorage connection.
 *
 * Reads are stateless; the only state is the monotonic watermark, which is why
 * writers should share one instance per storage — see
 * {@link getProjectHistoryStore}.
 */
export class ProjectHistoryStore {
  private highWaterMark: number | undefined;

  constructor(private readonly storage: DaemonStorage) {}

  /**
   * Append one event and return it as stored (its id, its normalized owner and
   * its monotonic timestamp included).
   */
  record(input: RecordProjectHistoryInput): ProjectHistoryEvent {
    if (!isProjectHistoryKind(input?.kind)) {
      throw new Error(`Unknown project history kind ${String(input?.kind)}`);
    }
    const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
    if (!projectId) throw new Error("projectId is required");
    if (projectId.length > 400) throw new Error("projectId is too long (max 400)");
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary) throw new Error("summary is required");
    if (summary.length > MAX_SUMMARY_LENGTH) {
      throw new Error(`summary is too long (max ${MAX_SUMMARY_LENGTH})`);
    }

    const owner = normalizeProjectHistoryOwner(input.owner);
    const campaignRevision = normalizeRevision(input.version?.campaignRevision);
    const commitSha = normalizeCommitSha(input.version?.commitSha);
    const version: ProjectHistoryVersion = {
      ...(campaignRevision ? { campaignRevision } : {}),
      ...(commitSha ? { commitSha } : {}),
    };
    // A DELIVERY IS THE VERSION. "Show me that build" is unanswerable without
    // one, so a delivery that names neither a revision nor a sha is refused at
    // the door instead of becoming a row nobody can act on.
    if (input.kind === "delivery" && !version.campaignRevision && !version.commitSha) {
      throw new Error("A delivery must name the version it shipped (campaignRevision and/or commitSha)");
    }

    const payload = input.payload ?? {};
    if (typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload must be an object");
    }
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new Error("payload is not serializable");
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload is too large (max ${MAX_PAYLOAD_BYTES} bytes)`);
    }

    if (input.id !== undefined && !isProjectHistoryEventId(input.id)) {
      throw new Error(`${String(input.id)} is not a project history event id`);
    }
    const recordedAt = this.nextTimestamp(input.recordedAt);
    const id = input.id ?? newProjectHistoryEventId(input.kind, recordedAt);

    const row: ProjectHistoryRow = {
      id,
      kind: input.kind,
      project_id: projectId,
      owner_scope: owner.scope,
      owner_user_id: owner.userId ?? null,
      owner_profile_id: owner.profileId ?? null,
      shared_with: owner.sharedWith && owner.sharedWith.length > 0 ? owner.sharedWith.join(",") : null,
      campaign_revision: version.campaignRevision ?? null,
      commit_sha: version.commitSha ?? null,
      summary,
      payload: payloadJson,
      recorded_at: recordedAt,
    };
    this.storage.insertProjectHistoryRow(row);
    return { id, kind: input.kind, projectId, owner, version, summary, payload, recordedAt };
  }

  /** The newest events this viewer may see, newest first. */
  list(query: ReadProjectHistoryQuery = {}): ProjectHistoryEvent[] {
    const limit = clampLimit(query.limit);
    const rows = this.storage.listProjectHistoryRows({
      ...(query.viewer ? { viewer: query.viewer } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.kinds && query.kinds.length > 0 ? { kinds: [...query.kinds] } : {}),
      limit,
    });
    return rows.map(rowToEvent);
  }

  /** One event, if this viewer may see it. */
  get(id: string, viewer?: string): ProjectHistoryEvent | undefined {
    if (!isProjectHistoryEventId(id)) return undefined;
    const row = this.storage.getProjectHistoryRow(id, viewer);
    return row ? rowToEvent(row) : undefined;
  }

  /**
   * The next timestamp: never behind anything already recorded. The watermark is
   * loaded from the table on first use, so it survives a restart with a clock
   * that has moved backwards.
   */
  private nextTimestamp(hint?: number): number {
    if (this.highWaterMark === undefined) {
      this.highWaterMark = this.storage.getProjectHistoryHighWaterMark();
    }
    const wall = typeof hint === "number" && Number.isFinite(hint) ? Math.floor(hint) : Date.now();
    const next = Math.max(wall, this.highWaterMark + 1);
    this.highWaterMark = next;
    return next;
  }
}

/** A limit that is always a sane positive integer. */
export function clampLimit(limit: unknown): number {
  const parsed = typeof limit === "number" ? limit : Number.parseInt(String(limit ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return PROJECT_HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), PROJECT_HISTORY_MAX_LIMIT);
}

function rowToEvent(row: ProjectHistoryRow): ProjectHistoryEvent {
  const sharedWith = row.shared_with ? row.shared_with.split(",").filter(Boolean) : [];
  return {
    id: row.id,
    kind: row.kind as ProjectHistoryEventKind,
    projectId: row.project_id,
    owner: {
      scope: (row.owner_scope ?? "unknown") as ProjectHistoryOwnerScope,
      ...(row.owner_user_id ? { userId: row.owner_user_id } : {}),
      ...(row.owner_profile_id ? { profileId: row.owner_profile_id } : {}),
      ...(sharedWith.length > 0 ? { sharedWith } : {}),
    },
    version: {
      ...(row.campaign_revision ? { campaignRevision: row.campaign_revision } : {}),
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    },
    summary: row.summary,
    payload: parsePayload(row.payload),
    recordedAt: row.recorded_at,
  };
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * One store per storage connection, so every writer in the process shares the
 * monotonic watermark instead of each holding its own idea of "now".
 */
const stores = new WeakMap<DaemonStorage, ProjectHistoryStore>();

export function getProjectHistoryStore(storage: DaemonStorage): ProjectHistoryStore {
  const existing = stores.get(storage);
  if (existing) return existing;
  const created = new ProjectHistoryStore(storage);
  stores.set(storage, created);
  return created;
}
