/**
 * A timeout that can itself hang is not a timeout.
 *
 * Measured on the run of 2026-08-20: the agent could not find the Unity editor
 * and ran `find /Users ...`. shell_exec's limit was 30 seconds; the command
 * ran 45 minutes and 27 seconds, took the whole run with it, and reported
 * success — isError was false, so nothing counted it as a failure either.
 *
 * The shell is killed; what the shell started is not. It keeps the inherited
 * stdout pipe open, and 'close' waits on the pipe.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process-runner.js";

describe("a command that outlives its shell", () => {
  it("stops waiting for a grandchild holding the pipe open", async () => {
    const started = Date.now();

    // The pipeline makes bash fork rather than exec, so the sleep is a
    // grandchild: signalling bash alone leaves it running.
    const result = await runProcess({
      command: "/bin/bash",
      args: ["-c", "sleep 30 | cat"],
      cwd: process.cwd(),
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    // Tight on purpose: the 8s abandon net would also get us under ten
    // seconds, and then this would pass while the kill did nothing.
    expect(Date.now() - started, "returned late — the kill did not reach the pipe").toBeLessThan(4_000);
  }, 20_000);

  it("leaves nothing of the command running", async () => {
    // pgrep matches on the command line, so the sleeper needs a name of its
    // own — arguments to `sleep` would just make it fail immediately and
    // leave nothing to find either way.
    const dir = mkdtempSync(join(tmpdir(), "strada-runner-"));
    // Unique per run: a survivor left by an earlier run would otherwise be
    // counted as this one's, which is exactly the failure being tested for.
    const marker = `strada-probe-${process.pid}-${Math.round(performance.now())}`;
    const sleeper = join(dir, `${marker}.sh`);
    writeFileSync(sleeper, "#!/bin/bash\nsleep 25\n", { mode: 0o755 });

    await runProcess({
      command: "/bin/bash",
      args: ["-c", `${sleeper} | cat`],
      cwd: process.cwd(),
      timeoutMs: 500,
    });

    const survivors = await runProcess({
      command: "/bin/bash",
      args: ["-c", `pgrep -f "[s]${marker.slice(1)}" | wc -l`],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    rmSync(dir, { recursive: true, force: true });

    expect(Number(survivors.stdout.trim()), "the grandchild outlived the kill").toBe(0);
  }, 20_000);

  it("still reports an ordinary command normally", async () => {
    const result = await runProcess({
      command: "/bin/bash",
      args: ["-c", "echo hello"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("carries a failing command's exit code", async () => {
    const result = await runProcess({
      command: "/bin/bash",
      args: ["-c", "exit 3"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });
});

describe("a process the kill cannot reach", () => {
  // The group kill covers what the shell starts. It does not cover something
  // that leaves the group on purpose — and such a process still holds the
  // stdout pipe this side is reading, so 'close' would wait for it. The
  // backstop exists for exactly that, and this is what exercises it.
  it("answers anyway rather than waiting on the pipe", async () => {
    const started = Date.now();

    const result = await runProcess({
      command: "/bin/bash",
      // The trailing `true` stops bash exec'ing python into its own place:
      // as the group leader it could not leave the group, which is the thing
      // this test needs it to do.
      args: ["-c", 'python3 -c "import os,time; os.setsid(); time.sleep(30)" ; true'],
      cwd: process.cwd(),
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    const elapsed = Date.now() - started;
    expect(elapsed, "waited for the escaped process").toBeLessThan(12_000);
    expect(elapsed, "returned before the backstop could have fired").toBeGreaterThan(5_000);
  }, 40_000);
});

// Audited 2026-09-02: output past the capture cap kept only the TAIL and said
// nothing. `dotnet test -v normal` on a mid-size project runs to ~60KB; the
// failing-test list and the first compile errors are printed BEFORE the summary,
// so they were exactly what vanished, and shell_exec printed the remainder under
// `--- stdout ---` as if it were the whole. A verdict formed on evidence that was
// never seen must at least say so.
describe("output past the capture cap", () => {
  // 1000 lines of `LINE nnnn ` + 56 x's + newline = 67 chars each, ~67KB: four
  // times the default cap, so the head is guaranteed to fall off.
  const script =
    'for i in $(seq -f "%04g" 1 1000); do echo "LINE $i $(printf "%56s" | tr " " x)"; done';

  it("marks the dropped head and counts it, instead of presenting the tail as the whole", async () => {
    const full = await runProcess({
      command: "/bin/bash",
      args: ["-c", script],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutput: 1_000_000,
    });
    expect(full.stdoutDropped).toBe(0);
    expect(full.stdout).toContain("LINE 0001");

    const capped = await runProcess({
      command: "/bin/bash",
      args: ["-c", script],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    // The tail survived, the head did not — that part is by design.
    expect(capped.stdout).toContain("LINE 1000");
    expect(capped.stdout).not.toContain("LINE 0001");

    // What is NOT by design: pretending nothing happened.
    expect(capped.stdoutDropped, "the runner did not count what it threw away").toBeGreaterThan(0);
    const marker = /^\[… (\d+) earlier characters of stdout dropped by the (\d+)-character capture limit; what follows is the TAIL of the output …\]\n/;
    const m = marker.exec(capped.stdout);
    expect(m, `stdout does not open with a truncation marker: ${JSON.stringify(capped.stdout.slice(0, 80))}`).not.toBeNull();
    expect(Number(m![1])).toBe(capped.stdoutDropped);
    expect(Number(m![2])).toBe(16_384);

    // The count is a measurement, not a guess: kept + dropped == what the
    // command actually produced.
    const kept = capped.stdout.length - m![0].length;
    expect(kept + capped.stdoutDropped).toBe(full.stdout.length);
    expect(capped.stderrDropped).toBe(0);
  });

  it("applies the same to stderr", async () => {
    const result = await runProcess({
      command: "/bin/bash",
      args: ["-c", `(${script}) 1>&2`],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.stderrDropped).toBeGreaterThan(0);
    expect(result.stderr).toMatch(/^\[… \d+ earlier characters of stderr dropped by the 16384-character capture limit/);
    expect(result.stderr).toContain("LINE 1000");
    expect(result.stdout).toBe("");
    expect(result.stdoutDropped).toBe(0);
  });

  it("leaves output within the cap untouched and unmarked", async () => {
    const result = await runProcess({
      command: "/bin/bash",
      args: ["-c", "echo hello"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe("hello\n");
    expect(result.stdoutDropped).toBe(0);
    expect(result.stderrDropped).toBe(0);
  });
});
