import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBoundedCommand } from "./bounded-command.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitGone = async (pid: number, withinMs: number): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
};

describe.skipIf(process.platform === "win32")("runBoundedCommand — the budget binds the whole tree (CMP-9)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const pidFile = (): string => {
    dir = mkdtempSync(join(tmpdir(), "bounded-cmd-"));
    return join(dir, "child.pid");
  };
  const readPid = (file: string): number => Number(readFileSync(file, "utf8").trim());

  it("a command that exits while a background child holds stdout is done, not timed out", async () => {
    const file = pidFile();
    const started = Date.now();
    const res = await runBoundedCommand({
      command: "/bin/sh",
      args: ["-c", `sleep 60 & echo $! > '${file}'; echo finished`],
      timeoutMs: 20_000,
      drainMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("finished");
    // …and the straggler is retired with the command.
    expect(await waitGone(readPid(file), 5_000)).toBe(true);
  });

  it("a timeout kills the command's children, not only the shell", async () => {
    const file = pidFile();
    const res = await runBoundedCommand({
      command: "/bin/sh",
      args: ["-c", `sleep 60 & echo $! > '${file}'; wait`],
      timeoutMs: 500,
      graceMs: 500,
      drainMs: 200,
    });
    expect(res.timedOut).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(await waitGone(readPid(file), 5_000)).toBe(true);
  });

  it("an ordinary command reports its exit status and output", async () => {
    const res = await runBoundedCommand({ command: "/bin/sh", args: ["-c", "echo out; echo err >&2; exit 3"], timeoutMs: 10_000 });
    expect(res).toMatchObject({ status: 3, timedOut: false, error: null });
    expect(res.stdout.trim()).toBe("out");
    expect(res.stderr.trim()).toBe("err");
  });

  it("a command that cannot start is an error, not a hang", async () => {
    const res = await runBoundedCommand({ command: join(tmpdir(), "no-such-binary-bounded-cmd"), args: [], timeoutMs: 10_000 });
    expect(res.error).not.toBeNull();
    expect(res.timedOut).toBe(false);
  });
});
