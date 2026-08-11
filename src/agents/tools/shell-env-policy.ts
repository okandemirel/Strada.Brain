/**
 * Shell environment policy.
 *
 * `shell_exec` runs a command the MODEL wrote. Handing that command the full
 * parent environment hands it every credential this process holds — provider
 * API keys, channel bot tokens, embedding keys. Any indirect prompt injection
 * that reaches the agent (a repo file, a channel message, a fetched page, a
 * learned instinct) could then exfiltrate all of them with a single `env` or
 * `curl`. The blocklist in `shell-exec.ts` cannot prevent that: it constrains
 * which commands run, not what those commands can read.
 *
 * So the environment is default-DENY. Only names on the allowlist below are
 * forwarded — the set a build/test/git command actually needs to function.
 * Everything else, including every secret, is simply absent from the child.
 *
 * Escape hatch: `SHELL_EXEC_ENV_PASSTHROUGH` is a comma-separated list of
 * additional names the operator explicitly wants forwarded (e.g. a private
 * registry token a build genuinely requires). It is opt-in, per-deployment,
 * and never includes anything by default.
 */

/** POSIX basics — without these most commands cannot even resolve a binary. */
const POSIX_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TERM",
] as const;

/** Windows equivalents — cmd/powershell and .NET break without them. */
const WINDOWS_NAMES = [
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "SystemDrive",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "TEMP",
  "TMP",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

/** Toolchain vars for the .NET / Unity / node builds this agent drives. */
const TOOLCHAIN_NAMES = [
  "DOTNET_ROOT",
  "DOTNET_CLI_TELEMETRY_OPTOUT",
  "DOTNET_NOLOGO",
  "DOTNET_SKIP_FIRST_TIME_EXPERIENCE",
  "NUGET_PACKAGES",
  "MSBUILDDISABLENODEREUSE",
  "UNITY_PATH",
  "UNITY_VERSION",
  "CI",
] as const;

/**
 * Proxy settings. Included because builds behind a corporate proxy fail
 * without them.
 *
 * Caveat worth knowing: a proxy URL can embed credentials
 * (`http://user:pass@proxy`). If that is your situation, drop these from the
 * allowlist rather than leaking them — the constant is exported so a
 * deployment can assert on it.
 */
export const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/** Every exactly-matched name that may cross into the child process. */
export const SHELL_ENV_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...POSIX_NAMES,
  ...WINDOWS_NAMES,
  ...TOOLCHAIN_NAMES,
  ...PROXY_NAMES,
]);

/**
 * Prefixes that may cross. Deliberately tiny: `LC_*` is pure locale data.
 * Resist adding broad prefixes here — `NODE_*` would readmit `NODE_OPTIONS`
 * (a `--require` code-injection vector) and `GIT_*` would readmit
 * `GIT_ASKPASS` / `GIT_SSH_COMMAND` (both execute a program of the
 * attacker's choosing).
 */
export const SHELL_ENV_ALLOWED_PREFIXES: readonly string[] = ["LC_"];

/** Name of the operator escape-hatch variable. */
export const PASSTHROUGH_VAR = "SHELL_EXEC_ENV_PASSTHROUGH";

/** Parse the operator passthrough list. Unset/blank yields an empty list. */
export function parsePassthroughNames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface BuildShellEnvResult {
  /** The environment to hand the child process. */
  readonly env: Record<string, string>;
  /** Names that were present in the source but withheld. */
  readonly withheld: string[];
  /** Names forwarded solely because the operator opted in. */
  readonly viaPassthrough: string[];
}

/**
 * Build the child environment from `source` under default-deny.
 *
 * Pure: no `process.env` access, no I/O — so the policy is fully testable and
 * a caller can dry-run it against any environment shape.
 */
export function buildShellEnv(source: NodeJS.ProcessEnv): BuildShellEnvResult {
  const extra = new Set(parsePassthroughNames(source[PASSTHROUGH_VAR]));
  const env: Record<string, string> = {};
  const withheld: string[] = [];
  const viaPassthrough: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // The escape-hatch variable itself is control data, not build input.
    if (key === PASSTHROUGH_VAR) continue;

    const allowed =
      SHELL_ENV_ALLOWLIST.has(key) ||
      SHELL_ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p));

    if (allowed) {
      env[key] = value;
      continue;
    }
    if (extra.has(key)) {
      env[key] = value;
      viaPassthrough.push(key);
      continue;
    }
    withheld.push(key);
  }

  // Deterministic, uncolored output regardless of what the parent had set.
  env["FORCE_COLOR"] = "0";

  return { env, withheld, viaPassthrough };
}
