/**
 * Who may teach a rule that applies to everybody.
 *
 * A "remember: …" teaching is stored as an instinct, and a project- or
 * global-scoped instinct is rendered into EVERY user's system prompt on every
 * matching run. The scope used to come from the wording alone ("in this
 * project", "this repo"), so any identity on a shared instance could plant
 * standing guidance in everybody else's runs. Setting such a rule is
 * configuring the instance, so it is decided by the shared-instance model
 * (src/channels/web/instance-access.ts) as its owner-only `setup:write` power:
 * the owner may, and so may the operator of an instance that has issued no
 * identity (CLI-only, nobody to be separated from). Anyone else's teaching is
 * kept as their own.
 */

import type { ScopeType } from "../types.js";
import { decideInstanceAccess, instanceRoleOf, type InstanceFacts } from "../../channels/web/instance-access.js";
import { instanceIdentityState } from "../../channels/web/instance-authorization.js";

/**
 * The scope a teaching is stored under: what its wording asked for when that is
 * the teacher's own scope or the teacher may configure the instance, otherwise
 * the teacher's own. Asked lazily, so a user-scoped teaching never touches the
 * identity store.
 */
export function authorizedTeachingScope(
  requested: ScopeType | undefined,
  mayTeachForEveryone: () => boolean,
): ScopeType {
  const scope = requested ?? "user";
  if (scope === "user") return scope;
  return mayTeachForEveryone() ? scope : "user";
}

/**
 * May `userId` store learning that reaches every identity on this instance?
 *
 * An unreadable identity store is "no": an unknown owner is not a grant.
 */
export function mayTeachForEveryone(userId: string | undefined): boolean {
  const state = instanceIdentityState();
  if (state.kind === "unavailable") return false;
  if (state.kind === "none") {
    return decideInstanceAccess({
      surface: "setup:write",
      actor: { role: "unidentified" },
      instance: { shared: false },
    }).allowed;
  }

  try {
    const store = state.store;
    const owner = store.ownerProfileId();
    const facts: InstanceFacts = {
      shared: store.count() > 1,
      ...(owner !== undefined ? { ownerProfileId: owner } : {}),
    };
    const profileId = userId?.trim() || undefined;
    const role = instanceRoleOf(profileId, facts, (candidate) => store.has(candidate));
    return decideInstanceAccess({
      surface: "setup:write",
      actor: { role, ...(role !== "unidentified" && profileId ? { profileId } : {}) },
      instance: facts,
    }).allowed;
  } catch {
    return false;
  }
}
