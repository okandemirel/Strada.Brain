import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
