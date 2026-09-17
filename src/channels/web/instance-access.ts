/**
 * The shared-instance management model (plan 6.14).
 *
 * ONE Strada daemon serves more than one person: the web portal hands every
 * browser its own profile identity (`resolveWebIdentity`) and every identity
 * reaches the same channel instance, the same workspace bus, the same
 * dashboard proxy and the same `.env`. Until this module the instance had no
 * STATED model of what one identity may see and do — only a handful of
 * scattered per-surface checks (monitor origin filtering, task↔chat ownership,
 * confirmation ownership) and, everywhere else, an implicit "whoever is
 * connected may do it".
 *
 * The model, in one sentence: **an identity sees and controls its own traffic;
 * only the instance owner configures or controls the instance itself; and an
 * unattributed request is granted only while this instance has a single
 * identity (nobody to be separated from).**
 *
 * ── Roles ──────────────────────────────────────────────────────────────────
 *   owner        the instance owner: the FIRST identity this instance ever
 *                issued — the person who ran setup in the browser, recorded by
 *                `WebIdentityStore` so it survives a restart.
 *   guest        any later identity on the same instance.
 *   unidentified a caller that presented no identity this channel issued (an
 *                HTTP request with no profile headers and no signed link, a
 *                socket that has not completed `session_init`).
 *
 * ── Powers a guest does NOT have ───────────────────────────────────────────
 *   - writing setup / settings / `.env` / provider and budget configuration;
 *   - controlling the instance (daemon start/stop, autonomous mode, pausing or
 *     resuming the run, provider switch) — every identity shares one daemon;
 *   - controlling, cancelling or inspecting another identity's task;
 *   - reading another identity's boards, chat frames, confirmations or
 *     attachments.
 *
 * The owner is deliberately NOT given a surveillance power: `own-identity`
 * surfaces are scoped to self for the owner too, so "shared instance" never
 * means "the operator reads everyone's chat". Owner powers are the ones that
 * change the instance, not the ones that read other people.
 *
 * ── What is NOT enforced here, and why ────────────────────────────────────
 * The portal's HTTP fetches (`web-portal/src/...`) send the profile identity
 * only over the WebSocket, never as `x-strada-profile-id` / `-token` headers.
 * An owner-only dashboard mutation from a browser therefore arrives
 * unattributed, which is exactly why "unattributed is granted only on a
 * single-identity instance" is part of the model rather than a plain refusal:
 * a one-person instance keeps working untouched, and a genuinely shared one
 * fails closed. Until the portal sends those headers, the OWNER of a shared
 * instance must present them too (its settings page will otherwise be refused
 * with `deny:unidentified`). That change lives in web-portal and is reported,
 * not made here.
 *
 * This module is pure: it answers "may identity X do Y here", and produces a
 * reason that always names the identity that was refused. Callers enforce.
 */

/** The surfaces the portal exposes, as the model sees them. */
export type InstanceSurface =
  | "monitor:frames"
  | "chat:frames"
  | "confirmation:answer"
  | "attachment:read"
  | "task:control"
  | "instance:control"
  | "setup:write";

export type InstanceRole = "owner" | "guest" | "unidentified";

/**
 * How a surface is scoped:
 *   own-identity — every identity may act on its OWN traffic and nothing else;
 *   owner-only   — only the instance owner may act at all.
 */
export type SurfaceScope = "own-identity" | "owner-only";

export interface SurfacePolicy {
  readonly scope: SurfaceScope;
  /**
   * What "belongs to no identity here" means on this surface.
   *
   * true  — it is EVERYONE's: a monitor frame carrying no conversation scope
   *         (canvas, budget, supervisor, another channel's activity) is the
   *         portal's window onto the instance and is broadcast, as before.
   * false — it is NOBODY's, and nobody can be shown to own it. On a shared
   *         instance that is a refusal, not a grant: an attachment row with no
   *         owner recorded (one written before the column existed) must not
   *         become readable by whoever asks (plan 6.14).
   */
  readonly unattributedIsPublic: boolean;
  /** Reads into a refusal: "<who> may not <verb>". */
  readonly verb: string;
  /** What the owner may do on this surface (the model, as a table row). */
  readonly owner: string;
  /** What a guest may do on this surface. */
  readonly guest: string;
}

/**
 * THE MODEL. Every portal surface, its scope, and what each role may do.
 * A surface missing from this table cannot be asked about — `decideInstanceAccess`
 * is typed on the keys, so adding a surface to the portal forces a policy for it.
 */
export const SURFACE_POLICY: Readonly<Record<InstanceSurface, SurfacePolicy>> = {
  "monitor:frames": {
    scope: "own-identity",
    unattributedIsPublic: true,
    verb: "see these monitor frames",
    owner: "own boards + unattributed/other-channel frames",
    guest: "own boards + unattributed/other-channel frames",
  },
  "chat:frames": {
    scope: "own-identity",
    unattributedIsPublic: false,
    verb: "read this chat",
    owner: "own chat only",
    guest: "own chat only",
  },
  "confirmation:answer": {
    scope: "own-identity",
    unattributedIsPublic: false,
    verb: "answer this confirmation",
    owner: "own prompts/gates only",
    guest: "own prompts/gates only",
  },
  "attachment:read": {
    scope: "own-identity",
    unattributedIsPublic: false,
    verb: "download this attachment",
    owner: "own attachments only",
    guest: "own attachments only",
  },
  "task:control": {
    scope: "own-identity",
    unattributedIsPublic: false,
    verb: "control this task",
    owner: "own tasks only (cancel/retry/resume/move/gate)",
    guest: "own tasks only (cancel/retry/resume/move/gate)",
  },
  "instance:control": {
    scope: "owner-only",
    unattributedIsPublic: false,
    verb: "control this instance",
    owner: "daemon start/stop, autonomous mode, provider switch, pause/resume the run",
    guest: "nothing",
  },
  "setup:write": {
    scope: "owner-only",
    unattributedIsPublic: false,
    verb: "change this instance's setup",
    owner: "setup, settings, .env, provider/budget/routing config, vault registration",
    guest: "nothing",
  },
};

/** Who is asking. `profileId` absent ⇒ no identity this channel issued. */
export interface InstanceActor {
  readonly profileId?: string;
  readonly chatId?: string;
  readonly role: InstanceRole;
}

/** Who the thing being touched belongs to. Both fields absent ⇒ nobody's. */
export interface InstanceResource {
  readonly profileId?: string;
  readonly chatId?: string;
}

/** What this instance is, as far as the model needs to know. */
export interface InstanceFacts {
  /**
   * True once this instance has issued more than one identity — i.e. it is
   * genuinely shared and an unattributed request can no longer be assumed to
   * be the owner's own browser.
   */
  readonly shared: boolean;
  readonly ownerProfileId?: string;
}

export interface AccessRequest {
  readonly surface: InstanceSurface;
  readonly actor: InstanceActor;
  readonly resource?: InstanceResource;
  readonly instance: InstanceFacts;
  /** The concrete thing being touched (a task id, a path, a token) — for the reason. */
  readonly what?: string;
}

export type AccessCode =
  | "allow:owner"
  | "allow:self"
  | "allow:unattributed"
  | "allow:sole-identity"
  | "deny:guest-owner-only"
  | "deny:other-identity"
  | "deny:unidentified"
  | "deny:unattributable";

export interface AccessDecision {
  readonly allowed: boolean;
  readonly code: AccessCode;
  readonly surface: InstanceSurface;
  /**
   * Always names the identity the decision was made about and why. A refusal
   * is never silent and never falls through to "allowed": every branch of
   * `decideInstanceAccess` returns one of these.
   */
  readonly reason: string;
}

/** The role of `profileId` on an instance whose owner is `ownerProfileId`. */
export function instanceRoleOf(
  profileId: string | undefined,
  facts: InstanceFacts,
  isIssuedIdentity: (candidate: string) => boolean,
): InstanceRole {
  if (!profileId) return "unidentified";
  if (facts.ownerProfileId !== undefined && profileId === facts.ownerProfileId) return "owner";
  return isIssuedIdentity(profileId) ? "guest" : "unidentified";
}

function nameActor(actor: InstanceActor): string {
  if (actor.profileId) return `${actor.role} identity ${actor.profileId}`;
  if (actor.chatId) return `unidentified caller (chat ${actor.chatId})`;
  return "unidentified caller";
}

function nameResource(resource: InstanceResource | undefined): string {
  if (resource?.profileId) return `identity ${resource.profileId}`;
  if (resource?.chatId) return `chat ${resource.chatId}`;
  return "another identity";
}

/**
 * May this actor touch this surface? The single decision point for the whole
 * model; every portal enforcement site calls it and reports its `reason`.
 */
export function decideInstanceAccess(req: AccessRequest): AccessDecision {
  const policy = SURFACE_POLICY[req.surface];
  const who = nameActor(req.actor);
  const what = req.what ? ` "${req.what}"` : "";
  const surface = req.surface;
  const ownerName = req.instance.ownerProfileId
    ? `the instance owner ${req.instance.ownerProfileId}`
    : "the instance owner";

  if (policy.scope === "owner-only") {
    if (req.actor.role === "owner") {
      return { allowed: true, code: "allow:owner", surface, reason: `${who} owns this instance and may ${policy.verb}${what}` };
    }
    if (req.actor.role === "guest") {
      return {
        allowed: false,
        code: "deny:guest-owner-only",
        surface,
        reason: `${who} may not ${policy.verb}${what} on a shared instance — only ${ownerName} may`,
      };
    }
    if (!req.instance.shared) {
      return {
        allowed: true,
        code: "allow:sole-identity",
        surface,
        reason: `${who} may ${policy.verb}${what}: this instance has a single identity, so there is no other identity to separate it from`,
      };
    }
    return {
      allowed: false,
      code: "deny:unidentified",
      surface,
      reason: `${who} may not ${policy.verb}${what}: this instance is shared by more than one identity and the request named none, so it cannot be attributed to ${ownerName}`,
    };
  }

  // own-identity: act on your own traffic, and nothing else.
  const resourceProfile = req.resource?.profileId;
  const resourceChat = req.resource?.chatId;
  if (resourceProfile === undefined && resourceChat === undefined) {
    if (policy.unattributedIsPublic) {
      return {
        allowed: true,
        code: "allow:unattributed",
        surface,
        reason: `${who} may ${policy.verb}${what}: it belongs to no identity on this instance and this surface is shared by all of them`,
      };
    }
    // Nobody can be shown to own it. On a one-person instance that is the one
    // person's; on a shared one it is a refusal, because "unknown owner" must
    // never widen into "anyone may" (plan 6.14).
    if (!req.instance.shared) {
      return {
        allowed: true,
        code: "allow:sole-identity",
        surface,
        reason: `${who} may ${policy.verb}${what}: no identity is recorded for it and this instance has a single identity`,
      };
    }
    return {
      allowed: false,
      code: "deny:unattributable",
      surface,
      reason: `${who} may not ${policy.verb}${what}: no identity is recorded for it on a shared instance, so no caller can be shown to own it`,
    };
  }
  if (req.actor.profileId !== undefined && resourceProfile !== undefined && resourceProfile === req.actor.profileId) {
    return { allowed: true, code: "allow:self", surface, reason: `${who} may ${policy.verb}${what}: its own` };
  }
  if (req.actor.chatId !== undefined && resourceChat !== undefined && resourceChat === req.actor.chatId) {
    return { allowed: true, code: "allow:self", surface, reason: `${who} may ${policy.verb}${what}: its own` };
  }
  if (req.actor.profileId === undefined && !req.instance.shared) {
    return {
      allowed: true,
      code: "allow:sole-identity",
      surface,
      reason: `${who} may ${policy.verb}${what}: this instance has a single identity, so there is no other identity to separate it from`,
    };
  }
  return {
    allowed: false,
    code: "deny:other-identity",
    surface,
    reason: `${who} may not ${policy.verb}${what}: it belongs to ${nameResource(req.resource)}`,
  };
}

/** The model as a table — surface × scope × owner × guest. Used by tests and docs. */
export function describeAccessModel(): ReadonlyArray<{
  readonly surface: InstanceSurface;
  readonly scope: SurfaceScope;
  readonly owner: string;
  readonly guest: string;
}> {
  return (Object.keys(SURFACE_POLICY) as InstanceSurface[]).map((surface) => ({
    surface,
    scope: SURFACE_POLICY[surface].scope,
    owner: SURFACE_POLICY[surface].owner,
    guest: SURFACE_POLICY[surface].guest,
  }));
}

/**
 * Dashboard proxy paths that write this instance's setup — settings, `.env`,
 * provider/budget/routing configuration, vault registration. Owner-only.
 * Matched as exact path or prefix (a trailing "/" means prefix).
 */
export const SETUP_WRITE_PROXY_PATHS: readonly string[] = [
  "/api/settings/",
  "/api/config",
  "/api/providers/switch",
  "/api/routing/preset",
  "/api/budget/config",
  "/api/models/refresh",
  "/api/personality/switch",
  "/api/personality/profiles",
  "/api/vaults",
];

/**
 * Dashboard proxy paths that control the one shared daemon rather than one
 * identity's own traffic. Owner-only.
 */
export const INSTANCE_CONTROL_PROXY_PATHS: readonly string[] = [
  "/api/daemon/start",
  "/api/daemon/stop",
  "/api/user/autonomous",
  "/api/deployment/check",
];

/** Which owner-only surface a proxy path belongs to, or undefined when it is neither. */
export function ownerOnlyProxySurface(pathOnly: string): InstanceSurface | undefined {
  if (matchesAny(pathOnly, SETUP_WRITE_PROXY_PATHS)) return "setup:write";
  if (matchesAny(pathOnly, INSTANCE_CONTROL_PROXY_PATHS)) return "instance:control";
  return undefined;
}

function matchesAny(pathOnly: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("/")
      ? pathOnly.startsWith(pattern)
      : pathOnly === pattern || pathOnly.startsWith(`${pattern}/`),
  );
}
