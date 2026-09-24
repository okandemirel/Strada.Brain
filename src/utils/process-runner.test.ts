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

// Windows has no process groups; the timeout walks the tree with taskkill
// instead. This one needs a real Windows host (process-runner-kill.test.ts
// covers the wiring on every platform).
describe.runIf(process.platform === "win32")("a timed-out command on Windows", () => {
  const shell = process.env["COMSPEC"] ?? "cmd.exe";
  const pingCount = async (): Promise<number> => {
    const listed = await runProcess({
      command: shell,
      args: ["/d", "/s", "/c", 'tasklist /FI "IMAGENAME eq PING.EXE" /NH'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    return (listed.stdout.match(/^PING\.EXE/gim) ?? []).length;
  };

  it("kills the grandchild, not just cmd.exe, and returns promptly", async () => {
    const before = await pingCount();
    const started = Date.now();

    const result = await runProcess({
      command: shell,
      args: ["/d", "/s", "/c", "ping -n 30 127.0.0.1 >nul"],
      cwd: process.cwd(),
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started, "returned late — the kill did not reach the pipe").toBeLessThan(4_000);
    expect(await pingCount(), "ping.exe outlived the timeout").toBeLessThanOrEqual(before);
  }, 30_000);
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
// TLS-10: marking the loss was not enough. The tool-result cap downstream cuts
// from the head, so a tail-only capture handed the model the MIDDLE of the
// output — neither the first errors nor the summary. Both ends are kept now.
describe("output past the capture cap", () => {
  // 1000 lines of `LINE nnnn ` + 56 x's + newline = 67 chars each, ~67KB: four
  // times the default cap, so the middle is guaranteed to fall out.
  // One awk process, not a shell loop forking printf+tr per line: the loop
  // was 2000 forks, and under machine load (a sprite generator saturating the
  // CPU, measured 2026-09-10) it overran the 10 s timeout, was killed, and the
  // truncated output failed assertions that are about the cap, not the clock.
  const script =
    'awk \'BEGIN { x = sprintf("%56s", ""); gsub(/ /, "x", x); for (i = 1; i <= 1000; i++) printf "LINE %04d %s\\n", i, x }\'';
  const marker = (stream: string): RegExp =>
    new RegExp(
      `\\n\\[… (\\d+) characters of ${stream} omitted from the MIDDLE by the (\\d+)-character capture limit; ` +
        `the first (\\d+) and the last (\\d+) are kept …\\]\\n`,
    );

  it("keeps the head and the tail, and marks and counts the dropped middle", async () => {
    const full = await runProcess({
      command: "/bin/bash",
      args: ["-c", script],
      cwd: process.cwd(),
      timeoutMs: 60_000,
      maxOutput: 1_000_000,
    });
    expect(full.stdoutDropped).toBe(0);
    expect(full.stdout).toContain("LINE 0001");

    const capped = await runProcess({
      command: "/bin/bash",
      args: ["-c", script],
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });

    // Both ends survive: the first errors and the closing summary.
    expect(capped.stdout.startsWith("LINE 0001"), "the head was dropped").toBe(true);
    expect(capped.stdout).toContain("LINE 1000");
    expect(capped.stdout).not.toContain("LINE 0500");

    // And the loss is said, in place, with a measured count.
    expect(capped.stdoutDropped, "the runner did not count what it threw away").toBeGreaterThan(0);
    const m = marker("stdout").exec(capped.stdout);
    expect(m, "stdout carries no truncation marker").not.toBeNull();
    const [dropped, cap, first, last] = m!.slice(1).map(Number) as [number, number, number, number];
    expect(dropped).toBe(capped.stdoutDropped);
    expect(cap).toBe(16_384);
    expect(first + last).toBe(16_384);

    // The kept text is the command's real first and last characters, and
    // kept + dropped == what the command actually produced.
    expect(capped.stdout.slice(0, m!.index)).toBe(full.stdout.slice(0, first));
    expect(capped.stdout.slice(m!.index + m![0].length)).toBe(full.stdout.slice(-last));
    expect(first + last + dropped).toBe(full.stdout.length);
    expect(capped.stderrDropped).toBe(0);
  });

  it("applies the same to stderr", async () => {
    const result = await runProcess({
      command: "/bin/bash",
      args: ["-c", `(${script}) 1>&2`],
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });
    expect(result.stderrDropped).toBeGreaterThan(0);
    expect(result.stderr).toMatch(marker("stderr"));
    expect(result.stderr.startsWith("LINE 0001")).toBe(true);
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
