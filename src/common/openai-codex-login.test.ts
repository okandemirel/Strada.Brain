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
    expect(isCodexCliAvailable(spawnSync as never, "linux")).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("codex", ["--version"], expect.objectContaining({ shell: false }));
  });

  // npm installs `codex.cmd` on Windows; a shell-less spawn of "codex" never
  // finds it, so the CLI always read as missing there.
  it("probes codex.cmd through a shell on Windows", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    expect(isCodexCliAvailable(spawnSync as never, "win32")).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("codex.cmd", ["--version"], expect.objectContaining({ shell: true }));
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
      platform: "linux",
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

  it("spawns codex.cmd through a shell on Windows", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = startCodexLogin({
      spawnFn: spawnFn as never,
      isAvailable: () => true,
      graceMs: 10_000,
      nowMs: 1000,
      platform: "win32",
    });
    child.stdout.emit("data", Buffer.from("https://auth.openai.com/oauth?code=abc\n"));
    await promise;

    expect(spawnFn).toHaveBeenCalledWith("codex.cmd", ["login"], expect.objectContaining({ shell: true }));
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

// What codex 0.153's cli/src/login.rs prints: its own callback server first, the
// OpenAI page after it. The redirect_uri inside the real URL names localhost too.
const REAL_AUTH_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test" +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access" +
  "&code_challenge=abc&code_challenge_method=S256&state=xyz&originator=codex_cli_rs";
const REAL_OUTPUT =
  "Starting local login server on http://localhost:1455.\n" +
  "If your browser did not open, navigate to this URL to authenticate:\n\n" +
  `${REAL_AUTH_URL}\n\n` +
  "On a remote or headless machine? Use `codex login --device-auth` instead.\n";

describe("startCodexLogin with codex's real output", () => {
  function start(child: FakeChild) {
    return startCodexLogin({
      spawnFn: vi.fn().mockReturnValue(child) as never,
      isAvailable: () => true,
      graceMs: 10_000,
      nowMs: 1000,
      platform: "linux",
    });
  }

  it("links the OpenAI sign-in page, not the local callback server, when it arrives in one write", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    child.stderr.emit("data", Buffer.from(REAL_OUTPUT));
    const result = await promise;
    expect(result.started).toBe(true);
    expect(result.url).toBe(REAL_AUTH_URL);
  });

  it("links the whole sign-in page when the output arrives piece by piece and the URL is split", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    const at = REAL_OUTPUT.indexOf(REAL_AUTH_URL) + 40;
    child.stderr.emit("data", Buffer.from("Starting local login server on http://localhost:"));
    child.stderr.emit("data", Buffer.from(REAL_OUTPUT.slice("Starting local login server on http://localhost:".length, at)));
    child.stderr.emit("data", Buffer.from(REAL_OUTPUT.slice(at)));
    const result = await promise;
    expect(result.url).toBe(REAL_AUTH_URL);
  });

  it("reports a codex login that exits with an error before any sign-in page as not started", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    child.stderr.emit("data", Buffer.from("Error: Address already in use (os error 48)\n"));
    child.emit("exit", 1, null);
    const result = await promise;
    expect(result.started).toBe(false);
    expect(result.error).toContain("Address already in use");
  });
});
