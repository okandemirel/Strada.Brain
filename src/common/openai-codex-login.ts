/**
 * Drives the official OpenAI Codex CLI login so the setup wizard can offer a real
 * "Sign in with ChatGPT" button.
 *
 * OpenAI's ChatGPT/Codex subscription auth has no public OAuth client we can
 * embed; the supported path is the `codex` CLI, which performs the browser OAuth
 * flow and writes `~/.codex/auth.json` in exactly the shape
 * {@link inspectOpenAiSubscriptionAuth} reads. We therefore shell out to
 * `codex login` and let the caller poll the auth file for completion.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const CODEX_BIN = "codex";
const AUTH_URL_RE = /(https?:\/\/[^\s"']+)/;
/** A login attempt is considered "in flight" for this long before we allow a new spawn. */
const LOGIN_DEDUP_MS = 5 * 60_000;

export interface CodexLoginStart {
  readonly started: boolean;
  /** Auth URL printed by `codex login` (best-effort) so the UI can offer a manual link. */
  readonly url?: string;
  readonly error?: string;
}

/** Returns true when the `codex` CLI is callable on this machine. */
export function isCodexCliAvailable(spawnSyncFn: typeof spawnSync = spawnSync): boolean {
  try {
    const result = spawnSyncFn(CODEX_BIN, ["--version"], { stdio: "ignore", timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Platform-aware instructions for installing the Codex CLI. */
export function getCodexInstallHint(platform: NodeJS.Platform = process.platform): string {
  const npm = "npm install -g @openai/codex";
  if (platform === "darwin") {
    return `Codex CLI not found. Install it with \`brew install codex\` or \`${npm}\`, then sign in again.`;
  }
  return `Codex CLI not found. Install it with \`${npm}\`, then sign in again.`;
}

// Module-level tracker so repeated button presses do not spawn duplicate logins.
let activeLogin: { startedAtMs: number } | null = null;

interface StartCodexLoginOptions {
  readonly spawnFn?: typeof spawn;
  readonly isAvailable?: () => boolean;
  /** How long to wait for the auth URL before resolving anyway. */
  readonly graceMs?: number;
  readonly nowMs?: number;
}

/**
 * Spawns `codex login` (browser OAuth) detached and resolves once the auth URL is
 * captured or a short grace window elapses. The child keeps running; callers
 * should poll {@link inspectOpenAiSubscriptionAuth} until the token is written.
 */
export function startCodexLogin(options: StartCodexLoginOptions = {}): Promise<CodexLoginStart> {
  const spawnFn = options.spawnFn ?? spawn;
  const isAvailable = options.isAvailable ?? (() => isCodexCliAvailable());
  const graceMs = options.graceMs ?? 4000;
  const nowMs = options.nowMs ?? Date.now();

  if (!isAvailable()) {
    return Promise.resolve({ started: false, error: getCodexInstallHint() });
  }

  if (activeLogin && nowMs - activeLogin.startedAtMs < LOGIN_DEDUP_MS) {
    return Promise.resolve({ started: true });
  }

  return new Promise<CodexLoginStart>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(CODEX_BIN, ["login"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      activeLogin = null;
      resolve({ started: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    activeLogin = { startedAtMs: nowMs };
    let settled = false;
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      try {
        child.unref();
      } catch {
        // best-effort detach
      }
      resolve({ started: true, url });
    };

    const onData = (buf: Buffer): void => {
      if (url) return;
      const match = buf.toString("utf8").match(AUTH_URL_RE);
      if (match) {
        url = match[1];
        finish();
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err: Error) => {
      activeLogin = null;
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ started: false, error: err.message });
      }
    });
    child.on("exit", () => {
      activeLogin = null;
      finish();
    });

    timer = setTimeout(finish, graceMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });
}

/** Test-only: clears the in-flight login tracker. */
export function __resetCodexLoginState(): void {
  activeLogin = null;
}
