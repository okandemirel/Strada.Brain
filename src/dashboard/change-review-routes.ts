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
 * WHY DECISIONS ARE APPLIED AS A WHOLE. `applyUndo` restores the review — all of
 * its ready entries, plus the run's commits — because that is the only state the
 * previous copies and the git compare-and-swap can put back consistently. There
 * is no per-path undo underneath, so this route refuses a set of decisions that
 * would undo SOME of a review's ready entries instead of quietly reverting the
 * rest too, and refuses a mixed keep/undo set for the same reason. A refusal
 * touches nothing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyUndo,
  isReviewId,
  keepChanges,
  listChangeReviews,
  previewRecord,
  previewUndo,
  readChangeReview,
  type ChangeReviewRecord,
  type UndoPreview,
} from "../agents/multi/workspace-change-review.js";
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
    const reviewId = decodeURIComponent(oneMatch[1]!);
    if (!isReviewId(reviewId)) {
      jsonResponse(res, 400, { error: "Not a change review id" });
      return true;
    }
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
    const reviewId = decodeURIComponent(decisionsMatch[1]!);
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
    // Keeping is review-wide too, but it changes no file: the run's bytes are
    // already on disk, and the record simply stops offering an undo by default.
    const kept = keepChanges(record.projectRoot, record.reviewId);
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
  jsonResponse(res, 200, response);
}
