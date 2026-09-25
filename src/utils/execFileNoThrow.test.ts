import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileNoThrow } from "./execFileNoThrow.js";

// Node reports the exit code in `error.code`; the wrapper read a nonexistent
// `exitCode` property, so every failure came back as exit 1 and a timeout
// looked exactly like an ordinary failure.
describe("execFileNoThrow", () => {
  const node = process.execPath;

  it("carries the command's real exit code", async () => {
    const result = await execFileNoThrow(node, ["-e", "process.exit(42)"]);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it("reports a timeout as 124 and says so", async () => {
    const result = await execFileNoThrow(node, ["-e", "setTimeout(() => {}, 10000)"], 200);
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
  });

  it("reports success as 0", async () => {
    const result = await execFileNoThrow(node, ["-e", "process.stdout.write('ok')"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
  });

  it("reports a missing binary as 127", async () => {
    const result = await execFileNoThrow("strada-no-such-binary-xyz", []);
    expect(result.exitCode).toBe(127);
  });

  it("runs in the given working directory", async () => {
    const dir = realpathSync(tmpdir());
    const result = await execFileNoThrow(node, ["-e", "process.stdout.write(process.cwd())"], 5000, undefined, { cwd: dir });
    expect(result.stdout).toBe(dir);
  });
});
