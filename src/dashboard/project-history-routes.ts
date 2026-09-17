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
 * WHO THE CALLER IS (round 13 #4). The reading identity is the VERIFIED profile
 * pair the portal attaches to its API requests and the proxy forwards
 * (`x-strada-profile-id` / `x-strada-profile-token`, checked against the identity
 * store that issued them) — and nothing else.
 *
 * THE DEFECT THAT CLOSES. It used to travel as `?viewer=` (aliases `profileId`,
 * `userId`), and a profile id is a PUBLIC value: it is sent to the browser and
 * kept in localStorage. The query parameter therefore became the SQL principal,
 * so `GET /api/workspace/history?viewer=<the owner's profile>` read the owner's
 * private history from any caller the transport let through — through the portal
 * proxy or straight at the dashboard port, which is why the identity has to be
 * established the same way at both.
 *
 * A viewer parameter is now refused rather than ignored: silently downgrading it
 * to "shared rows only" would answer an impersonation attempt with an empty list
 * that reads like "you have no history". The gate itself still lives in SQL
 * (DaemonStorage.listProjectHistoryRows) and is applied before the LIMIT; a
 * caller that proves no identity sees only events recorded as 'shared', and an
 * unattributable event reaches nobody at all.
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
import { verifiedRequestViewer } from "../channels/web/instance-authorization.js";
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

/**
 * The identity the QUERY STRING claims, if any. It is never the principal — it is
 * only compared against the verified one, so that a caller asking for somebody
 * else's history is told so instead of being handed an empty list.
 */
function claimedViewer(params: URLSearchParams): string | undefined {
  const raw = params.get("viewer") ?? params.get("profileId") ?? params.get("userId");
  const claimed = raw?.trim();
  return claimed ? claimed.slice(0, PROJECT_HISTORY_MAX_IDENTITY_LENGTH) : undefined;
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
  req: IncomingMessage,
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

  // ROUND 13 #4: the principal comes from the verified pair, never the URL.
  const resolved = verifiedRequestViewer(req.headers);
  if (resolved.kind === "unavailable") {
    // The identity state cannot be read, so no read can be scoped: an unreadable
    // identity store must not degrade into "you are nobody, here are the shared
    // rows" either (round 13 #14 — the same defect, the other surface).
    getLoggerSafe().error("Project history read refused: the instance's identities cannot be read", {
      url: path,
      why: resolved.why,
    });
    jsonResponse(res, 503, {
      error: "Identity state unavailable",
      reason: `the reading identity cannot be established right now: ${resolved.why}. Refusing rather than guessing.`,
      code: "unavailable:identity-store",
    });
    return true;
  }
  const viewer = resolved.viewer;
  const claimed = claimedViewer(params);
  if (claimed !== undefined && claimed !== viewer) {
    getLoggerSafe().warn("Project history read refused: the query string named another identity", {
      url: path,
      claimed,
      verified: viewer ?? null,
    });
    jsonResponse(res, 403, {
      error: "Forbidden",
      reason:
        `this read is scoped to the identity your request PROVES, not to the one it names: ` +
        `"${claimed}" is not ${viewer ? `your verified identity` : "an identity this request proved"}. ` +
        `Present x-strada-profile-id / x-strada-profile-token, or drop the viewer parameter.`,
      code: "deny:claimed-viewer",
    });
    return true;
  }

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
