/**
 * The shared-instance model, applied to an HTTP request (plan 6.14, round 13).
 *
 * `instance-access.ts` is pure: it answers "may identity X do Y here". This
 * module is the one place that turns a REQUEST into that question — the verified
 * profile pair, the instance's facts, and the decision — for every HTTP surface
 * that is not the portal's own WebSocket:
 *
 *   - the dashboard's mutating APIs, straight on the dashboard port (round 13
 *     #10: the portal proxy refused a guest's `POST /api/daemon/stop` and the
 *     dashboard port next door performed it);
 *   - the change-review decisions (round 12 #10, round 13 #14);
 *   - the durable project history's reads (round 13 #4).
 *
 * WHY ONE MODULE. Those three had — or were about to have — their own copy of
 * "open the identity database, verify the pair, ask the model", and the copies
 * disagreed: one cached a failed open forever and read the absence as "no
 * identities, therefore nothing to protect". The state of the identity store is
 * a three-way answer, and every caller has to distinguish the two negatives:
 *
 *   store        — identities can be read; the model decides;
 *   none         — this instance has never issued a web identity (no database at
 *                  all): there is no owner and nobody to be separated from, so
 *                  the CLI/dashboard-only deployment keeps working;
 *   unavailable  — there IS an identity database (or it cannot be ruled out) and
 *                  it cannot be read. NOT the same as "none": the callers answer
 *                  503 and deny, because an unreadable owner is an unknown owner.
 */

import { statSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { getCachedConfig } from "../../config/config.js";
import { getLoggerSafe } from "../../utils/logger.js";
import {
  decideInstanceAccess,
  instanceRoleOf,
  type AccessDecision,
  type InstanceFacts,
  type InstanceResource,
  type InstanceSurface,
} from "./instance-access.js";
import { WebIdentityStore } from "./web-identity-store.js";

/**
 * The part of the web channel's identity store these surfaces need. Structural,
 * so the daemon can hand over its live `WebIdentityStore` and a test can hand
 * over a fake without depending on the channel's class.
 */
export interface InstanceIdentityStoreView {
  /** True only for a pair THIS instance issued. */
  verify(profileId: string, profileToken: string): boolean;
  /** The instance owner (the first identity ever issued), if one is recorded. */
  ownerProfileId(): string | undefined;
  /** True when this profile id was issued here — a guest rather than a stranger. */
  has(profileId: string): boolean;
  /** How many identities exist; more than one means the instance is genuinely shared. */
  count(): number;
}

export type InstanceIdentityState =
  | { readonly kind: "store"; readonly store: InstanceIdentityStoreView }
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "unavailable"; readonly why: string };

let injectedStore: InstanceIdentityStoreView | null = null;
let openedStore: InstanceIdentityStoreView | undefined;

/**
 * Hand these surfaces the identity store to verify callers against (the daemon's
 * own, or a fake in a test). `null` clears it and the file fallback applies again.
 */
export function setInstanceIdentityStore(store: InstanceIdentityStoreView | null): void {
  injectedStore = store;
  openedStore = undefined;
}

/** The identity database the web channel keeps, where bootstrap puts it. */
function identityDbPath(): string | undefined {
  const config = getCachedConfig();
  if (!config) return undefined;
  const dir = config.memory?.dbPath;
  return dir ? join(dir, "web-identities.db") : undefined;
}

/**
 * Can this process read who the identities on this instance are?
 *
 * ROUND 13 #14: a FAILED open is never cached. The previous version latched
 * `identityStoreUnavailable = true` on the first failure and then returned "no
 * store" — which every caller read as count 0, i.e. "not shared", i.e. allow.
 * One transient failure (the file locked by a backup, a permission change, a
 * corrupt page) therefore opened anonymous access for the life of the process.
 * The attempt is cheap, so it is simply retried, and a failure is reported AS a
 * failure.
 */
export function instanceIdentityState(): InstanceIdentityState {
  if (injectedStore) return { kind: "store", store: injectedStore };
  if (openedStore) {
    // A store that was readable can stop being readable (file deleted, database
    // corrupted). Probe it, and drop it if the probe fails.
    try {
      openedStore.count();
      return { kind: "store", store: openedStore };
    } catch (error) {
      const why = `the identity database stopped being readable: ${String(error)}`;
      getLoggerSafe().warn("[instance-access] identity store unreadable", { error: String(error) });
      openedStore = undefined;
      return { kind: "unavailable", why };
    }
  }

  let dbPath: string | undefined;
  try {
    dbPath = identityDbPath();
  } catch (error) {
    return { kind: "unavailable", why: `the configuration could not be read: ${String(error)}` };
  }
  if (!dbPath) {
    // No configuration is loaded in this process, so no portal identity database
    // can be located. A deployment with no portal has no owner, and this is the
    // behaviour every one of these surfaces already had.
    return { kind: "none", why: "no configuration is loaded, so this process serves no portal identities" };
  }
  // ROUND 14 #6: `existsSync` COLLAPSES every stat failure into false — EACCES
  // included. Remove traversal permission on the identity directory (a hardened
  // deployment, a botched chown, a backup process holding it) and this read
  // answered "there is no identity database", which every caller took as "this
  // instance has issued no identity", which is a grant. The absence of a file and
  // the inability to look are different answers and must stay different.
  //
  // Only an EXISTING database is opened: creating one here would invent an
  // identity table for a project that has never served a portal. ENOENT is
  // re-checked on the next request, so the first request of a process does not
  // fix the answer for its lifetime.
  try {
    statSync(dbPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "none", why: `this instance has issued no web identity (${dbPath} does not exist)` };
    }
    const why = `the identity database at ${dbPath} could not be examined (${code ?? String(error)})`;
    getLoggerSafe().warn("[instance-access] identity database not examinable", { dbPath, code: code ?? null });
    return { kind: "unavailable", why };
  }
  try {
    openedStore = new WebIdentityStore(dbPath);
    return { kind: "store", store: openedStore };
  } catch (error) {
    const why = `the identity database at ${dbPath} exists but could not be opened: ${String(error)}`;
    getLoggerSafe().warn("[instance-access] identity store could not be opened", {
      dbPath,
      error: String(error),
    });
    return { kind: "unavailable", why };
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The identity a request PROVES, never one it claims: `profileId` travels to the
 * browser and lives in its localStorage, so a request naming the owner is not
 * the owner. Undefined when no pair was presented or the pair does not verify.
 */
function verifiedProfileId(
  headers: IncomingHttpHeaders | undefined,
  store: InstanceIdentityStoreView,
): string | undefined {
  const id = singleHeader(headers?.["x-strada-profile-id"])?.trim();
  const token = singleHeader(headers?.["x-strada-profile-token"])?.trim();
  if (!id || !token) return undefined;
  return store.verify(id, token) ? id : undefined;
}

export type InstanceAuthorization =
  | { readonly kind: "decision"; readonly decision: AccessDecision }
  /** The identity state could not be read: the caller must answer 503 and deny. */
  | { readonly kind: "unavailable"; readonly why: string };

/**
 * May the caller behind `headers` act on `surface`? The single entry point for
 * every HTTP surface, so a new one cannot invent its own semantics.
 *
 * `resource` names who the thing being touched belongs to, for the own-identity
 * surfaces (a canvas, an attachment): omit it for the owner-only ones, where the
 * instance itself is the resource.
 */
export function authorizeInstanceRequest(
  headers: IncomingHttpHeaders | undefined,
  surface: InstanceSurface,
  what: string,
  resource?: InstanceResource,
): InstanceAuthorization {
  const state = instanceIdentityState();
  if (state.kind === "unavailable") return { kind: "unavailable", why: state.why };

  if (state.kind === "none") {
    // No identity was ever issued here: no owner, and nothing shared.
    return {
      kind: "decision",
      decision: decideInstanceAccess({
        surface,
        actor: { role: "unidentified" },
        instance: { shared: false },
        what,
        ...(resource ? { resource } : {}),
      }),
    };
  }

  const store = state.store;
  let facts: InstanceFacts;
  let verified: string | undefined;
  try {
    const owner = store.ownerProfileId();
    facts = { shared: store.count() > 1, ...(owner !== undefined ? { ownerProfileId: owner } : {}) };
    verified = verifiedProfileId(headers, store);
  } catch (error) {
    // Mid-read failure: the same unknown owner as a failed open.
    const why = `the identity database could not be read: ${String(error)}`;
    getLoggerSafe().warn("[instance-access] identity store read failed", { error: String(error) });
    openedStore = undefined;
    return { kind: "unavailable", why };
  }

  const role = instanceRoleOf(verified, facts, (candidate) => {
    try {
      return store.has(candidate);
    } catch {
      // A lookup failure must not promote a stranger to guest.
      return false;
    }
  });
  const decision = decideInstanceAccess({
    surface,
    actor: { ...(verified ? { profileId: verified } : {}), role },
    instance: facts,
    what,
    ...(resource ? { resource } : {}),
  });
  if (!decision.allowed) {
    getLoggerSafe().warn("[instance-access] request refused", {
      surface,
      code: decision.code,
      what,
      reason: decision.reason,
    });
  }
  return { kind: "decision", decision };
}

export type ViewerResolution =
  /** `viewer` absent ⇒ the caller proved no identity. */
  | { readonly kind: "viewer"; readonly viewer?: string }
  | { readonly kind: "unavailable"; readonly why: string };

/**
 * The identity a read should be scoped to (round 13 #4).
 *
 * Derived from the VERIFIED pair and nothing else. The project-history routes
 * used to take it from `?viewer=`, which made a public profile id into the SQL
 * principal: anyone could read the owner's private history by naming it.
 */
export function verifiedRequestIdentity(headers: IncomingHttpHeaders | undefined): ViewerResolution {
  const state = instanceIdentityState();
  if (state.kind === "unavailable") return { kind: "unavailable", why: state.why };
  if (state.kind === "none") return { kind: "viewer" };
  try {
    const viewer = verifiedProfileId(headers, state.store);
    return { kind: "viewer", ...(viewer ? { viewer } : {}) };
  } catch (error) {
    openedStore = undefined;
    return { kind: "unavailable", why: `the identity database could not be read: ${String(error)}` };
  }
}

/**
 * The identity a read should be scoped to — the same resolution, under the name
 * the project-history routes use for it.
 */
export const verifiedRequestViewer = verifiedRequestIdentity;
