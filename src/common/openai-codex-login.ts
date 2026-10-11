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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const CODEX_BIN = "codex";

/**
 * The platform's `codex` launcher (fixed, never user-derived). The npm install
 * the hint below recommends puts `codex.cmd` on Windows, which a shell-less
 * spawn never finds (it only tries .com/.exe), and Node refuses to run a .cmd
 * without a shell (CVE-2024-27980), so Windows gets both, as claudeBin does.
 * Every argv here is a fixed literal, so the shell sees no user input.
 */
function codexBin(platform: NodeJS.Platform): string {
  return platform === "win32" ? "codex.cmd" : CODEX_BIN;
}
/** A URL that whitespace or a quote has ended, so a chunk boundary cannot cut it short. */
const ENDED_URL_RE = /https?:\/\/[^\s"'<>]+(?=[\s"'<>])/g;
/** What codex prints before the sign-in URL is a few lines; this only bounds a runaway stream. */
const MAX_LOGIN_OUTPUT_CHARS = 16_384;
/** A login attempt is considered "in flight" for this long before we allow a new spawn. */
const LOGIN_DEDUP_MS = 5 * 60_000;

/**
 * Pinned fallback Codex CLI version used to build the `codex_cli_rs/<version>`
 * User-Agent when the installed binary cannot be located/read. Codex gates the
 * consumer subscription token on a codex-shaped client identity; a plausible
 * version keeps the request indistinguishable from a real codex call. Bump this
 * when the codex wire protocol moves on (it is undocumented and brittle).
 */
export const CODEX_CLI_FALLBACK_VERSION = "0.132.0";

/** Memoized so we never spawn/stat per request — resolved at most once per process. */
let cachedCodexCliVersion: string | undefined;

/**
 * Best-effort resolution of the installed Codex CLI version, used only to build a
 * non-secret `codex_cli_rs/<version>` User-Agent. Locates the `codex` binary on
 * PATH (fixed-argv `which`/`where`, no shell interpolation), follows the symlink
 * to the real `@openai/codex` install, and reads the `version` from the nearest
 * `package.json`. Falls back to {@link CODEX_CLI_FALLBACK_VERSION} when anything
 * is unavailable. The result is memoized so callers may invoke it per request
 * cheaply; pass `force` only in tests to bypass the cache.
 */
export function resolveCodexCliVersion(
  spawnSyncFn: typeof spawnSync = spawnSync,
  force = false,
): string {
  if (cachedCodexCliVersion !== undefined && !force) {
    return cachedCodexCliVersion;
  }
  cachedCodexCliVersion = readCodexPackageVersion(spawnSyncFn) ?? CODEX_CLI_FALLBACK_VERSION;
  return cachedCodexCliVersion;
}

function readCodexPackageVersion(spawnSyncFn: typeof spawnSync): string | undefined {
  try {
    // Resolve the binary's location on PATH with a fixed argv (no shell string).
    const locator = process.platform === "win32" ? "where" : "which";
    const located = spawnSyncFn(locator, [CODEX_BIN], { encoding: "utf8", timeout: 5000 });
    if (located.status !== 0 || typeof located.stdout !== "string") {
      return undefined;
    }
    const binPath = located.stdout.split(/\r?\n/)[0]?.trim();
    if (!binPath) {
      return undefined;
    }
    // Follow any symlink (e.g. a Homebrew shim) to the real installed file, then
    // walk up looking for the package.json that owns it. A missing/inaccessible
    // path makes realpathSync throw and the surrounding try/catch returns undefined.
    let dir = dirname(realpathSync(binPath));
    for (let depth = 0; depth < 6; depth++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version) {
          return parsed.version;
        }
        return undefined;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Test-only: clears the memoized Codex CLI version. */
export function __resetCodexCliVersionCache(): void {
  cachedCodexCliVersion = undefined;
}

export interface CodexLoginStart {
  readonly started: boolean;
  /** Auth URL printed by `codex login` (best-effort) so the UI can offer a manual link. */
  readonly url?: string;
  readonly error?: string;
}

/** Returns true when the `codex` CLI is callable on this machine. */
export function isCodexCliAvailable(
  spawnSyncFn: typeof spawnSync = spawnSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const result = spawnSyncFn(codexBin(platform), ["--version"], {
      stdio: "ignore",
      timeout: 5000,
      shell: platform === "win32",
    });
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

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
}

/**
 * The sign-in page in what `codex login` has printed so far.
 *
 * Codex prints its own callback server first ("Starting local login server on
 * http://localhost:1455.") and the OpenAI page after it, so the first URL is
 * the one that cannot sign anyone in. A loopback host is skipped (the real
 * page's redirect_uri names localhost too, but only inside its query), and a
 * sentence's closing period is not part of the URL.
 */
function findSignInUrl(output: string): string | undefined {
  for (const match of output.matchAll(ENDED_URL_RE)) {
    const candidate = match[0].replace(/[.,;:!?)\]]+$/, "");
    try {
      if (!isLoopbackHost(new URL(candidate).hostname)) return candidate;
    } catch {
      // not a URL after all
    }
  }
  return undefined;
}

// Module-level tracker so repeated button presses do not spawn duplicate logins.
let activeLogin: { startedAtMs: number } | null = null;

interface StartCodexLoginOptions {
  readonly spawnFn?: typeof spawn;
  readonly isAvailable?: () => boolean;
  /** How long to wait for the auth URL before resolving anyway. */
  readonly graceMs?: number;
  readonly nowMs?: number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Spawns `codex login` (browser OAuth) detached and resolves once the auth URL is
 * captured or a short grace window elapses. The child keeps running; callers
 * should poll {@link inspectOpenAiSubscriptionAuth} until the token is written.
 */
export function startCodexLogin(options: StartCodexLoginOptions = {}): Promise<CodexLoginStart> {
  const spawnFn = options.spawnFn ?? spawn;
  const platform = options.platform ?? process.platform;
  const isAvailable = options.isAvailable ?? (() => isCodexCliAvailable(spawnSync, platform));
  const graceMs = options.graceMs ?? 4000;
  const nowMs = options.nowMs ?? Date.now();

  if (!isAvailable()) {
    return Promise.resolve({ started: false, error: getCodexInstallHint(platform) });
  }

  if (activeLogin && nowMs - activeLogin.startedAtMs < LOGIN_DEDUP_MS) {
    return Promise.resolve({ started: true });
  }

  return new Promise<CodexLoginStart>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(codexBin(platform), ["login"], {
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
    let output = "";
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

    // Rust writes the message in pieces, so one chunk can hold half a URL:
    // read the output so far, not the chunk.
    const onData = (buf: Buffer): void => {
      if (url || output.length >= MAX_LOGIN_OUTPUT_CHARS) return;
      output = (output + buf.toString("utf8")).slice(0, MAX_LOGIN_OUTPUT_CHARS);
      url = findSignInUrl(output);
      if (url) finish();
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
    child.on("exit", (code: number | null) => {
      activeLogin = null;
      url ??= findSignInUrl(`${output}\n`);
      // A login that failed before it showed a page (port 1455 taken, say) is
      // not one in progress: the wizard would poll for a token that never comes.
      if (!settled && !url && code !== null && code !== 0) {
        settled = true;
        if (timer) clearTimeout(timer);
        const said = output.trim();
        resolve({ started: false, error: said ? said.slice(-500) : `codex login exited with code ${code}` });
        return;
      }
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
