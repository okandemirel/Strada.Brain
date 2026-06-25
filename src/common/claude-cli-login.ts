/**
 * Drives the official Claude CLI login so the setup wizard can offer a one-click
 * "Sign in with Claude" subscription button, mirroring the OpenAI/Codex flow.
 *
 * Claude's subscription auth has no public OAuth client we can embed; the
 * supported path is the `claude` CLI, which performs the browser OAuth flow.
 * We therefore shell out to `claude auth login --claudeai` and let the caller
 * surface the printed sign-in URL.
 *
 * IMPORTANT two-step caveat: `claude auth login --claudeai` authenticates the
 * local CLI but does NOT by itself mint a Bearer token Strada can use. After
 * signing in, the user must run `claude setup-token` to produce the pasteable
 * `ANTHROPIC_AUTH_TOKEN`. The setup UI therefore guides BOTH steps: this sign-in
 * button plus the existing setup-token paste field.
 *
 * The spawned command is a FIXED argv array — no user input is ever interpolated
 * into a shell string, so there is no command-injection surface.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const AUTH_URL_RE = /(https?:\/\/[^\s"']+)/;
/** A login attempt is considered "in flight" for this long before we allow a new spawn. */
const LOGIN_DEDUP_MS = 5 * 60_000;

/** Resolves the platform-appropriate `claude` binary name (fixed, never user-derived). */
function claudeBin(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "claude.cmd" : "claude";
}

export interface ClaudeLoginStart {
  readonly started: boolean;
  /** Auth URL printed by `claude auth login` (best-effort) so the UI can offer a manual link. */
  readonly url?: string;
  readonly error?: string;
}

/** Returns true when the `claude` CLI is callable on this machine. */
export function isClaudeCliAvailable(
  spawnSyncFn: typeof spawnSync = spawnSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const result = spawnSyncFn(claudeBin(platform), ["--version"], {
      stdio: "ignore",
      timeout: 5000,
      shell: platform === "win32",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Platform-aware instructions for installing the Claude CLI. */
export function getClaudeInstallHint(platform: NodeJS.Platform = process.platform): string {
  const npm = "npm install -g @anthropic-ai/claude-code";
  if (platform === "darwin") {
    return `Claude CLI not found. Install it with \`brew install claude\` or \`${npm}\`, then sign in again.`;
  }
  return `Claude CLI not found. Install it with \`${npm}\`, then sign in again.`;
}

// Module-level tracker so repeated button presses do not spawn duplicate logins.
let activeLogin: { startedAtMs: number } | null = null;

interface StartClaudeLoginOptions {
  readonly spawnFn?: typeof spawn;
  readonly isAvailable?: () => boolean;
  /** How long to wait for the auth URL before resolving anyway. */
  readonly graceMs?: number;
  readonly nowMs?: number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Spawns `claude auth login --claudeai` (browser OAuth) detached and resolves once
 * the auth URL is captured or a short grace window elapses. The child keeps
 * running; after the browser login finishes the user still runs
 * `claude setup-token` to mint the token Strada pastes into setup.
 */
export function startClaudeLogin(options: StartClaudeLoginOptions = {}): Promise<ClaudeLoginStart> {
  const spawnFn = options.spawnFn ?? spawn;
  const platform = options.platform ?? process.platform;
  const isAvailable = options.isAvailable ?? (() => isClaudeCliAvailable(spawnSync, platform));
  const graceMs = options.graceMs ?? 4000;
  const nowMs = options.nowMs ?? Date.now();

  if (!isAvailable()) {
    return Promise.resolve({ started: false, error: getClaudeInstallHint(platform) });
  }

  if (activeLogin && nowMs - activeLogin.startedAtMs < LOGIN_DEDUP_MS) {
    return Promise.resolve({ started: true });
  }

  return new Promise<ClaudeLoginStart>((resolve) => {
    let child: ChildProcess;
    try {
      // FIXED argv — no shell-string interpolation of user input.
      child = spawnFn(claudeBin(platform), ["auth", "login", "--claudeai"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: platform === "win32",
      });
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
export function __resetClaudeLoginState(): void {
  activeLogin = null;
}
