import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCodexCliAvailable,
  getCodexInstallHint,
  startCodexLogin,
  __resetCodexLoginState,
} from "./openai-codex-login.js";

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
  __resetCodexLoginState();
  vi.useRealTimers();
});

describe("isCodexCliAvailable", () => {
  it("returns true when `codex --version` exits 0", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    expect(isCodexCliAvailable(spawnSync as never)).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("codex", ["--version"], expect.anything());
  });

  it("returns false when codex exits non-zero", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1 });
    expect(isCodexCliAvailable(spawnSync as never)).toBe(false);
  });

  it("returns false when spawn throws (codex not installed)", () => {
    const spawnSync = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isCodexCliAvailable(spawnSync as never)).toBe(false);
  });
});

describe("getCodexInstallHint", () => {
  it("suggests brew on macOS", () => {
    expect(getCodexInstallHint("darwin")).toContain("brew install codex");
  });

  it("always mentions the npm package", () => {
    expect(getCodexInstallHint("linux")).toContain("@openai/codex");
  });
});

describe("startCodexLogin", () => {
  it("returns an install hint when codex is unavailable", async () => {
    const result = await startCodexLogin({ isAvailable: () => false });
    expect(result.started).toBe(false);
    expect(result.error).toContain("@openai/codex");
  });

  it("spawns `codex login` detached and captures the auth URL from stdout", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = startCodexLogin({
      spawnFn: spawnFn as never,
      isAvailable: () => true,
      graceMs: 10_000,
      nowMs: 1000,
    });

    child.stdout.emit(
      "data",
      Buffer.from("To sign in, open: https://auth.openai.com/oauth?code=abc\n"),
    );

    const result = await promise;
    expect(spawnFn).toHaveBeenCalledWith("codex", ["login"], expect.objectContaining({ detached: true }));
    expect(result.started).toBe(true);
    expect(result.url).toBe("https://auth.openai.com/oauth?code=abc");
    expect(child.unref).toHaveBeenCalled();
  });

  it("resolves after the grace window even when no URL is printed", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = startCodexLogin({
      spawnFn: spawnFn as never,
      isAvailable: () => true,
      graceMs: 50,
      nowMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(60);
    const result = await promise;
    expect(result.started).toBe(true);
    expect(result.url).toBeUndefined();
  });

  it("does not spawn a second login while one is still in flight", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    const p1 = startCodexLogin({ spawnFn: spawnFn as never, isAvailable: () => true, graceMs: 5, nowMs: 1000 });
    child.stdout.emit("data", Buffer.from("https://auth.openai.com/x\n"));
    await p1;

    const p2 = await startCodexLogin({ spawnFn: spawnFn as never, isAvailable: () => true, nowMs: 2000 });
    expect(p2.started).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
