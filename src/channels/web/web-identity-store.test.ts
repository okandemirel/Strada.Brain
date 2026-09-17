import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
