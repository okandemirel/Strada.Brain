/**
 * Which monitor boards and goal trees an HTTP reader may see (CHN-4).
 *
 * The WebSocket path has withheld another identity's monitor frames since
 * 13F5 / 4.7 (`WebChannel.monitorFrameVisibleTo`), but the REST reads of the
 * same data — `/api/monitor/dag|tasks|task/:id|export` and `/api/goals` —
 * consulted nothing and handed any caller the most recent tree, whoever owned
 * it. This applies the same rule, through the same model surface
 * (`monitor:frames`), to a request:
 *
 *   - a board with no origin, or whose origin is not a web identity this
 *     instance issued (a Telegram chat, a CLI or daemon scope), is nobody's
 *     private traffic and stays visible;
 *   - a board whose origin IS an issued identity is that identity's own, and
 *     only a request proving that identity sees it (the owner included: owner
 *     powers change the instance, they do not read other people).
 *
 * A board's origin is the conversation scope it ran under: a goal tree's
 * `sessionId`, a task's `userId` (falling back to its chat id). For the web
 * channel that scope is the profile id, which is what the monitor bridge
 * stamps on the live frames.
 */

import type { IncomingHttpHeaders } from "node:http";
import {
  decideInstanceAccess,
  instanceRoleOf,
  type InstanceActor,
  type InstanceFacts,
} from "../channels/web/instance-access.js";
import {
  instanceIdentityState,
  verifiedRequestIdentity,
} from "../channels/web/instance-authorization.js";

export type MonitorReadScope =
  | { readonly kind: "scope"; readonly visible: (origin: string | undefined) => boolean }
  /** The identity state could not be read: answer 503, never guess. */
  | { readonly kind: "unavailable"; readonly why: string };

const EVERYTHING: MonitorReadScope = { kind: "scope", visible: () => true };

/** Resolve, once per request, which board origins this caller may read. */
export function monitorReadScope(headers: IncomingHttpHeaders | undefined): MonitorReadScope {
  const state = instanceIdentityState();
  if (state.kind === "unavailable") return { kind: "unavailable", why: state.why };
  // No web identity was ever issued here: nobody's boards to separate.
  if (state.kind === "none") return EVERYTHING;

  const reader = verifiedRequestIdentity(headers);
  if (reader.kind === "unavailable") return { kind: "unavailable", why: reader.why };

  const store = state.store;
  let facts: InstanceFacts;
  try {
    const owner = store.ownerProfileId();
    facts = { shared: store.count() > 1, ...(owner !== undefined ? { ownerProfileId: owner } : {}) };
  } catch (error) {
    return { kind: "unavailable", why: `the identity database could not be read: ${String(error)}` };
  }

  // A lookup failure reads as "an issued identity", so an origin that cannot
  // be classified is withheld rather than leaked (the channel's rule too).
  const isIssued = (candidate: string): boolean => {
    try {
      return store.has(candidate);
    } catch {
      return true;
    }
  };
  const viewer = reader.viewer;
  const actor: InstanceActor = {
    // Never promote on a lookup failure: the viewer is already verified.
    role: instanceRoleOf(viewer, facts, (candidate) => {
      try {
        return store.has(candidate);
      } catch {
        return false;
      }
    }),
    ...(viewer ? { profileId: viewer } : {}),
  };

  return {
    kind: "scope",
    visible: (origin) => {
      const scope = origin?.trim();
      if (!scope) return true;
      if (viewer !== undefined && scope === viewer) return true;
      const resource = isIssued(scope) ? { profileId: scope } : {};
      return decideInstanceAccess({ surface: "monitor:frames", actor, resource, instance: facts }).allowed;
    },
  };
}

/** The conversation scope a task record ran under (see the module comment). */
export function taskOrigin(task: { readonly userId?: string; readonly chatId: string }): string {
  return task.userId?.trim() || task.chatId;
}
