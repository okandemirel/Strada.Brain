/**
 * Change-review REST endpoints (Codex round 11 #20).
 *
 *   GET  /api/workspace/change-review                  -- the newest review, previewed
 *   GET  /api/workspace/change-review/:id              -- one review, previewed
 *   POST /api/workspace/change-review/:id/decisions    -- apply the user's decisions
 *
 * THE DEFECT THIS CLOSES. The undo itself has existed since improvement 6.5
 * (src/agents/multi/workspace-change-review.ts: previewUndo / applyUndo /
 * keepChanges), and the portal has had a review-aware decision queue. Between
 * the two there was nothing: no route, no caller, no id. Rejecting a change in
 * the browser swapped the text on screen and appended an in-memory decision
 * that never left the tab, so the run's bytes stayed in the project and a reload
 * lost the decision without saying so. This file is the transport, and it is the
 * only thing that may report a rejection as done: the portal presents a revert
 * only after a response here says the path was actually put back.
 *
 * WHO MAY DECIDE (Codex round 12 #10). A keep or a revert writes the user's
 * project and moves its git HEAD, so it is an instance-level power, not one
 * identity's own traffic. Admission used to be the portal's Origin/Referer check
 * alone: anything it let through could revert another profile's run, because the
 * handler was given no identity and asked no question. It now resolves the
 * caller the way the shared-instance model does (plan 6.14,
 * src/channels/web/instance-access.ts): the profile id/token pair is VERIFIED
 * against the identity store the web channel issued it from — a profile id on
 * its own is a public value and proves nothing — and `decideInstanceAccess`
 * answers. The owner decides; a guest is refused; an unattributed request is
 * granted only while the instance has a single identity, which is the model's
 * own rule and keeps the ordinary one-person portal working untouched.
 *
 * WHAT THE WEB CHANNEL STILL OWES. `proxyToDashboard` forwards Authorization,
 * Origin and Referer and drops every other request header, so a browser request
 * reaches this route unattributed even when the portal knows exactly who sent
 * it. Until the proxy forwards `x-strada-profile-id` / `x-strada-profile-token`,
 * a SHARED instance refuses these requests (`deny:unidentified`) — the same
 * trade-off instance-access.ts already documents for owner-only settings writes.
 *
 * WHY DECISIONS ARE APPLIED AS A WHOLE. `applyUndo` restores the review — all of
 * its ready entries, plus the run's commits — because that is the only state the
 * previous copies and the git compare-and-swap can put back consistently. There
 * is no per-path undo underneath, so this route refuses a set of decisions that
 * would undo SOME of a review's ready entries instead of quietly reverting the
 * rest too, and refuses a mixed keep/undo set for the same reason. A refusal
 * touches nothing.
 */

import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  applyUndo,
  isReviewId,
  keepChangesExclusive,
  listChangeReviews,
  previewRecord,
  previewUndo,
  readChangeReview,
  readDecisionOutcome,
  writeDecisionOutcome,
  type ChangeReviewRecord,
  type RecordedDecision,
  type UndoPreview,
} from "../agents/multi/workspace-change-review.js";
import {
  decideInstanceAccess,
  instanceRoleOf,
  type AccessDecision,
  type InstanceFacts,
} from "../channels/web/instance-access.js";
import { WebIdentityStore } from "../channels/web/web-identity-store.js";
import { getCachedConfig } from "../config/config.js";
import { getLoggerSafe } from "../utils/logger.js";

/** Route prefix. Registered before the file-explorer routes, which 404 the rest. */
export const CHANGE_REVIEW_ROUTE_PREFIX = "/api/workspace/change-review";

/** Largest decisions body accepted (the portal proxy caps at 64 KB anyway). */
const MAX_BODY_BYTES = 32_768;

/** Most decisions one request may carry. A review of that size is already a bug. */
const MAX_DECISIONS = 2000;

const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
};

export type ChangeDecision = "keep" | "undo";

export interface DecisionInput {
  path: string;
  decision: ChangeDecision;
}

export interface DecisionsRequest {
  decisions?: DecisionInput[];
  /**
   * Passed through to applyUndo. "refuse" (the default) undoes nothing when any
   * path moved since the run published it; "skip" undoes the rest and says what
   * it left. The portal only ever sends "skip" for a decision the user
   * confirmed.
   */
  onBlocked?: "refuse" | "skip";
}

/**
 * What the portal may present as done. `applied` is what this request actually
 * changed on disk — nothing else counts as a revert.
 */
export interface DecisionsResponse {
  reviewId: string;
  outcome: "undone" | "partially-undone" | "kept";
  applied: string[];
  kept: string[];
  failed: string[];
  leftOver: string[];
  historyMoved: boolean;
  review: UndoPreview | null;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, NO_CACHE_HEADERS);
  res.end(JSON.stringify(body));
}

// -- Who is asking (round 12 #10) -------------------------------------------

/**
 * The part of the web channel's identity store this route needs. Structural, so
 * the daemon can hand over its live `WebIdentityStore` and a test can hand over
 * a fake, and so this module does not depend on the channel's class.
 */
export interface ChangeReviewIdentityStore {
  /** True only for a pair THIS instance issued. */
  verify(profileId: string, profileToken: string): boolean;
  /** The instance owner (the first identity ever issued), if one is recorded. */
  ownerProfileId(): string | undefined;
  /** True when this profile id was issued here — a guest rather than a stranger. */
  has(profileId: string): boolean;
  /** How many identities exist; more than one means the instance is genuinely shared. */
  count(): number;
}

let injectedIdentityStore: ChangeReviewIdentityStore | null = null;
let openedIdentityStore: ChangeReviewIdentityStore | undefined;
/** Set only when opening the store FAILED — "not there yet" is retried. */
let identityStoreUnavailable = false;

/**
 * Hand this route the identity store to verify callers against (the daemon's
 * own, or a fake in a test). `null` clears it, and the route falls back to
 * reading the identity database the web channel keeps.
 */
export function setChangeReviewIdentityStore(store: ChangeReviewIdentityStore | null): void {
  injectedIdentityStore = store;
  openedIdentityStore = undefined;
  identityStoreUnavailable = false;
}

/**
 * The identity store to judge this request with.
 *
 * With nothing injected the web channel's own database is opened where
 * bootstrap-channels.ts puts it (`<memory.dbPath>/web-identities.db`) — that is
 * how a request that arrives straight at the dashboard port, bypassing the
 * portal, is still judged against real identities. A project with no such
 * database has never issued one, so there is no second identity to be separated
 * from and the fallback is "sole identity", not "refuse everything".
 */
function identityStore(): ChangeReviewIdentityStore | undefined {
  if (injectedIdentityStore) return injectedIdentityStore;
  if (openedIdentityStore) return openedIdentityStore;
  if (identityStoreUnavailable) return undefined;
  try {
    const config = getCachedConfig();
    const dbPath = config ? join(config.memory.dbPath, "web-identities.db") : "";
    // Only an EXISTING database is opened: creating one here would invent an
    // identity table for a project that has never served a portal. A database
    // that is not there YET is looked for again on the next request — caching
    // "no identities" would leave the gate permissive for the life of the
    // process once a single request arrived before the portal's first browser.
    if (dbPath && existsSync(dbPath)) {
      openedIdentityStore = new WebIdentityStore(dbPath);
    }
  } catch (error) {
    getLoggerSafe().warn("Change-review could not open the web identity store; callers cannot be attributed", {
      error: String(error),
    });
    identityStoreUnavailable = true;
  }
  return openedIdentityStore;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * May this caller act on this project's change reviews?
 *
 * The identity is the VERIFIED profile pair, never a claimed field: `profileId`
 * travels to the browser and lives in its localStorage, so a request naming the
 * owner is not the owner. Everything else is the shared-instance model's own
 * decision function, on the surface that covers "changes the one shared thing".
 */
function authorizeChangeReview(req: IncomingMessage, what: string): AccessDecision {
  const store = identityStore();
  const claimedId = singleHeader(req.headers?.["x-strada-profile-id"])?.trim();
  const claimedToken = singleHeader(req.headers?.["x-strada-profile-token"])?.trim();
  const verified =
    store && claimedId && claimedToken && store.verify(claimedId, claimedToken) ? claimedId : undefined;
  const facts: InstanceFacts = {
    shared: (store?.count() ?? 0) > 1,
    ...(store?.ownerProfileId() !== undefined ? { ownerProfileId: store!.ownerProfileId()! } : {}),
  };
  const role = instanceRoleOf(verified, facts, (candidate) => store?.has(candidate) ?? false);
  return decideInstanceAccess({
    surface: "instance:control",
    actor: { ...(verified ? { profileId: verified } : {}), role },
    instance: facts,
    what,
  });
}

/** Answer 403 with the model's own reason, and return false, when refused. */
function allowed(req: IncomingMessage, res: ServerResponse, what: string): boolean {
  const decision = authorizeChangeReview(req, what);
  if (decision.allowed) return true;
  getLoggerSafe().warn("Change-review request refused", { what, code: decision.code, reason: decision.reason });
  jsonResponse(res, 403, {
    error: "Forbidden",
    reason: decision.reason,
    surface: decision.surface,
    code: decision.code,
  });
  return false;
}

/** Forward slashes, whatever the recording platform used. */
export function normalizeReviewPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** A preview with every path in the portal's form. */
function portablePreview(preview: UndoPreview): UndoPreview {
  return {
    ...preview,
    entries: preview.entries.map((entry) => ({ ...entry, path: normalizeReviewPath(entry.path) })),
  };
}

function readJsonBody<T>(req: IncomingMessage, res: ServerResponse, maxBytes = MAX_BODY_BYTES): Promise<T | null> {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        aborted = true;
        req.on("error", () => undefined);
        req.destroy();
        jsonResponse(res, 413, { error: "Request body too large" });
        resolve(null);
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(body || "{}") as T);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" });
        resolve(null);
      }
    });
    req.on("error", () => {
      if (aborted) return;
      aborted = true;
      jsonResponse(res, 400, { error: "Request body could not be read" });
      resolve(null);
    });
  });
}

/** The decisions, validated, or an error string. */
function parseDecisions(body: DecisionsRequest | null): { decisions: DecisionInput[] } | { error: string } {
  const raw = body?.decisions;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Missing decisions" };
  if (raw.length > MAX_DECISIONS) return { error: `Too many decisions (max ${MAX_DECISIONS})` };
  const seen = new Set<string>();
  const decisions: DecisionInput[] = [];
  for (const entry of raw) {
    const path = typeof entry?.path === "string" ? normalizeReviewPath(entry.path) : "";
    const decision = entry?.decision;
    if (!path) return { error: "Every decision needs a path" };
    if (decision !== "keep" && decision !== "undo") return { error: `Unknown decision for ${path}` };
    if (seen.has(path)) return { error: `Two decisions for ${path}` };
    seen.add(path);
    decisions.push({ path, decision });
  }
  return { decisions };
}

/**
 * One path segment as an id, or undefined when it is not decodable at all
 * (round 12 #12). `decodeURIComponent("%")` throws a URIError; a client bug is
 * a 400, never an exception out of the router.
 */
function decodeReviewId(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The same decisions, in a comparable order: a retry is a set, not a sequence. */
function decisionKey(decisions: readonly RecordedDecision[], onBlocked: string | undefined): string {
  return [
    onBlocked ?? "refuse",
    ...[...decisions].map((d) => `${d.path}=${d.decision}`).sort(),
  ].join("\n");
}

/**
 * The answer this review already gave to exactly these decisions, or undefined.
 *
 * Reconciled against the SPECIFIC review and the SPECIFIC decision set (round 12
 * #15): changing your mind is not a retry, so a different set falls through and
 * is applied normally — the engine deliberately allows undoing a review that was
 * kept.
 */
function replayedOutcome(
  record: ChangeReviewRecord,
  decisions: DecisionInput[],
  onBlocked: string | undefined,
): Record<string, unknown> | undefined {
  const previous = readDecisionOutcome(record.projectRoot, record.reviewId);
  if (!previous || previous.response === null || typeof previous.response !== "object") return undefined;
  if (decisionKey(previous.decisions, previous.onBlocked) !== decisionKey(decisions, onBlocked)) return undefined;
  return { ...(previous.response as Record<string, unknown>), replayed: true, decidedAt: previous.at };
}

/** Write down what a decision was told, so a lost answer can be recovered. */
function rememberOutcome(
  record: ChangeReviewRecord,
  decisions: DecisionInput[],
  onBlocked: string | undefined,
  response: DecisionsResponse,
): void {
  try {
    writeDecisionOutcome(record.projectRoot, {
      version: 1,
      reviewId: record.reviewId,
      at: Date.now(),
      decisions: decisions.map((d) => ({ path: d.path, decision: d.decision })),
      ...(onBlocked === "refuse" || onBlocked === "skip" ? { onBlocked } : {}),
      response,
    });
  } catch (error) {
    // The decision itself has already been applied; failing the request now
    // would be a worse lie than losing the replay.
    getLoggerSafe().warn("The change-review decision outcome could not be stored", {
      reviewId: record.reviewId,
      error: String(error),
    });
  }
}

/**
 * The review this request is allowed to act on: the recorded one, or undefined
 * (the caller has already answered). An id that is not a review id never
 * reaches the filesystem helpers, which throw on one.
 */
function loadReview(projectRoot: string, reviewId: string, res: ServerResponse): ChangeReviewRecord | undefined {
  if (!isReviewId(reviewId)) {
    jsonResponse(res, 400, { error: "Not a change review id" });
    return undefined;
  }
  const record = readChangeReview(projectRoot, reviewId);
  if (!record) {
    jsonResponse(res, 404, { error: `No change review named ${reviewId} in this project` });
    return undefined;
  }
  return record;
}

/**
 * Handle /api/workspace/change-review*. Returns true when it answered (or will
 * answer asynchronously), false when the URL is not ours.
 */
export function handleChangeReviewRoute(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string | undefined,
): boolean {
  if (!url.startsWith(CHANGE_REVIEW_ROUTE_PREFIX)) return false;
  const logger = getLoggerSafe();

  if (!projectRoot) {
    jsonResponse(res, 400, { error: "Project path not configured" });
    return true;
  }

  const path = url.split("?")[0] ?? url;

  // -- GET /api/workspace/change-review : the newest review ------------------
  if (method === "GET" && path === CHANGE_REVIEW_ROUTE_PREFIX) {
    if (!allowed(req, res, `GET ${path}`)) return true;
    void (async () => {
      try {
        const records = listChangeReviews(projectRoot);
        // The one a user is being asked about is the newest UNRESOLVED review;
        // a kept or undone one is history, and offering its entries again would
        // invite a second undo of something already decided.
        const record = records.find((r) => r.status === "open") ?? undefined;
        jsonResponse(res, 200, {
          review: record ? portablePreview(await previewRecord(record)) : null,
          total: records.length,
        });
      } catch (error) {
        logger.error("Change-review listing failed", { error: String(error) });
        jsonResponse(res, 500, { error: "Failed to read the change reviews" });
      }
    })();
    return true;
  }

  const oneMatch = /^\/api\/workspace\/change-review\/([^/]+)$/.exec(path);
  if (method === "GET" && oneMatch) {
    // ROUND 12 #12: "%" is not a decodable escape and decodeURIComponent throws
    // a URIError. This ran outside any try, synchronously, so a malformed URL
    // left the route by throwing instead of answering.
    const reviewId = decodeReviewId(oneMatch[1]!);
    if (reviewId === undefined || !isReviewId(reviewId)) {
      jsonResponse(res, 400, { error: "Not a change review id" });
      return true;
    }
    if (!allowed(req, res, `GET ${path}`)) return true;
    void (async () => {
      try {
        const preview = await previewUndo(projectRoot, reviewId);
        if (!preview) {
          jsonResponse(res, 404, { error: `No change review named ${reviewId} in this project` });
          return;
        }
        jsonResponse(res, 200, { review: portablePreview(preview) });
      } catch (error) {
        logger.error("Change-review preview failed", { reviewId, error: String(error) });
        jsonResponse(res, 500, { error: "Failed to preview the change review" });
      }
    })();
    return true;
  }

  // -- POST /api/workspace/change-review/:id/decisions -----------------------
  const decisionsMatch = /^\/api\/workspace\/change-review\/([^/]+)\/decisions$/.exec(path);
  if (decisionsMatch) {
    if (method !== "POST") {
      jsonResponse(res, 405, { error: "Method Not Allowed" });
      return true;
    }
    // Round 12 #12: the same malformed-escape throw as the GET above.
    const reviewId = decodeReviewId(decisionsMatch[1]!);
    if (reviewId === undefined) {
      jsonResponse(res, 400, { error: "Not a change review id" });
      return true;
    }
    if (!allowed(req, res, `POST ${path}`)) return true;
    void (async () => {
      try {
        const body = await readJsonBody<DecisionsRequest>(req, res);
        if (body === null) return; // readJsonBody already answered
        const record = loadReview(projectRoot, reviewId, res);
        if (!record) return;
        const parsed = parseDecisions(body);
        if ("error" in parsed) {
          jsonResponse(res, 400, { error: parsed.error });
          return;
        }
        // ROUND 12 #15: a retry of a decision this review already answered gets
        // that answer back, rather than an empty `applied` the portal must read
        // as a refusal.
        const replay = replayedOutcome(record, parsed.decisions, body.onBlocked);
        if (replay !== undefined) {
          jsonResponse(res, 200, replay);
          return;
        }
        await applyDecisions(record, parsed.decisions, body.onBlocked, res);
      } catch (error) {
        logger.error("Change-review decisions failed", { reviewId, error: String(error) });
        jsonResponse(res, 500, { error: "Failed to apply the change-review decisions" });
      }
    })();
    return true;
  }

  jsonResponse(res, 404, { error: "Change-review endpoint not found" });
  return true;
}

/**
 * Apply one coherent set of decisions, or refuse without touching anything.
 *
 * The rules, and why each exists:
 *  - a decision for a path the review does not contain is a portal/back-end
 *    disagreement, not something to guess about;
 *  - a mixed keep/undo set, or an undo that leaves out a ready entry, cannot be
 *    performed: applyUndo puts the whole review back. Reverting the entries the
 *    user did not ask about would be exactly the silent damage the review
 *    exists to prevent, so it is refused with the paths named;
 *  - only `applied` — what applyUndo says it restored or deleted — is reported
 *    as done.
 */
async function applyDecisions(
  record: ChangeReviewRecord,
  decisions: DecisionInput[],
  onBlocked: "refuse" | "skip" | undefined,
  res: ServerResponse,
): Promise<void> {
  const preview = await previewRecord(record);
  const knownPaths = new Set(preview.entries.map((e) => normalizeReviewPath(e.path)));
  const unknown = decisions.filter((d) => !knownPaths.has(d.path)).map((d) => d.path);
  if (unknown.length > 0) {
    jsonResponse(res, 409, {
      error: "Decisions name paths that are not in this review",
      reviewId: record.reviewId,
      paths: unknown,
      review: portablePreview(preview),
    });
    return;
  }

  const undoPaths = new Set(decisions.filter((d) => d.decision === "undo").map((d) => d.path));
  const keepPaths = decisions.filter((d) => d.decision === "keep").map((d) => d.path);

  if (undoPaths.size === 0) {
    // ROUND 12 #16. Keeping is review-wide too: keepChanges() resolves the
    // RECORD, so keeping one path of two used to close both and drop the
    // undecided one out of the newest-unresolved lookup — the user was never
    // asked about it again. The undo side already demands complete coverage;
    // this is the same demand, for the same reason.
    const uncoveredKeep = preview.entries
      .filter((e) => e.state !== "already-undone")
      .map((e) => normalizeReviewPath(e.path))
      .filter((p) => !keepPaths.includes(p));
    if (uncoveredKeep.length > 0) {
      jsonResponse(res, 409, {
        error: "A change review is decided as a whole",
        reason:
          `keeping this change resolves the whole review, and ${uncoveredKeep.length} path(s) from the same run have ` +
          `not been decided (${uncoveredKeep.slice(0, 20).join(", ")}). Decide those too.`,
        reviewId: record.reviewId,
        paths: uncoveredKeep,
        review: portablePreview(preview),
      });
      return;
    }
    // Keeping changes no file: the run's bytes are already on disk, and the
    // record simply stops offering an undo by default.
    const kept = await keepChangesExclusive(record.projectRoot, record.reviewId);
    if (!kept) {
      jsonResponse(res, 404, { error: `No change review named ${record.reviewId} in this project` });
      return;
    }
    const response: DecisionsResponse = {
      reviewId: record.reviewId,
      outcome: "kept",
      applied: keepPaths,
      kept: keepPaths,
      failed: [],
      leftOver: [],
      historyMoved: false,
      review: portablePreview(await previewRecord(kept)),
    };
    rememberOutcome(record, decisions, onBlocked, response);
    jsonResponse(res, 200, response);
    return;
  }

  if (keepPaths.length > 0) {
    jsonResponse(res, 409, {
      error: "A change review is undone as a whole",
      reason:
        `this review cannot keep ${keepPaths.length} path(s) and undo ${undoPaths.size}: the undo restores the run's ` +
        `whole change set, the previous copies and the git history together. Decide the same way for every path.`,
      reviewId: record.reviewId,
      paths: keepPaths,
      review: portablePreview(preview),
    });
    return;
  }

  // Every entry an undo WOULD touch has to be one the user asked to undo.
  const wouldTouch = preview.entries
    .filter((e) => (onBlocked === "skip" ? e.state === "ready" : e.state !== "already-undone"))
    .map((e) => normalizeReviewPath(e.path));
  const uncovered = wouldTouch.filter((p) => !undoPaths.has(p));
  if (uncovered.length > 0) {
    jsonResponse(res, 409, {
      error: "A change review is undone as a whole",
      reason:
        `undoing the paths you rejected would also put back ${uncovered.length} other path(s) from the same run ` +
        `(${uncovered.slice(0, 20).join(", ")}). Reject those too, or keep the change.`,
      reviewId: record.reviewId,
      paths: uncovered,
      review: portablePreview(preview),
    });
    return;
  }

  const result = await applyUndo(record.projectRoot, record.reviewId, onBlocked ? { onBlocked } : {});
  const after = await previewUndo(record.projectRoot, record.reviewId);
  if (result.status === "refused") {
    // Nothing was touched (applyUndo rolls back before it reports a refusal),
    // so the portal must keep showing the change as published.
    jsonResponse(res, 409, {
      error: "The undo was refused",
      reason: result.reason ?? "the project is not in the state this run left it in",
      reviewId: result.reviewId,
      applied: [],
      kept: result.kept.map(normalizeReviewPath),
      failed: result.failed.map(normalizeReviewPath),
      review: portablePreview(after ?? preview),
    });
    return;
  }
  const response: DecisionsResponse = {
    reviewId: result.reviewId,
    outcome: result.status,
    applied: [...result.restored, ...result.deleted].map(normalizeReviewPath),
    kept: result.kept.map(normalizeReviewPath),
    failed: result.failed.map(normalizeReviewPath),
    leftOver: result.leftOver.map(normalizeReviewPath),
    historyMoved: result.historyMoved,
    review: portablePreview(after ?? preview),
  };
  rememberOutcome(record, decisions, onBlocked, response);
  jsonResponse(res, 200, response);
}
