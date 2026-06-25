import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isClaudeCliAvailable,
  getClaudeInstallHint,
  startClaudeLogin,
  __resetClaudeLoginState,
} from "./claude-cli-login.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: ReturnType<typeof vi.fn>;
  pid: number;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  child.pid = 4242;
  return child;
}

afterEach(() => {
  __resetClaudeLoginState();
  vi.useRealTimers();
});

describe("isClaudeCliAvailable", () => {
  it("returns true when `claude --version` exits 0", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    expect(isClaudeCliAvailable(spawnSync as never, "darwin")).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("claude", ["--version"], expect.anything());
  });

  it("uses claude.cmd on Windows", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    expect(isClaudeCliAvailable(spawnSync as never, "win32")).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("claude.cmd", ["--version"], expect.anything());
  });

  it("returns false when claude exits non-zero", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1 });
    expect(isClaudeCliAvailable(spawnSync as never, "linux")).toBe(false);
  });

  it("returns false when spawn throws (claude not installed)", () => {
    const spawnSync = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isClaudeCliAvailable(spawnSync as never, "linux")).toBe(false);
  });
});

describe("getClaudeInstallHint", () => {
  it("suggests brew on macOS", () => {
    expect(getClaudeInstallHint("darwin")).toContain("brew install claude");
  });

  it("always mentions the npm package", () => {
    expect(getClaudeInstallHint("linux")).toContain("@anthropic-ai/claude-code");
  });
});

describe("startClaudeLogin", () => {
  it("returns an install hint when claude is unavailable", async () => {
    const result = await startClaudeLogin({ isAvailable: () => false, platform: "linux" });
    expect(result.started).toBe(false);
    expect(result.error).toContain("@anthropic-ai/claude-code");
  });

  it("spawns the fixed `claude auth login --claudeai` argv and captures the auth URL", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = startClaudeLogin({
      spawnFn: spawnFn as never,
      isAvailable: () => true,
      graceMs: 10_000,
      nowMs: 1000,
      platform: "darwin",
    });

    child.stdout.emit(
      "data",
      Buffer.from("To sign in, open: https://claude.ai/oauth?code=abc\n"),
    );

    const result = await promise;
    // Fixed argv — no shell string, no interpolation of user input → no command injection.
    expect(spawnFn).toHaveBeenCalledWith(
      "claude",
      ["auth", "login", "--claudeai"],
      expect.objectContaining({ detached: true }),
    );
    const argv = spawnFn.mock.calls[0][1] as string[];
    expect(Array.isArray(argv)).toBe(true);
    // No argument is a shell metacharacter-laden injected string.
    expect(argv).toEqual(["auth", "login", "--claudeai"]);
    expect(result.started).toBe(true);
    expect(result.url).toBe("https://claude.ai/oauth?code=abc");
    expect(child.unref).toHaveBeenCalled();
  });

  it("resolves after the grace window even when no URL is printed", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = startClaudeLogin({
      spawnFn: spawnFn as never,
      isAvailable: () => true,
      graceMs: 50,
      nowMs: 1000,
      platform: "linux",
    });

    await vi.advanceTimersByTimeAsync(60);
    const result = await promise;
    expect(result.started).toBe(true);
    expect(result.url).toBeUndefined();
  });

  it("does not spawn a second login while one is still in flight", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    const p1 = startClaudeLogin({ spawnFn: spawnFn as never, isAvailable: () => true, graceMs: 5, nowMs: 1000, platform: "linux" });
    child.stdout.emit("data", Buffer.from("https://claude.ai/x\n"));
    await p1;

    const p2 = await startClaudeLogin({ spawnFn: spawnFn as never, isAvailable: () => true, nowMs: 2000, platform: "linux" });
    expect(p2.started).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
