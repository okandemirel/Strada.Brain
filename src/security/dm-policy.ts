/**
 * DM Policy (approval policy for destructive or modifying operations)
 *
 * Determines whether an operation requires user confirmation. The live
 * confirmation prompt itself is delivered by the channel adapter via
 * `channel.requestConfirmation` (see orchestrator-write-gate.ts); this module
 * only decides whether approval is required and tracks per-session prefs.
 */

import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { FileDiff, BatchDiff } from "../utils/diff-generator.js";
import { lexShell, type ShellLex, type ShellWord } from "./shell-lexer.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_FILE_THRESHOLD = 3;
const DEFAULT_LINE_THRESHOLD = 50;

const DESTRUCTIVE_TOOLS = [
  "file_delete",
  "file_delete_directory",
  "file_rename",
  "file_write",
  "shell_exec",
  "git_push",
  "git_reset",
];

// ─── Types ───────────────────────────────────────────────────────────────────

export enum ApprovalLevel {
  ALWAYS = "always",
  DESTRUCTIVE_ONLY = "destructive_only",
  SMART = "smart",
  NEVER = "never",
}

export interface SessionApprovalPrefs {
  userId: string;
  level: ApprovalLevel;
  smartFileThreshold: number;
  smartLineThreshold: number;
  expiresAt?: Date;
}

export interface DMPolicyConfig {
  defaultLevel: ApprovalLevel;
  smartFileThreshold: number;
  smartLineThreshold: number;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DMPolicyConfig = {
  defaultLevel: ApprovalLevel.SMART,
  smartFileThreshold: DEFAULT_FILE_THRESHOLD,
  smartLineThreshold: DEFAULT_LINE_THRESHOLD,
};

// ─── DMPolicy Class ──────────────────────────────────────────────────────────

export class DMPolicy {
  private readonly config: DMPolicyConfig;
  private readonly sessionPrefs = new Map<string, SessionApprovalPrefs>();
  private readonly autonomousExpiry = new Map<string, number>();

  constructor(_channel: IChannelAdapter, config: Partial<DMPolicyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getPrimarySessionKey(userId: string, chatId: string): string {
    return `${userId}:${chatId}`;
  }

  private getFallbackSessionKey(userId: string, chatId: string): string | null {
    return userId === chatId ? null : `${chatId}:${chatId}`;
  }

  private resolveStoredSessionKey(userId: string, chatId: string): string {
    const primaryKey = this.getPrimarySessionKey(userId, chatId);
    if (this.sessionPrefs.has(primaryKey)) {
      return primaryKey;
    }

    const fallbackKey = this.getFallbackSessionKey(userId, chatId);
    if (fallbackKey && this.sessionPrefs.has(fallbackKey)) {
      return fallbackKey;
    }

    return primaryKey;
  }

  // ─── Session Preferences ───────────────────────────────────────────────────

  getSessionPrefs(userId: string, chatId: string): SessionApprovalPrefs {
    const primaryKey = this.getPrimarySessionKey(userId, chatId);
    const resolvedKey = this.resolveStoredSessionKey(userId, chatId);
    let prefs = this.sessionPrefs.get(resolvedKey);

    if (!prefs || this.isExpired(prefs)) {
      // Do NOT persist the synthetic default on read. Persisting it grew
      // sessionPrefs unbounded across ephemeral chats: defaults carry no
      // expiresAt, so cleanupExpiredPrefs could never reclaim them. Callers
      // (orchestrator user_confirm) only read this value; setSessionPrefs is
      // the sole writer of persisted prefs.
      return this.buildPrefs(userId, this.config.defaultLevel);
    }

    if (resolvedKey !== primaryKey) {
      // Promote the chat-scoped fallback entry to the user-specific primary key.
      // MOVE (not copy): leaving the fallback entries behind duplicated both
      // sessionPrefs and autonomousExpiry under two keys, leaking the stale pair.
      const copied = { ...prefs, userId };
      this.sessionPrefs.set(primaryKey, copied);
      this.sessionPrefs.delete(resolvedKey);
      const expiry = this.autonomousExpiry.get(resolvedKey);
      if (expiry !== undefined) {
        this.autonomousExpiry.set(primaryKey, expiry);
        this.autonomousExpiry.delete(resolvedKey);
      }
      return copied;
    }

    return prefs;
  }

  setSessionPrefs(userId: string, chatId: string, prefs: Partial<SessionApprovalPrefs>): void {
    const key = `${userId}:${chatId}`;
    const existing = this.getSessionPrefs(userId, chatId);
    this.sessionPrefs.set(key, { ...existing, ...prefs, userId });
  }

  resetSessionPrefs(userId: string, chatId: string): void {
    const key = `${userId}:${chatId}`;
    this.sessionPrefs.delete(key);
    // Also drop any tracked autonomous expiry for this key, otherwise it would
    // persist forever after the session pref is gone (unbounded leak).
    this.autonomousExpiry.delete(key);
  }

  // ─── Autonomous Profile Init ────────────────────────────────────────────────

  initFromProfile(
    chatId: string,
    preferences: { autonomousMode?: boolean; autonomousExpiresAt?: number },
    userId?: string,
  ): boolean {
    const key = `${userId ?? chatId}:${chatId}`;
    if (preferences.autonomousMode) {
      // If expiry is set and already passed, don't enable
      if (
        preferences.autonomousExpiresAt !== undefined &&
        preferences.autonomousExpiresAt <= Date.now()
      ) {
        return false;
      }

      this.sessionPrefs.set(key, this.buildPrefs(userId ?? chatId, ApprovalLevel.NEVER));

      // Track expiry if provided
      if (preferences.autonomousExpiresAt !== undefined) {
        this.autonomousExpiry.set(key, preferences.autonomousExpiresAt);
      }

      return true;
    }

    this.sessionPrefs.set(key, this.buildPrefs(userId ?? chatId, ApprovalLevel.SMART));
    this.autonomousExpiry.delete(key);
    return false;
  }

  isAutonomousActive(chatId: string, userId?: string): boolean {
    const resolvedUserId = userId ?? chatId;
    const key = this.resolveStoredSessionKey(resolvedUserId, chatId);
    const prefs = this.sessionPrefs.get(key);
    if (!prefs || prefs.level !== ApprovalLevel.NEVER) {
      return false;
    }

    const expiry = this.autonomousExpiry.get(key);
    if (expiry !== undefined && expiry <= Date.now()) {
      this.sessionPrefs.set(key, this.buildPrefs(userId ?? chatId, ApprovalLevel.SMART));
      this.autonomousExpiry.delete(key);
      return false;
    }

    return true;
  }

  // ─── Approval Logic ────────────────────────────────────────────────────────

  isApprovalRequired(
    prefs: SessionApprovalPrefs,
    diff: FileDiff | BatchDiff,
    isDestructive: boolean,
  ): boolean {
    switch (prefs.level) {
      case ApprovalLevel.NEVER:
        return false;
      case ApprovalLevel.ALWAYS:
        return true;
      case ApprovalLevel.DESTRUCTIVE_ONLY:
        return isDestructive;
      case ApprovalLevel.SMART:
        return isDestructive || this.exceedsThreshold(prefs, diff);
    }
  }

  private exceedsThreshold(prefs: SessionApprovalPrefs, diff: FileDiff | BatchDiff): boolean {
    if ("files" in diff) {
      return (
        diff.files.length >= prefs.smartFileThreshold ||
        diff.totalStats.totalChanges >= prefs.smartLineThreshold
      );
    }
    return diff.stats.totalChanges >= prefs.smartLineThreshold;
  }

  cleanupExpiredPrefs(): void {
    const now = new Date();
    for (const [key, prefs] of this.sessionPrefs.entries()) {
      if (prefs.expiresAt && prefs.expiresAt < now) {
        this.sessionPrefs.delete(key);
        // Keep autonomousExpiry in lockstep with sessionPrefs so it can't leak.
        this.autonomousExpiry.delete(key);
      }
    }
    // Reclaim any orphaned expiry whose session pref is already gone.
    for (const key of this.autonomousExpiry.keys()) {
      if (!this.sessionPrefs.has(key)) {
        this.autonomousExpiry.delete(key);
      }
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /** Build a SessionApprovalPrefs with config defaults for the given level. */
  private buildPrefs(userId: string, level: ApprovalLevel): SessionApprovalPrefs {
    return {
      userId,
      level,
      smartFileThreshold: this.config.smartFileThreshold,
      smartLineThreshold: this.config.smartLineThreshold,
    };
  }


  private isExpired(prefs: SessionApprovalPrefs): boolean {
    return prefs.expiresAt !== undefined && prefs.expiresAt < new Date();
  }
}

// ─── Factory & Utilities ─────────────────────────────────────────────────────

export function createDMPolicy(
  channel: IChannelAdapter,
  config?: Partial<DMPolicyConfig>,
): DMPolicy {
  return new DMPolicy(channel, config);
}

/**
 * Why a shell command was flagged.
 *
 * "action" — the command NAMES a destructive act: rm, dd, mkfs, a redirect
 * into /etc or a raw device, a pipe into a shell. Nothing autonomous may run
 * one of these.
 *
 * "shape" — the command merely has a shape that COULD carry one: a subshell,
 * a backtick, a one-liner passed to an interpreter. These appear in ordinary
 * measurement work, and refusing them on their shape alone cost a sprint its
 * turn for `ls … && file … && python3 -c <read the image's size>` (measured
 * live 2026-09-12 05:03). They are still reviewed — just not refused unread.
 */
export type DestructiveShellFlag = "action" | "shape" | null;

/**
 * Programs that name a destructive act whatever their arguments. `rmdir`,
 * `find`, `git`, `chmod`, the shells and the interpreters depend on theirs and
 * are judged in flagProgram.
 */
const DESTRUCTIVE_PROGRAMS = new Set([
  "rm", "unlink", "shred", "truncate", "dd", "del", "erase", "format", "remove-item",
  "shutdown", "reboot", "halt", "poweroff",
]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd"]);
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const INTERPRETER_RE = /^(?:python[\d.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
/** A flag that puts the interpreter's program on the command line. */
const ONE_LINER_RE = /^(?:-[A-Za-z]*[ceE]|--eval(?:=.*)?|--print|-p|-r)$/;
/** cmd.exe builtins it reads with switches attached: `rmdir/s/q`. */
const CMD_SWITCHED = new Set(["rmdir", "rd", "del", "erase", "format"]);
const ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;
/** Reserved words that precede a command without changing which program runs. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);

/** Words that only set up the program after them, with the options that take a separate value. */
interface WrapperSpec {
  readonly short: string;
  readonly long: readonly string[];
}
// A Map, so a program named like an Object.prototype key is not a wrapper.
const WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map<string, WrapperSpec>([
  ["sudo", { short: "ugCDprtUT", long: ["--user", "--group", "--chdir", "--prompt", "--role", "--type", "--other-user", "--close-from"] }],
  ["doas", { short: "uC", long: [] }],
  ["env", { short: "uCS", long: ["--unset", "--chdir", "--split-string"] }],
  ["nice", { short: "n", long: ["--adjustment"] }],
  ["ionice", { short: "cnpPu", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"] }],
  ["timeout", { short: "sk", long: ["--signal", "--kill-after"] }],
  ["xargs", { short: "IELnPsda", long: ["--replace", "--eof", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file"] }],
  ["stdbuf", { short: "ioe", long: ["--input", "--output", "--error"] }],
  ["time", { short: "fo", long: ["--format", "--output"] }],
  ["exec", { short: "a", long: [] }],
  ["nohup", { short: "", long: [] }],
  ["command", { short: "", long: [] }],
  ["builtin", { short: "", long: [] }],
  ["busybox", { short: "", long: [] }],
]);

/** The program a wrapper runs, and any command line it re-splits (`env -S`). */
function unwrap(
  name: string,
  spec: WrapperSpec,
  words: readonly ShellWord[],
): { program: readonly ShellWord[]; split: string[] } {
  const split: string[] = [];
  let durationPending = name === "timeout";
  let k = 0;
  while (k < words.length) {
    const w = words[k]?.value ?? "";
    const next = words[k + 1]?.value ?? "";
    if (w === "--") {
      k += 1;
      break;
    }
    if (name === "env" && ASSIGNMENT_RE.test(w)) {
      k += 1;
    } else if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const opt = eq < 0 ? w : w.slice(0, eq);
      const takesNext = eq < 0 && spec.long.includes(opt);
      if (opt === "--split-string") split.push(takesNext ? next : w.slice(eq + 1));
      k += takesNext ? 2 : 1;
    } else if (w.startsWith("-") && w.length > 1) {
      // A value-taking short option takes the rest of its cluster, or the next word.
      const at = [...w.slice(1)].findIndex((ch) => spec.short.includes(ch));
      const attached = at < 0 ? "" : w.slice(at + 2);
      if (name === "env" && at >= 0 && w[at + 1] === "S") split.push(attached || next);
      k += at >= 0 && !attached ? 2 : 1;
    } else if (durationPending) {
      durationPending = false;
      k += 1;
    } else {
      break;
    }
  }
  return { program: words.slice(k), split };
}

/** Lower-cased program names a word can run as: bash's reading and cmd.exe's. */
function programNames(word: ShellWord): string[] {
  const views = [word.value, word.raw.replace(/["^]/g, "")];
  return [...new Set(views.map((v) => (v.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "")))];
}

function gitFlag(args: readonly string[]): DestructiveShellFlag {
  // Global options before the subcommand; -C/-c take a value.
  let k = 0;
  while (k < args.length && (args[k] ?? "").startsWith("-")) {
    k += /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[k] ?? "") ? 2 : 1;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  const has = (re: RegExp): boolean => rest.some((a) => re.test(a));
  switch (sub) {
    case "clean":
      return has(/^(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)$/) ? null : "action";
    case "reset":
      return has(/^--hard$/) ? "action" : null;
    case "checkout":
      // `-- <paths>`, `.` and a forced switch throw away uncommitted work.
      return has(/^(?:--|\.|-[A-Za-z]*f[A-Za-z]*|--force)$/) ? "action" : null;
    case "restore":
      return has(/^(?:--staged|-S)$/) && !has(/^(?:--worktree|-W)$/) ? null : "action";
    case "rm":
      return has(/^--cached$/) ? null : "action";
    case "branch":
      return has(/^-[A-Za-z]*D[A-Za-z]*$/) || (has(/^(?:-d|--delete)$/) && has(/^(?:-f|--force)$/)) ? "action" : null;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? "action" : null;
    default:
      return null;
  }
}

function flagProgram(
  name: string,
  args: readonly string[],
  piped: boolean,
  cmd: boolean,
  depth: number,
): DestructiveShellFlag {
  const lower = args.map((a) => a.toLowerCase());
  if (DESTRUCTIVE_PROGRAMS.has(name) || name.startsWith("mkfs")) return "action";
  // `rmdir` IS NOT `rm -rf`, AND OUR OWN GATES DEMAND IT. POSIX rmdir removes
  // only EMPTY directories and fails with ENOTEMPTY otherwise — it is the
  // counterpart of mkdir and cannot destroy data. Refusing it outright meant
  // the conformance gate could tell a worker "move this code under
  // Assets/Modules/<Name>Module/" and this gate would then forbid removing the
  // empty directory it had just left behind: measured live 2026-09-18, 14
  // refusals of `rmdir Assets/PixelFlow/Core/Sim/Data …` in ten minutes.
  // What stays refused: a RECURSIVE rmdir, which on Windows (`rmdir /s`, or
  // PowerShell's `-Recurse`) really is rm -rf.
  if (name === "rmdir" || name === "rd") {
    return lower.some((a) => /^(?:-r[a-z]*|--recursive|(?:\/[a-z?]+)*\/s(?:\/[a-z?]+)*)$/.test(a)) ? "action" : null;
  }
  // `find … -delete` / `-exec rm` is a recursive delete spelled differently.
  if (name === "find") return lower.some((a) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(a)) ? "action" : null;
  if (name === "chmod") return lower.some((a) => /^[0-7]?777$/.test(a)) ? "action" : null;
  if (name === "git") return gitFlag(args);
  if (name === "eval") return "shape";
  if (SHELL_PROGRAMS.has(name)) {
    // A pipe into a shell runs whatever the pipe carries.
    if (piped) return "action";
    if ((name === "pwsh" || name === "powershell") && lower.some((a) => /^-(?:e|ec|en|enc\w*)$/.test(a))) return "action";
    // `-c` / `/c` / `-Command`: the body is a command line of its own, read like this one.
    const at = lower.findIndex((a) => /^(?:-[a-z]*c|\/[ck]|-com\w*)$/.test(a));
    if (at < 0) return null;
    const body = POSIX_SHELLS.has(name) ? (args[at + 1] ?? "") : args.slice(at + 1).join(" ");
    return flagText(body, cmd, depth + 1);
  }
  if (INTERPRETER_RE.test(name)) {
    // With no program argument the interpreter runs what the pipe carries.
    if (piped && args.every((a) => a === "-")) return "action";
    return args.some((a) => ONE_LINER_RE.test(a)) ? "shape" : null;
  }
  return null;
}

function worse(...flags: DestructiveShellFlag[]): DestructiveShellFlag {
  if (flags.includes("action")) return "action";
  return flags.includes("shape") ? "shape" : null;
}

/** One simple command: the program it runs, seen through assignments and wrappers. */
function flagWords(words: readonly ShellWord[], piped: boolean, cmd: boolean, depth: number): DestructiveShellFlag {
  let k = 0;
  while (k < words.length && (ASSIGNMENT_RE.test(words[k]?.value ?? "") || KEYWORDS.has(words[k]?.value ?? ""))) k += 1;
  const head = words[k];
  if (!head) return null;
  // A program named by an expansion is not one this can read.
  if (head.expands.length > 0 || (cmd && /%[^%\s]+%/.test(head.raw))) return "shape";
  const rest = words.slice(k + 1);
  const values = rest.map((w) => w.value);
  const candidates = programNames(head).map((name) => ({ name, args: values }));
  // cmd.exe reads `rmdir/s/q` as `rmdir /s /q`.
  const attached = /^([a-z]+)((?:\/[^/\\]*)+)$/i.exec(head.value);
  const verb = (attached?.[1] ?? "").toLowerCase();
  if (attached && CMD_SWITCHED.has(verb)) {
    const switches = (attached[2] ?? "").split("/").filter(Boolean).map((s) => `/${s}`);
    candidates.push({ name: verb, args: [...switches, ...values] });
  }
  let flag: DestructiveShellFlag = null;
  for (const { name, args } of candidates) {
    const wrapper = WRAPPERS.get(name);
    if (wrapper) {
      const { program, split } = unwrap(name, wrapper, rest);
      flag = worse(flag, flagWords(program, piped, cmd, depth), ...split.map((s) => flagText(s, cmd, depth + 1)));
    } else {
      flag = worse(flag, flagProgram(name, args, piped, cmd, depth));
    }
  }
  return flag;
}

/** A redirection target outside the work: system directories, raw devices, home, a parent. */
function protectedTarget(target: string): boolean {
  const t = target.toLowerCase();
  // /dev is split: writing to /dev/sda is destructive, writing to /dev/null is
  // how every shell script discards output.
  return /^\/etc\//.test(t)
    || /^\/(?:proc|sys|boot|root|var|home)\//.test(t)
    || /^\/dev\/(?!(?:null|stdout|stderr)$)/.test(t)
    || /^~\//.test(t)
    || /^\.\.[\\/]/.test(t);
}

function flagLex(read: ShellLex, cmd: boolean, depth: number): DestructiveShellFlag {
  if (read.redirectTargets.some(protectedTarget)) return "action";
  // A substitution runs a command whose OUTPUT becomes part of this one; and
  // when cmd.exe would split the line differently, the words read here are
  // not the ones it runs.
  let flag: DestructiveShellFlag =
    read.hazards.has("substitution") || (cmd && read.hazards.has("cmd-quoting")) ? "shape" : null;
  read.commands.forEach((words, k) => {
    const piped = k > 0 && (read.operators[k - 1] === "|" || read.operators[k - 1] === "|&");
    flag = worse(flag, flagWords(words, piped, cmd, depth));
  });
  for (const inner of read.nested) flag = worse(flag, flagLex(inner, cmd, depth));
  return flag;
}

function flagText(command: string, cmd: boolean, depth: number): DestructiveShellFlag {
  // Shells inside shells this deep are not ordinary work: leave them to the reviewer.
  if (depth > 4) return "shape";
  return flagLex(lexShell(command, { cmd }), cmd, depth);
}

/**
 * Which kind of flag this shell command raises, if any.
 *
 * This used to match substrings ("rm ", "dd ", "del ", "format"): a tab or a
 * newline after `rm` walked past it, while `git add .`, `dotnet add package`
 * and `git log --format=…` were refused as destructive. It now reads the line
 * with the shared shell lexer and judges the program at every command
 * position — after list and pipe operators, inside substitutions, behind
 * env/sudo/xargs-style wrappers and inside `sh -c` / `cmd /c` bodies.
 * `platform` adds cmd.exe's reading (shell_exec runs cmd.exe on Windows).
 */
export function destructiveShellFlag(
  rawCommand: string,
  platform: NodeJS.Platform = process.platform,
): DestructiveShellFlag {
  return flagText(rawCommand, platform === "win32", 0);
}

export function isDestructiveOperation(toolName: string, input: Record<string, unknown>): boolean {
  const baseName = toolName.includes(":") ? toolName.split(":").pop()! : toolName;
  if (!DESTRUCTIVE_TOOLS.includes(baseName)) return false;

  if (toolName === "shell_exec") {
    return destructiveShellFlag(String(input["command"] || "")) !== null;
  }

  return true;
}
