/**
 * ROUND 13 #18 — AN OPENER TAKES PART IN THE RESTORE'S EXCLUSION.
 *
 * The restore refuses while a database still has a user attached, but that probe
 * can only describe the instant it ran: a store that opens one of the databases
 * during the swap holds the inode the restore is about to rename away and
 * delete, and the restore then exits 0 while the daemon's rows go to a file
 * nobody will ever read again. The check had to grow a second side — the opener
 * consulting the same lock file the restore claims.
 *
 * LearningStorage is that side here (learning.db is one of the restored
 * databases). A lock whose holder is DEAD must not block it: wedging the daemon
 * out of its own store would be the second data-loss route.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAINTENANCE_LOCK_FILE,
  acquireMaintenanceExclusion,
} from "../../core/database-backup.js";
import { LearningStorage } from "./learning-storage.js";

let dir: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "learning-exclusion-"));
  home = join(dir, "strada-home");
  mkdirSync(home, { recursive: true });
  previousHome = process.env["STRADA_HOME"];
  // Never the real ~/.strada: the guard reads the resolved home, so the test
  // points it at a fixture.
  process.env["STRADA_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["STRADA_HOME"];
  else process.env["STRADA_HOME"] = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("a learning store opened while a restore holds the exclusion", () => {
  it("refuses to open, names the holder, and opens again once it is released", () => {
    const held = acquireMaintenanceExclusion(home, "restore");
    const blocked = new LearningStorage(join(dir, "learning.db"));
    try {
      expect(() => blocked.initialize()).toThrow(
        new RegExp(`maintenance operation \\(restore\\)[\\s\\S]*pid ${process.pid}`),
      );
      // The repro: it opened, and the restore's swap then replaced the file
      // under this connection while both reported success.
      expect(existsSync(join(dir, "learning.db"))).toBe(false);
    } finally {
      held.release();
      blocked.close();
    }

    const after = new LearningStorage(join(dir, "learning.db"));
    after.initialize();
    try {
      expect(existsSync(join(dir, "learning.db"))).toBe(true);
    } finally {
      after.close();
    }
  });

  it("opens through a lock whose holder is gone, rather than wedging the daemon", () => {
    writeFileSync(
      join(home, MAINTENANCE_LOCK_FILE),
      JSON.stringify({ pid: 999_999_999, startedAtIso: "2026-01-01T00:00:00.000Z", purpose: "restore" }),
    );
    const storage = new LearningStorage(join(dir, "learning.db"));
    storage.initialize();
    try {
      expect(existsSync(join(dir, "learning.db"))).toBe(true);
    } finally {
      storage.close();
    }
  });
});
