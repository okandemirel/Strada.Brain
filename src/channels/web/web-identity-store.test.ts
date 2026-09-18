import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { WebIdentityStore } from "./web-identity-store.js";

describe("WebIdentityStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies issued tokens for the same profile", () => {
    const store = new WebIdentityStore(":memory:");
    const identity = store.issue("stable-profile");

    expect(store.verify(identity.profileId, identity.profileToken)).toBe(true);
    expect(store.verify(identity.profileId, "wrong-token")).toBe(false);

    store.close();
  });

  it("persists identities across store restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "strada-web-identity-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "web-identities.db");

    const firstStore = new WebIdentityStore(dbPath);
    const identity = firstStore.issue("stable-profile");
    firstStore.close();

    const secondStore = new WebIdentityStore(dbPath);
    expect(secondStore.verify(identity.profileId, identity.profileToken)).toBe(true);
    secondStore.close();
  });
});

/**
 * Codex round 13 #8 — UPGRADING AN EXISTING INSTANCE MUST NOT HAND IT AWAY.
 *
 * `web_instance_meta` (and with it the recorded owner) arrived with plan 6.14.
 * Every instance that served a portal BEFORE that already has a populated
 * `web_identities` table and an empty — or, on an older build, absent — owner
 * table. Nothing in `initialize()` looked at those established identities, and
 * a reconnecting browser does not re-issue, so the owner row stayed empty until
 * the next identity this instance issued claimed it: the next NEWCOMER became
 * the owner of somebody else's instance, and the real operator became a guest.
 */
describe("WebIdentityStore ownership on an upgraded database (round 13 #8)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function upgradedDatabase(): { dbPath: string; first: string; second: string } {
    const dir = mkdtempSync(join(tmpdir(), "strada-web-identity-upgrade-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "web-identities.db");

    // An instance that has served two browsers…
    const before = new WebIdentityStore(dbPath);
    const first = before.issue("established-owner").profileId;
    const second = before.issue("established-guest").profileId;
    before.close();

    // …and whose owner row does not exist yet, exactly as it does not on any
    // database written before plan 6.14.
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE IF EXISTS web_instance_meta");
    raw.close();

    return { dbPath, first, second };
  }

  it("adopts the FIRST established identity as owner instead of leaving the seat empty", () => {
    const { dbPath, first, second } = upgradedDatabase();

    const store = new WebIdentityStore(dbPath);
    expect(store.ownerProfileId()).toBe(first);
    expect(store.isOwner(first)).toBe(true);
    expect(store.isOwner(second)).toBe(false);
    store.close();
  });

  it("does not let the next newly issued identity claim the upgraded instance", () => {
    const { dbPath, first } = upgradedDatabase();

    const store = new WebIdentityStore(dbPath);
    const newcomer = store.issue();
    expect(newcomer.profileId).not.toBe(first);
    expect(store.ownerProfileId()).toBe(first);
    expect(store.isOwner(newcomer.profileId)).toBe(false);
    store.close();
  });

  it("still leaves a never-used instance to its first identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "strada-web-identity-fresh-"));
    tempDirs.push(dir);
    const store = new WebIdentityStore(join(dir, "web-identities.db"));
    expect(store.ownerProfileId()).toBeUndefined();
    const firstEver = store.issue();
    expect(store.ownerProfileId()).toBe(firstEver.profileId);
    store.close();
  });
});

/**
 * Codex round 14 #7 — THE DOCUMENTED RECOVERY HAS TO BE A RECOVERY.
 *
 * The owner is the first identity this instance issued, so an operator who loses
 * the browser's localStorage comes back as a guest. The comment on claimOwner
 * told them to delete the `owner_profile_id` row and restart — which was true
 * until round 13 #8 taught `initialize()` to adopt the oldest established
 * identity: adoption now restores the very identity they cannot reach, and the
 * replacement browser stays a guest forever. A recovery procedure that the fix
 * for another defect quietly disabled is worse than none, because it is written
 * down.
 */
describe("WebIdentityStore owner reassignment (round 14 #7)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function instanceWithLostOwner(): { dbPath: string; lost: string; replacement: string } {
    const dir = mkdtempSync(join(tmpdir(), "strada-owner-recovery-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "web-identities.db");
    const store = new WebIdentityStore(dbPath);
    const lost = store.issue("the-lost-browser").profileId;      // owner, storage wiped
    const replacement = store.issue("the-new-browser").profileId; // the operator's new tab
    expect(store.ownerProfileId()).toBe(lost);
    store.close();
    return { dbPath, lost, replacement };
  }

  it("the old advice — delete the owner row and restart — no longer recovers anything", () => {
    const { dbPath, lost, replacement } = instanceWithLostOwner();
    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM web_instance_meta WHERE key = 'owner_profile_id'").run();
    raw.close();

    // Round 13 #8's adoption puts the unreachable identity straight back.
    const restarted = new WebIdentityStore(dbPath);
    expect(restarted.ownerProfileId()).toBe(lost);
    expect(restarted.isOwner(replacement)).toBe(false);
    restarted.close();
  });

  it("reassignOwner hands the instance to the replacement identity, and a restart keeps it", () => {
    const { dbPath, lost, replacement } = instanceWithLostOwner();

    const offline = new WebIdentityStore(dbPath);
    expect(offline.reassignOwner(replacement)).toBe(replacement);
    expect(offline.isOwner(replacement)).toBe(true);
    expect(offline.isOwner(lost)).toBe(false);
    offline.close();

    // The daemon comes back up: adoption must not undo a deliberate handover.
    const restarted = new WebIdentityStore(dbPath);
    expect(restarted.ownerProfileId()).toBe(replacement);
    restarted.close();
  });

  it("refuses to hand the instance to an identity it never issued", () => {
    const { dbPath, lost } = instanceWithLostOwner();
    const store = new WebIdentityStore(dbPath);

    // A typo in the recovery procedure must not brick every owner-only power.
    expect(store.reassignOwner("a-profile-that-does-not-exist")).toBe(lost);
    expect(store.reassignOwner("")).toBe(lost);
    expect(store.ownerProfileId()).toBe(lost);
    store.close();
  });

  // TEST THE RECOVERY YOU DOCUMENT. The runbook prints a one-line UPDATE for
  // operators who would rather not load the module; this reads that very line out
  // of docs/RUNBOOK.md and runs it, so the two cannot drift apart.
  it("the SQL the runbook prints has the same effect as the method", () => {
    const runbook = readFileSync(join(process.cwd(), "docs", "RUNBOOK.md"), "utf8");
    const printed = /UPDATE web_instance_meta SET value = '<the new profile id>' WHERE key = 'owner_profile_id';/
      .exec(runbook);
    expect(printed, "docs/RUNBOOK.md must print the owner handover SQL").not.toBeNull();

    const { dbPath, replacement } = instanceWithLostOwner();
    const raw = new Database(dbPath);
    raw.prepare(printed![0].replace("<the new profile id>", replacement)).run();
    raw.close();

    const restarted = new WebIdentityStore(dbPath);
    expect(restarted.isOwner(replacement)).toBe(true);
    restarted.close();
  });

  it("the runbook tells the operator NOT to delete the owner row", () => {
    const runbook = readFileSync(join(process.cwd(), "docs", "RUNBOOK.md"), "utf8");
    // The advice that stopped working is named as such, so nobody follows the old
    // one out of habit (round 14 #7).
    expect(runbook).toContain("NOT deleting the owner row");
    expect(runbook).toContain("reassignOwner");
  });
});
