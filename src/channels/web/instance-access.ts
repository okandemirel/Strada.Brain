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
 * ── How a request becomes attributable (round 13 #7, #9) ──────────────────
 * The portal's HTTP fetches used to send the profile identity only over the
 * WebSocket, so every owner-only dashboard mutation from a browser arrived
 * unattributed and the model had to grant it on a single-identity instance to
 * keep a one-person portal working. It does not any more: `web-portal/src/
 * utils/api.ts` attaches the verified pair (`x-strada-profile-id` /
 * `-token`) to every same-origin `/api/` request, so a browser request names
 * its identity on both transports.
 *
 * That closes the hole underneath the old grant. `shared` counts identities, and
 * an instance with exactly ONE registered owner is not shared — so "unattributed
 * is fine while not shared" handed owner powers to any caller that simply
 * declined to identify itself (a second socket that never sent `session_init`; a
 * POST straight at the dashboard port). The grant therefore survives only where
 * NO owner has ever been recorded: an instance that has never issued a web
 * identity, which is the CLI/dashboard-only deployment with nobody to be
 * separated from. Once an owner exists, an owner-only power needs the pair that
 * proves ownership.
 *
 * This module is pure: it answers "may identity X do Y here", and produces a
 * reason that always names the identity that was refused. Callers enforce.
 */
import type { TaskCommand } from "../../tasks/types.js";


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
    // ROUND 13 #9: an owner-only power needs VERIFIED ownership once an owner
    // exists.
    //
    // This used to hinge on `shared` alone, and `shared` counts identities. An
    // instance with exactly one registered owner is not shared, so an
    // unidentified caller — a second browser socket that never sent
    // `session_init`, a curl against the dashboard port — was handed
    // `allow:sole-identity` and with it the daemon, the provider switch and the
    // `.env`. The count was right and the conclusion was wrong: the reason
    // sole-identity is safe is that there is nobody to be separated FROM, and
    // once an owner is recorded there is — the owner. So the grant survives only
    // where no owner has ever been recorded (an instance that has issued no web
    // identity at all: the CLI/dashboard-only deployment), and everywhere else
    // the caller must present the pair that proves it is the owner. The portal
    // attaches that pair to its own API requests (round 13 #7), so the ordinary
    // one-person browser keeps working.
    if (!req.instance.shared && req.instance.ownerProfileId === undefined) {
      return {
        allowed: true,
        code: "allow:sole-identity",
        surface,
        reason: `${who} may ${policy.verb}${what}: this instance has recorded no owner and no other identity, so there is no identity to separate it from`,
      };
    }
    return {
      allowed: false,
      code: "deny:unidentified",
      surface,
      reason: req.instance.shared
        ? `${who} may not ${policy.verb}${what}: this instance is shared by more than one identity and the request named none, so it cannot be attributed to ${ownerName}`
        : `${who} may not ${policy.verb}${what}: this instance has an owner and the request named no identity, so it cannot be attributed to ${ownerName}`,
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
 * Owner-only routes that a prefix cannot express, matched as exact patterns
 * (round 13 #10).
 *
 * Installing a skill, or enabling one, changes what this instance can do for
 * everyone on it — the same kind of write as a settings write. `/api/skills/`
 * as a prefix would have swept the read routes (`/api/skills/registry`) in with
 * them, and a classification that is wrong for reads is a classification waiting
 * to be consulted by a reader.
 */
export const OWNER_ONLY_PROXY_ROUTES: readonly {
  readonly pattern: RegExp;
  readonly surface: InstanceSurface;
}[] = [
  { pattern: /^\/api\/skills\/install$/, surface: "setup:write" },
  { pattern: /^\/api\/skills\/[^/]+\/(enable|disable)$/, surface: "setup:write" },
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
  // ROUND 13 #10: the same powers by their other names. These reach the daemon
  // itself — its update, its MCP bridge, its pending security approvals — and
  // are mutations on the dashboard port whether or not the portal proxies them.
  "/api/daemon/approvals/",
  "/api/update",
  "/api/mcp/reconnect",
];

// ── The same powers, reached by typing (round 13 #11) ─────────────────────────
//
// THE DEFECT. Every owner-only power above also has a chat command: `/daemon
// stop`, `/autonomous on`, `/model pin openai`, `/routing preset performance`,
// `/token 1_000_000`, `/persona switch …`, `/vault init …`, `/run <shell>`. The
// dedicated WebSocket control frames (`provider_switch`, `autonomous_toggle`,
// `monitor:pause`) were gated; a plain `{type:"message",text:"/daemon stop"}`
// was not, because it is "just a message" until the command handler — which is
// channel-agnostic and knows nothing about web identities — dispatches it. Same
// power, shorter route.
//
// This table is the model's answer for that route. It is keyed on `TaskCommand`
// (src/tasks/types.ts), so a new command cannot be added to the product without
// a decision being made here: the compiler demands the key.
//
// Reads stay open. A guest may ask what the provider is, what the budget is or
// whether the daemon is running; the table classifies only the ARGUMENTS that
// turn the read into a write, which is why it takes `args` and not just the
// command.


/** How a command's privilege depends on its arguments. */
type CommandPrivilege =
  | { readonly kind: "never" }
  | { readonly kind: "always"; readonly surface: InstanceSurface }
  /** Privileged unless the first argument is one of these read subcommands. */
  | { readonly kind: "unless-read"; readonly surface: InstanceSurface; readonly reads: readonly string[] }
  /** Privileged only when the first argument is one of these write subcommands. */
  | { readonly kind: "when-write"; readonly surface: InstanceSurface; readonly writes: readonly string[] }
  /** Acts on ONE task: own-identity, and privileged only when a task is named. */
  | { readonly kind: "names-task" };

const COMMAND_PRIVILEGE: Readonly<Record<TaskCommand, CommandPrivilege>> = {
  // Reads of this instance and of the caller's own traffic.
  status: { kind: "never" },
  tasks: { kind: "never" },
  detail: { kind: "never" },
  help: { kind: "never" },
  goal: { kind: "never" },
  agent: { kind: "never" },
  measure: { kind: "never" },
  guardian: { kind: "never" },
  // The caller's own task, by name.
  cancel: { kind: "names-task" },
  pause: { kind: "names-task" },
  resume: { kind: "names-task" },
  // The caller's own run, resumed from its own checkpoint (no task argument).
  retry: { kind: "never" },
  continue: { kind: "never" },
  // Controlling the one shared daemon.
  daemon: { kind: "when-write", surface: "instance:control", writes: ["start", "stop", "restart"] },
  autonomous: { kind: "when-write", surface: "instance:control", writes: ["on", "off"] },
  model: { kind: "unless-read", surface: "instance:control", reads: ["list", "listele", "info", "bilgi"] },
  campaign: {
    kind: "when-write",
    surface: "instance:control",
    writes: ["revive", "resume", "devam", "continue"],
  },
  // Arbitrary shell in the shared project, as the daemon.
  run: { kind: "always", surface: "instance:control" },
  // Writing this instance's configuration.
  routing: { kind: "when-write", surface: "setup:write", writes: ["preset"] },
  token: { kind: "unless-read", surface: "setup:write", reads: [] },
  persona: { kind: "unless-read", surface: "setup:write", reads: ["list", "listele"] },
  vault: { kind: "when-write", surface: "setup:write", writes: ["init", "sync"] },
};

/**
 * The owner-only surface a chat command exercises, or undefined when it needs no
 * owner-only power. `"task"` means the command acts on the ONE task it names, so
 * the caller's enforcement is task↔identity ownership rather than an owner check.
 */
export function commandPrivilege(
  command: TaskCommand,
  args: readonly string[] = [],
): InstanceSurface | "task" | undefined {
  const rule = COMMAND_PRIVILEGE[command];
  if (rule === undefined) return undefined;
  const sub = (args[0] ?? "").trim().toLowerCase();
  switch (rule.kind) {
    case "never":
      return undefined;
    case "always":
      return rule.surface;
    case "unless-read":
      // No argument at all is the "show me" form of every one of these.
      return sub && !rule.reads.includes(sub) ? rule.surface : undefined;
    case "when-write":
      return rule.writes.includes(sub) ? rule.surface : undefined;
    case "names-task":
      return sub ? "task" : undefined;
  }
}

/** Which owner-only surface a proxy path belongs to, or undefined when it is neither. */
export function ownerOnlyProxySurface(pathOnly: string): InstanceSurface | undefined {
  if (matchesAny(pathOnly, SETUP_WRITE_PROXY_PATHS)) return "setup:write";
  if (matchesAny(pathOnly, INSTANCE_CONTROL_PROXY_PATHS)) return "instance:control";
  return OWNER_ONLY_PROXY_ROUTES.find((route) => route.pattern.test(pathOnly))?.surface;
}

function matchesAny(pathOnly: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("/")
      ? pathOnly.startsWith(pattern)
      : pathOnly === pattern || pathOnly.startsWith(`${pattern}/`),
  );
}
