/**
 * COR-20: a timed-out updater command must be gone before the promise
 * rejects, or the rollback that follows runs alongside it in the same tree.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "./auto-updater.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("spawnWithTimeout (COR-20)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.skipIf(process.platform === "win32")(
    "rejects a timed-out command only after it has exited, even when it ignores SIGTERM",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "updater-spawn-"));
      const pidFile = join(dir, "pid");
      // Ignores SIGTERM like a busy npm can, then idles until killed.
      const script =
        `process.on("SIGTERM", () => {});` +
        `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        `setInterval(() => {}, 1000);`;

      const outcome = await spawnWithTimeout(process.execPath, ["-e", script], 3_000, undefined, { killGraceMs: 300 })
        .then(() => "resolved", (error: Error) => error.message);

      expect(outcome).toContain("Command timed out");
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      // At the moment the caller is told "timed out", the command is gone.
      expect(isAlive(pid)).toBe(false);
    },
  );

  it("still returns stdout of a command that finishes in time", async () => {
    await expect(spawnWithTimeout(process.execPath, ["-e", "process.stdout.write('ok')"], 10_000)).resolves.toBe("ok");
  });

  it("reports a non-zero exit with its stderr", async () => {
    await expect(
      spawnWithTimeout(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"], 10_000),
    ).rejects.toThrow(/exited with code 3: bad/);
  });
});
