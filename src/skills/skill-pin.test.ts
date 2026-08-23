import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePin, readPin, recordPinnedCommit, describePinDrift } from "./skill-pin.js";

describe("skill-pin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strada-skill-pin-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a written pin", async () => {
    await writePin(dir, "abc123def4567890");
    const pin = await readPin(dir);
    expect(pin?.pinnedSha).toBe("abc123def4567890");
    expect(pin?.pinnedAtIso).toBeTruthy();
  });

  it("returns null pin when none was recorded", async () => {
    expect(await readPin(dir)).toBeNull();
  });

  it("recordPinnedCommit is null for a non-git directory (workspace skills)", async () => {
    expect(await recordPinnedCommit(dir)).toBeNull();
    expect(await readPin(dir)).toBeNull();
  });

  it("reports no drift when there is no git HEAD to compare (non-git dir)", async () => {
    await writePin(dir, "abc123def4567890");
    // Not a git repo → readCurrentGitSha null → cannot prove drift.
    expect(await describePinDrift(dir, "my-skill")).toBeNull();
  });
});
