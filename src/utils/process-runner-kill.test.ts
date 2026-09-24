/**
 * The timeout kill on Windows, exercised on every platform.
 *
 * Windows has no process groups: the negative-pid kill the POSIX path uses
 * either throws (swallowed) or ends only cmd.exe, and the real command keeps
 * the pipes and runs on. These tests pin which kill each platform gets and
 * that runProcess wires the Windows one up, without needing a Windows host.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});

const { planTreeKill, runProcess } = await import("./process-runner.js");

type ExecFileCallback = (err: Error | null) => void;

function fakeChild(pid: number, kill: () => boolean = () => true) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(kill),
  });
}

describe("planTreeKill", () => {
  it("signals the whole process group on POSIX", () => {
    expect(planTreeKill("linux", 4321, "SIGTERM")).toEqual({ kind: "group", pid: -4321, signal: "SIGTERM" });
    expect(planTreeKill("darwin", 4321, "SIGKILL")).toEqual({ kind: "group", pid: -4321, signal: "SIGKILL" });
  });

  it("walks the tree with taskkill /T /F on Windows, by absolute path", () => {
    const plan = planTreeKill("win32", 4321, "SIGTERM", { SystemRoot: "C:\\Windows" });
    expect(plan).toEqual({
      kind: "taskkill",
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/pid", "4321", "/T", "/F"],
    });
  });

  it("still names taskkill when SystemRoot is unknown", () => {
    const plan = planTreeKill("win32", 7, "SIGKILL", {});
    expect(plan).toEqual({ kind: "taskkill", command: "taskkill.exe", args: ["/pid", "7", "/T", "/F"] });
  });
});

describe("runProcess timeout, per platform", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, "platform", { ...realPlatform, value });
  };

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    spawnMock.mockReset();
    execFileMock.mockReset();
    vi.restoreAllMocks();
  });

  it("win32: spawns without a process group and kills the tree with taskkill", async () => {
    setPlatform("win32");
    const child = fakeChild(4321);
    spawnMock.mockReturnValue(child);
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      // taskkill ends the tree; the pipes close and the shell reports.
      setImmediate(() => {
        cb(null);
        child.emit("close", 1);
      });
    });
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await runProcess({ command: "cmd.exe", args: ["/d", "/s", "/c", "ping"], cwd: ".", timeoutMs: 20 });

    const spawnOpts = spawnMock.mock.calls[0]![2] as { detached?: boolean; windowsHide?: boolean };
    expect(spawnOpts.detached, "detached on Windows opens a new console and joins no group").toBe(false);
    expect(spawnOpts.windowsHide).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]! as [string, string[]];
    expect(cmd).toMatch(/taskkill\.exe$/i);
    expect(args).toEqual(["/pid", "4321", "/T", "/F"]);
    expect(groupKill, "a negative-pid kill does nothing useful on Windows").not.toHaveBeenCalled();
    expect(result.timedOut).toBe(true);
  });

  it("win32: falls back to the direct child when taskkill cannot start", async () => {
    setPlatform("win32");
    const child = fakeChild(99, () => {
      setImmediate(() => child.emit("close", null));
      return true;
    });
    spawnMock.mockReturnValue(child);
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(Object.assign(new Error("spawn taskkill.exe ENOENT"), { code: "ENOENT" }));
    });

    const result = await runProcess({ command: "cmd.exe", args: [], cwd: ".", timeoutMs: 20 });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("POSIX: keeps the process-group spawn and the negative-pid kill", async () => {
    setPlatform("linux");
    const child = fakeChild(55);
    spawnMock.mockReturnValue(child);
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => {
      setImmediate(() => child.emit("close", null));
      return true;
    });

    const result = await runProcess({ command: "/bin/bash", args: ["-c", "sleep 9"], cwd: ".", timeoutMs: 20 });

    expect((spawnMock.mock.calls[0]![2] as { detached?: boolean }).detached).toBe(true);
    expect(groupKill).toHaveBeenCalledWith(-55, "SIGTERM");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(result.timedOut).toBe(true);
  });
});
