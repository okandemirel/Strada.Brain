/**
 * Turning an HTTP request into the shared-instance model's question (round 13).
 *
 * The headline test is `#14`: an identity database that EXISTS and cannot be
 * opened must never read as "this instance has no identities". That is the shape
 * of the defect — a failure cached as an absence, an absence read as "nothing to
 * protect" — and it authorized anonymous mutations for the life of the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAtOrUnder, kernelEnforcesPermissions, permissionDenied } from "../../tests/helpers/permission-faults.js";
import { openDescriptorsOn } from "../../tests/helpers/open-handles.js";

/** The config the resolver locates the identity database with — never the real one. */
let memoryDbDir: string;
vi.mock("../../config/config.js", () => ({
  getCachedConfig: () => ({ memory: { dbPath: memoryDbDir } }),
}));

/**
 * A directory made untraversable by injection. Root ignores permission bits
 * (Docker CI, root dev containers) and Windows has no POSIX modes, so there
 * `chmod 000` hides nothing; the stat the resolver makes of a path inside the
 * directory raises the EACCES the kernel would.
 */
const untraversable = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const statSync = ((target: Parameters<typeof actual.statSync>[0], options?: Parameters<typeof actual.statSync>[1]) => {
    const dir = untraversable.dir;
    if (dir !== undefined && isAtOrUnder(target, dir) && String(target) !== dir) throw permissionDenied("stat", target);
    return actual.statSync(target, options);
  }) as typeof actual.statSync;
  return { ...actual, statSync };
});

/** Remove traversal permission on `dir` and return the undo. */
function makeUntraversable(dir: string): () => void {
  if (kernelEnforcesPermissions) {
    chmodSync(dir, 0o000);
    return () => chmodSync(dir, 0o700);
  }
  untraversable.dir = dir;
  return () => {
    untraversable.dir = undefined;
  };
}

const { WebIdentityStore } = await import("./web-identity-store.js");
const {
  authorizeInstanceRequest,
  instanceIdentityState,
  setInstanceIdentityStore,
  verifiedRequestViewer,
} = await import("./instance-authorization.js");

const dirs: string[] = [];

beforeEach(() => {
  memoryDbDir = mkdtempSync(join(tmpdir(), "strada-instance-auth-"));
  dirs.push(memoryDbDir);
  setInstanceIdentityStore(null);
});

afterEach(() => {
  setInstanceIdentityStore(null);
  untraversable.dir = undefined;
  for (const dir of dirs.splice(0)) {
    try { chmodSync(dir, 0o700); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

const dbPath = () => join(memoryDbDir, "web-identities.db");

/** An instance that has served a portal: an owner and one guest. */
function seedIdentities(): { owner: { profileId: string; profileToken: string }; guest: { profileId: string; profileToken: string } } {
  const store = new WebIdentityStore(dbPath());
  const owner = store.issue("owner-profile");
  const guest = store.issue("guest-profile");
  store.close();
  return { owner, guest };
}

const headersFor = (identity: { profileId: string; profileToken: string }) => ({
  "x-strada-profile-id": identity.profileId,
  "x-strada-profile-token": identity.profileToken,
});

describe("instance identity state is three-way (round 13 #14)", () => {
  it("reports `none` for an instance that has issued no web identity", () => {
    const state = instanceIdentityState();
    expect(state.kind).toBe("none");
    // …and the model then grants an unattributed owner-only action: there is no
    // owner to be separated from on a CLI/dashboard-only deployment.
    const verdict = authorizeInstanceRequest({}, "instance:control", "POST /api/daemon/stop");
    expect(verdict.kind).toBe("decision");
    if (verdict.kind !== "decision") return;
    expect(verdict.decision.allowed).toBe(true);
    expect(verdict.decision.code).toBe("allow:sole-identity");
  });

  it("reports `store` and lets the model decide once identities exist", () => {
    const { owner, guest } = seedIdentities();
    expect(instanceIdentityState().kind).toBe("store");

    const asOwner = authorizeInstanceRequest(headersFor(owner), "instance:control", "POST /api/daemon/stop");
    expect(asOwner.kind === "decision" && asOwner.decision.allowed).toBe(true);

    const asGuest = authorizeInstanceRequest(headersFor(guest), "instance:control", "POST /api/daemon/stop");
    expect(asGuest.kind === "decision" && asGuest.decision.allowed).toBe(false);
    expect(asGuest.kind === "decision" && asGuest.decision.code).toBe("deny:guest-owner-only");

    const anonymous = authorizeInstanceRequest({}, "instance:control", "POST /api/daemon/stop");
    expect(anonymous.kind === "decision" && anonymous.decision.allowed).toBe(false);

    // A claimed id with a token that does not verify is not that identity.
    const forged = authorizeInstanceRequest(
      { "x-strada-profile-id": owner.profileId, "x-strada-profile-token": "guessed" },
      "instance:control",
      "POST /api/daemon/stop",
    );
    expect(forged.kind === "decision" && forged.decision.allowed).toBe(false);
  });

  // ── THE DEFECT (#14) ────────────────────────────────────────────────────────
  it("reports `unavailable` — not `none` — when the existing database cannot be opened", () => {
    seedIdentities();
    setInstanceIdentityStore(null);
    // The database is there and unreadable: a lock, a permission change, a
    // corrupt page. "Not a database" is the same class of answer.
    writeFileSync(dbPath(), "this is not a sqlite database", "utf8");

    const state = instanceIdentityState();
    expect(state.kind).toBe("unavailable");

    const verdict = authorizeInstanceRequest({}, "instance:control", "POST /api/daemon/stop");
    expect(verdict.kind).toBe("unavailable");
    if (verdict.kind !== "unavailable") return;
    expect(verdict.why).toContain("web-identities.db");
  });

  it("does not cache the failure: the very next request is judged again", () => {
    const { owner } = seedIdentities();
    setInstanceIdentityStore(null);
    writeFileSync(dbPath(), "this is not a sqlite database", "utf8");
    expect(authorizeInstanceRequest({}, "instance:control", "x").kind).toBe("unavailable");
    // Asking twice must not be what fixes or breaks it.
    expect(authorizeInstanceRequest({}, "instance:control", "x").kind).toBe("unavailable");

    // The lock is released / the file restored — and the owner is served again,
    // without a restart.
    unlinkSync(dbPath());
    const restored = new WebIdentityStore(dbPath());
    const restoredOwner = restored.issue(owner.profileId);
    restored.close();

    const verdict = authorizeInstanceRequest(headersFor(restoredOwner), "instance:control", "x");
    expect(verdict.kind).toBe("decision");
    if (verdict.kind !== "decision") return;
    expect(verdict.decision.allowed).toBe(true);
  });

  // ROUND 14 #6. `existsSync` answers false for EVERY stat failure, EACCES
  // included — so removing traversal permission on the directory (a hardened
  // deployment, a botched chown, a backup process) made the resolver report
  // "this instance has issued no web identity" and hand owner powers to anyone.
  // The absence of a file and the inability to look are different answers.
  it("reports `unavailable` when the identity directory cannot be traversed", () => {
    seedIdentities();
    setInstanceIdentityStore(null);
    const restoreTraversal = makeUntraversable(memoryDbDir);
    try {
      // A readable stat would say "the file is there"; an unreadable one must not
      // say "there is no file".
      const state = instanceIdentityState();
      expect(state.kind).toBe("unavailable");
      const verdict = authorizeInstanceRequest({}, "instance:control", "POST /api/daemon/stop");
      expect(verdict.kind).toBe("unavailable");
    } finally {
      restoreTraversal();
    }

    // …and once permission is back, the very next request is judged normally.
    expect(instanceIdentityState().kind).toBe("store");
  });

  // Windows 2026-09-26: the store this module opens from the file was dropped by
  // reference and never closed, so the identity database stayed locked (EBUSY)
  // for the life of the process — no restore or replacement could touch it.
  it("closes the identity database it opened when that store is let go", () => {
    seedIdentities();
    expect(instanceIdentityState().kind).toBe("store");
    expect(openDescriptorsOn(dbPath())).toBeGreaterThan(0);
    setInstanceIdentityStore(null);
    expect(openDescriptorsOn(dbPath())).toBe(0);

    // …and a store that fails its probe is closed when it is dropped, too.
    expect(instanceIdentityState().kind).toBe("store");
    writeFileSync(dbPath(), "this is not a sqlite database", "utf8");
    expect(instanceIdentityState().kind).toBe("unavailable");
    expect(openDescriptorsOn(dbPath())).toBe(0);
    unlinkSync(dbPath());
  });

  it("reports `unavailable` when a store that WAS readable stops being readable", () => {
    const failing = {
      verify: () => { throw new Error("database disk image is malformed"); },
      ownerProfileId: () => { throw new Error("database disk image is malformed"); },
      has: () => { throw new Error("database disk image is malformed"); },
      count: () => { throw new Error("database disk image is malformed"); },
    };
    setInstanceIdentityStore(failing);

    const verdict = authorizeInstanceRequest({}, "setup:write", "POST /api/settings/env");
    expect(verdict.kind).toBe("unavailable");
    if (verdict.kind !== "unavailable") return;
    expect(verdict.why).toContain("malformed");
  });
});

describe("the reading identity comes from the verified pair (round 13 #4)", () => {
  it("is the verified profile, and nothing a caller claims", () => {
    const { owner, guest } = seedIdentities();

    const asOwner = verifiedRequestViewer(headersFor(owner));
    expect(asOwner).toEqual({ kind: "viewer", viewer: owner.profileId });

    const asGuest = verifiedRequestViewer(headersFor(guest));
    expect(asGuest).toEqual({ kind: "viewer", viewer: guest.profileId });

    // Named, not proven: no viewer at all.
    expect(verifiedRequestViewer({ "x-strada-profile-id": owner.profileId })).toEqual({ kind: "viewer" });
    expect(
      verifiedRequestViewer({ "x-strada-profile-id": owner.profileId, "x-strada-profile-token": "guessed" }),
    ).toEqual({ kind: "viewer" });
    expect(verifiedRequestViewer({})).toEqual({ kind: "viewer" });
  });

  it("refuses to name a viewer when the identity state cannot be read", () => {
    seedIdentities();
    setInstanceIdentityStore(null);
    writeFileSync(dbPath(), "not a database", "utf8");
    expect(verifiedRequestViewer({}).kind).toBe("unavailable");
  });
});
