/**
 * Durable project-history read surface (improvement 6.6).
 *
 *   GET /api/workspace/history            -- the newest N events for the caller
 *   GET /api/workspace/history/:eventId   -- one event, by id
 *
 * WHY THIS PREFIX. `/api/workspace` is already in the portal proxy's
 * ALLOWED_PROXY_PREFIXES and is NOT in MUTABLE_PROXY_PREFIXES (see
 * src/channels/web/channel.ts), so these GETs are forwarded from the browser
 * with no change to the channel and no new mutable surface. The routes are
 * registered before the file-explorer routes, which 404 everything else under
 * /api/workspace.
 *
 * WHO THE CALLER IS. The proxy forwards the query string but not custom request
 * headers, so the reading identity travels as `?viewer=` (aliases: `profileId`,
 * `userId` — the portal knows a profileId, other channels know a userId). The
 * gate itself lives in SQL (DaemonStorage.listProjectHistoryRows) and is applied
 * before the LIMIT. A request with no viewer sees only events recorded as
 * 'shared'; an unattributable event reaches nobody at all.
 *
 * READ-ONLY. Every other method answers 405: history is append-only and is
 * written by the daemon, never by the browser.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PROJECT_HISTORY_KINDS,
  PROJECT_HISTORY_MAX_IDENTITY_LENGTH,
  clampLimit,
  getProjectHistoryStore,
  isProjectHistoryEventId,
  isProjectHistoryKind,
  type ProjectHistoryEventKind,
} from "../history/project-history.js";
import { getLoggerSafe } from "../utils/logger.js";
import type { RouteContext } from "./server-types.js";

export const PROJECT_HISTORY_ROUTE_PREFIX = "/api/workspace/history";

const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
};

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, NO_CACHE_HEADERS);
  res.end(JSON.stringify(body));
}

/** The reading identity, or an error. Empty is legal (shared events only). */
function readViewer(params: URLSearchParams): { viewer?: string } | { error: string } {
  const raw = params.get("viewer") ?? params.get("profileId") ?? params.get("userId");
  if (raw === null) return {};
  const viewer = raw.trim();
  if (!viewer) return {};
  if (viewer.length > PROJECT_HISTORY_MAX_IDENTITY_LENGTH) return { error: "viewer is too long" };
  if (viewer.includes(",")) return { error: "viewer must not contain a comma" };
  return { viewer };
}

/** `?kind=decision&kind=delivery` (or one comma-joined value), validated. */
function readKinds(params: URLSearchParams): { kinds: ProjectHistoryEventKind[] } | { error: string } {
  const raw = params.getAll("kind").flatMap((value) => value.split(","));
  const kinds: ProjectHistoryEventKind[] = [];
  for (const entry of raw) {
    const kind = entry.trim();
    if (!kind) continue;
    if (!isProjectHistoryKind(kind)) {
      return { error: `Unknown history kind ${kind} (expected one of ${PROJECT_HISTORY_KINDS.join(", ")})` };
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { kinds };
}

/**
 * Handle GET /api/workspace/history*. Returns true when it answered, false when
 * the URL belongs to another handler.
 */
export function handleProjectHistoryRoutes(
  url: string,
  method: string,
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const path = url.split("?")[0] ?? url;
  if (path !== PROJECT_HISTORY_ROUTE_PREFIX && !path.startsWith(`${PROJECT_HISTORY_ROUTE_PREFIX}/`)) {
    return false;
  }

  if (method !== "GET") {
    jsonResponse(res, 405, { error: "Method Not Allowed" });
    return true;
  }

  const rest = path.slice(PROJECT_HISTORY_ROUTE_PREFIX.length).replace(/^\//, "");
  const segments = rest.length > 0 ? rest.split("/") : [];
  if (segments.length > 1) {
    jsonResponse(res, 404, { error: "Not Found" });
    return true;
  }

  // AN ID IS CHECKED BEFORE STORAGE IS TOUCHED. A malformed id is a client bug,
  // not a lookup: it never becomes a query.
  let eventId: string | undefined;
  if (segments.length === 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segments[0]!);
    } catch {
      jsonResponse(res, 400, { error: "Not a project history event id" });
      return true;
    }
    if (!isProjectHistoryEventId(decoded)) {
      jsonResponse(res, 400, { error: "Not a project history event id" });
      return true;
    }
    eventId = decoded;
  }

  const params = new URL(url, "http://127.0.0.1").searchParams;
  const viewerResult = readViewer(params);
  if ("error" in viewerResult) {
    jsonResponse(res, 400, { error: viewerResult.error });
    return true;
  }
  const { viewer } = viewerResult;

  // The storage arrives with the daemon; without it there is no history to read
  // and saying so is better than an empty list that looks like "nothing happened".
  if (!ctx.daemonStorage) {
    jsonResponse(res, 503, { error: "Project history is unavailable (daemon storage not initialized)" });
    return true;
  }

  const store = getProjectHistoryStore(ctx.daemonStorage);

  try {
    if (eventId) {
      const event = store.get(eventId, viewer);
      if (!event) {
        // Same answer for "no such event" and "not yours": a 403 would confirm
        // that somebody else's event exists.
        jsonResponse(res, 404, { error: `No project history event ${eventId} for this caller` });
        return true;
      }
      jsonResponse(res, 200, { event });
      return true;
    }

    const kindsResult = readKinds(params);
    if ("error" in kindsResult) {
      jsonResponse(res, 400, { error: kindsResult.error });
      return true;
    }
    const projectParam = (params.get("project") ?? params.get("projectId") ?? "").trim();
    const events = store.list({
      ...(viewer ? { viewer } : {}),
      ...(projectParam ? { projectId: projectParam } : {}),
      ...(kindsResult.kinds.length > 0 ? { kinds: kindsResult.kinds } : {}),
      limit: clampLimit(params.get("limit") ?? undefined),
    });
    jsonResponse(res, 200, {
      viewer: viewer ?? null,
      limit: clampLimit(params.get("limit") ?? undefined),
      count: events.length,
      events,
    });
    return true;
  } catch (error) {
    getLoggerSafe().error("Project history read failed", {
      url: path,
      error: error instanceof Error ? error.message : String(error),
    });
    jsonResponse(res, 500, { error: "Failed to read the project history" });
    return true;
  }
}
