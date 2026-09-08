/**
 * The run's temp files land in the run's own root — the one the global
 * setup creates and its teardown removes — so a test that forgets to clean
 * up leaves nothing behind on the machine.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

describe("test temp root", () => {
  it("os.tmpdir() inside a worker is the per-run root the global setup created", () => {
    const root = process.env["STRADA_VITEST_TMP_ROOT"];
    expect(root, "global setup did not run").toBeTruthy();
    expect(tmpdir().replace(/\/$/, "")).toBe(root!.replace(/\/$/, ""));
    const dir = mkdtempSync(join(tmpdir(), "tmp-root-probe-"));
    expect(dir.startsWith(root! + sep)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
