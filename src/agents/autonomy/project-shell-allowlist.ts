/**
 * Deterministic project-scoped shell allowlist — consulted BEFORE the LLM shell
 * reviewer.
 *
 * Measured 2026-08-23 (PixelFlow run): the conformance gate demanded
 * "GAME NEVER RUN — run the game", the agent answered with exactly the right
 * command (Unity -batchmode -runTests against its own project), and the LLM
 * shell reviewer rejected it twice — once "inconclusive", once "looks
 * destructive". Gate and gatekeeper deadlocked: the one command that satisfies
 * delivery verification was unrunnable, so no autonomous run could ever pass.
 *
 * These patterns are bounded by construction: they target the CURRENT project,
 * they build/test/inspect rather than delete, and their flags are whitelisted.
 * Anything not matched here falls through to the LLM reviewer unchanged.
 *
 * A match overrides a reviewer rejection (review.ts), so it must be earned by
 * the WHOLE line: the rules used to match one segment of a chained command and
 * approve all of it. Every rule now sees the command as the shared shell lexer
 * reads it — one invocation, or a `|` pipeline whose every stage is checked —
 * and a line with anything else in it (another list operator, a newline, a
 * substitution, a redirection, an expansion other than $PWD) is not matched.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { destructiveShellFlag } from "../../security/dm-policy.js";
import { plainCommands, type ShellWord } from "../../security/shell-lexer.js";

export interface ProjectShellAllowlistMatch {
  /** Human-readable rule that approved the command. */
  readonly rule: string;
}

/** One program invocation: its words as the shell will pass them. */
type Invocation = readonly ShellWord[];

interface Scope {
  readonly root: string;
  /** Path semantics of the root: a drive-letter or UNC root reads as Windows on any host. */
  readonly paths: path.PlatformPath;
}

interface AllowlistRule {
  name: string;
  /** The pipeline stages of the command; single-invocation rules require exactly one. */
  matches(stages: readonly Invocation[], scope: Scope): boolean;
}

function pathsFor(root: string): path.PlatformPath {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
}

/** True when `candidate`, resolved against the root, stays inside it. */
function inside(candidate: string, scope: Scope): boolean {
  const { paths, root } = scope;
  const rel = paths.relative(root, paths.resolve(root, candidate));
  return rel === "" || (!paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${paths.sep}`));
}

/** The pieces of a word that can name a path: `--out=x`, `-p:x`, `a,b`; a drive colon stays whole. */
function pathPieces(text: string): string[] {
  return text.split(/[=,;]/).flatMap((part) => part.match(/[A-Za-z]:[^:]*|[^:]+/g) ?? []);
}

/** A word as cmd.exe passes it: `^` escapes the next character, quotes are dropped, `\` is literal. */
function cmdView(word: ShellWord): string {
  return word.raw.replace(/\^(.)/g, "$1").replace(/"/g, "");
}

/**
 * An argument that reads or writes only inside the project. It is checked as
 * bash passes it and as cmd.exe would (no backslash escapes there), with
 * $PWD read as the root.
 */
function boundedWord(word: ShellWord, scope: Scope): boolean {
  // Only $PWD may expand: `cat $HOME/.aws/credentials` reads outside the project.
  if (word.expands.some((name) => name !== "PWD")) return false;
  // A glob that can begin with `-` can expand to an option (a file named
  // `-delete`), and a `.`-led glob component can match `..`.
  if (word.glob && (/^[-*?[]/.test(word.value) || /(?:^|[\\/])\.[^\\/]*[*?[]/.test(word.value))) return false;
  const pwd = (text: string) => text.replace(/\$\{PWD\}|\$PWD(?!\w)/g, scope.root);
  const views = [word.value, cmdView(word)];
  return views.every((view) => pathPieces(pwd(view)).every((piece) => inside(piece, scope)));
}

interface OptionSpec {
  /** Short flags that take no value. */
  readonly flags: string;
  /** Short flags that take a value: the rest of the cluster, or the next word. */
  readonly valued: string;
  /** Long options refused, under any abbreviation GNU getopt accepts. */
  readonly deniedLong: readonly string[];
  readonly maxOperands?: number;
}

/** GNU-style options checked against a whitelist of short flags. */
function optionsAllowed(args: readonly string[], spec: OptionSpec): boolean {
  let operands = 0;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] ?? "";
    if (arg === "--") {
      operands += args.length - k - 1;
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0] ?? "";
      if (spec.deniedLong.some((denied) => denied.startsWith(name))) return false;
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j += 1) {
        const flag = arg[j] ?? "";
        if (spec.valued.includes(flag)) {
          if (j === arg.length - 1) k += 1;
          break;
        }
        if (!spec.flags.includes(flag)) return false;
      }
    } else {
      operands += 1;
    }
  }
  return spec.maxOperands === undefined || operands <= spec.maxOperands;
}

/** awk that only prints: no system()/getline, no pipe or redirection in the program, no program file. */
function awkOnlyPrints(args: readonly string[]): boolean {
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] ?? "";
    if (arg === "-F" || arg === "-v") k += 1;
    else if (/^-[Fv]./.test(arg)) continue;
    else if (arg.startsWith("-")) return false;
    else return !/system|getline|ENVIRON|PROCINFO|[|>@]/.test(arg);
  }
  return false;
}

type ArgCheck = (args: readonly string[]) => boolean;
const anyArgs: ArgCheck = () => true;

/**
 * Read-only programs, each with the check that keeps it read-only. `env` and
 * `printenv` are not here (env runs its argument, printenv prints secrets),
 * nor `tree` (-o, -R -H write files) or `date` (-s sets the clock).
 */
const READ_ONLY: ReadonlyMap<string, ArgCheck> = new Map(Object.entries({
  ls: anyArgs, cat: anyArgs, head: anyArgs, tail: anyArgs, grep: anyArgs, egrep: anyArgs, fgrep: anyArgs,
  wc: anyArgs, cut: anyArgs, tr: anyArgs, basename: anyArgs, dirname: anyArgs, realpath: anyArgs, pwd: anyArgs,
  echo: anyArgs, printf: anyArgs, stat: anyArgs, du: anyArgs, df: anyArgs, diff: anyArgs, cmp: anyArgs,
  md5: anyArgs, md5sum: anyArgs, shasum: anyArgs, sha1sum: anyArgs, sha256sum: anyArgs, which: anyArgs,
  true: anyArgs, test: anyArgs,
  // `file -C` compiles a magic file and writes it out.
  file: (args) => !args.some((a) => /^--c/.test(a) || /^-[A-Za-z]*C/.test(a)),
  // `rg --pre` / `--hostname-bin` run a program of the caller's choosing.
  rg: (args) => !args.some((a) => /^--(?:pre|hostname-bin)(?:=|$)/.test(a)),
  // find's action family deletes, runs programs or writes files.
  find: (args) => !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)),
  // `sort -o` writes a file and `--compress-program` runs one.
  sort: (args) => optionsAllowed(args, {
    flags: "bcCdfghiMmnRrsuVz", valued: "ktS", deniedLong: ["output", "compress-program", "temporary-directory"],
  }),
  // uniq's second operand is an OUTPUT file.
  uniq: (args) => optionsAllowed(args, { flags: "cdDiuz", valued: "fsw", deniedLong: [], maxOperands: 1 }),
  awk: awkOnlyPrints,
} satisfies Record<string, ArgCheck>));

const INSPECT_VERBS = new Set(["md5", "md5sum", "shasum", "sha1sum", "sha256sum", "file", "stat", "wc"]);

function argValues(stage: Invocation): string[] {
  return stage.slice(1).map((w) => w.value);
}

function readOnlyStage(stage: Invocation): boolean {
  // A Map lookup: a program named like an Object.prototype key is not a verb here.
  const check = READ_ONLY.get(stage[0]?.value ?? "");
  return check !== undefined && check(argValues(stage));
}

const UNITY_MAC = /^\/Applications\/Unity\/\S*\/Unity\.app\/Contents\/MacOS\/Unity$/;
/** Unity Hub's Linux layout (~/Unity/Hub/Editor/<version>/Editor/Unity) and the CI images' /opt/unity. */
const UNITY_LINUX = /^(?:\/home\/[^/\s]+|\/root)\/Unity\/Hub\/Editor\/[^/\s]+\/Editor\/Unity$|^\/opt\/unity\/Editor\/Unity$/;
/** Unity Hub's Windows layout: <drive>:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe. */
const UNITY_WINDOWS = /^[A-Za-z]:\\Program Files\\Unity\\Hub\\Editor\\[^\\]+\\Editor\\Unity\.exe$/i;

/**
 * Is this the Unity editor binary, at an install location, for the project's
 * platform? Only the macOS path was known, so on Windows and Linux the rule
 * never matched and the GAME NEVER RUN deadlock this file exists to break came
 * back (audited 2026-09-25). A path that normalizes to something else (`..`)
 * is not an install location.
 */
function isUnityEditor(program: string, scope: Scope): boolean {
  if (scope.paths === path.win32) {
    return UNITY_WINDOWS.test(program) && path.win32.normalize(program) === program;
  }
  return (UNITY_MAC.test(program) || UNITY_LINUX.test(program)) && path.posix.normalize(program) === program;
}

/** dotnet build/test options that take a value; anything outside these and the switches goes to the reviewer. */
const DOTNET_VALUED = new Set(["-c", "--configuration", "-f", "--framework", "-v", "--verbosity", "-r", "--runtime", "-a", "--arch", "--os"]);
const DOTNET_SWITCHES = /^(?:--?nologo|--no-restore|--no-build|--no-incremental|--no-dependencies|--?tl(?::(?:on|off|auto))?)$/i;

/**
 * dotnet flags from a whitelist. MSBuild's own switches are not on it:
 * `-p:PreBuildEvent=…` runs a command, `-logger:`/`-distributedLogger:` load
 * an assembly, `-fl`/`-bl` write log files, and `@file` reads more switches.
 */
function dotnetArgsAllowed(verb: string, args: readonly string[]): boolean {
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] ?? "";
    if (arg.startsWith("@") || /^\/[A-Za-z]+(?::|$)/.test(arg)) return false;
    if (!arg.startsWith("-") || DOTNET_SWITCHES.test(arg)) continue;
    const option = /^(--?[A-Za-z-]+)(?:[=:](.*))?$/.exec(arg);
    const name = option?.[1]?.toLowerCase() ?? "";
    const testOnly = name === "--filter" || name === "--logger";
    if (!DOTNET_VALUED.has(name) && !(testOnly && verb === "test")) return false;
    if (option?.[2] === undefined) k += 1;
  }
  return true;
}

const GIT_READ_VERBS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"]);
/** A branch/ref name: not an option, not `.`/`..`, no path traversal. */
const GIT_REF = /^(?![-./])(?!.*\.\.)(?!.*[./]$)(?!.*\.lock$)[\w./-]+$/;
const GIT_BRANCH_LIST_FLAG =
  /^(?:--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|-i|--ignore-case|--no-color|--color(?:=\w+)?|--no-column|--column(?:=[\w,]+)?|--sort=.+|--format=.*|--(?:no-)?(?:contains|merged)(?:=.+)?|--points-at(?:=.+)?)$/;

/** `git branch` that only lists: a bare name would create a branch, -d/-D/-m/-f change them. */
function gitBranchLists(args: readonly string[]): boolean {
  let listing = false;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] ?? "";
    if (!arg.startsWith("-")) {
      if (!listing) return false;
      continue;
    }
    if (!GIT_BRANCH_LIST_FLAG.test(arg)) return false;
    if (/^--(?:list|(?:no-)?(?:contains|merged)|points-at)/.test(arg)) listing = true;
    if (/^--(?:(?:no-)?(?:contains|merged)|points-at)$/.test(arg)) k += 1;
  }
  return true;
}

/** `git merge` of one branch, with only the flags that choose how the merge commit is made. */
function gitMergeIntegrates(args: readonly string[]): boolean {
  let refs = 0;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] ?? "";
    if (arg === "-m") k += 1;
    else if (/^(?:--no-ff|--ff-only|--no-edit|-m.+|--message=.*)$/.test(arg)) continue;
    else if (GIT_REF.test(arg)) refs += 1;
    else return false;
  }
  return refs === 1;
}

/**
 * `git checkout <branch>`. With a PATH instead of a branch, checkout throws
 * away that path's uncommitted work, so a name that exists in the project is
 * left to the reviewer.
 */
function gitCheckoutSwitches(args: readonly string[], scope: Scope): boolean {
  const ref = args[0];
  if (args.length !== 1 || ref === undefined || !GIT_REF.test(ref)) return false;
  return !existsSync(scope.paths.resolve(scope.root, ref));
}

const RULES: readonly AllowlistRule[] = [
  {
    name: "unity-batchmode (build/test/run the current project headlessly)",
    matches(stages, scope) {
      // Audited 2026-09-02: this rule tested four unanchored substrings and
      // returned true, so it pre-approved the WHOLE line. It approves ONE
      // Unity invocation whose every path stays inside the project.
      const [stage] = stages;
      if (stages.length !== 1 || !stage || stage.length === 0) return false;
      // Under a Windows root cmd.exe runs the line, and it reads `\` literally.
      const [program, ...flags] = stage.map((word) => (scope.paths === path.win32 ? cmdView(word) : word.value));
      if (program === undefined || !isUnityEditor(program, scope)) return false;
      if (!flags.includes("-batchmode")) return false;
      // One of the three bounded purposes: open-and-quit, run tests, run a method.
      if (!flags.some((f) => f === "-quit" || f === "-runTests" || f === "-executeMethod")) return false;
      // The project it touches must be THIS project.
      const at = flags.indexOf("-projectPath");
      const project = at < 0 ? undefined : flags[at + 1];
      if (project === undefined) return false;
      if (project === "$PWD" || project === "${PWD}") return true;
      return scope.paths.isAbsolute(project) && scope.paths.relative(scope.root, project) === "";
    },
  },
  {
    name: "dotnet build/test inside the project",
    matches(stages) {
      const stage = stages[0];
      const verb = stage?.[1]?.value ?? "";
      if (stages.length !== 1 || !stage || stage[0]?.value !== "dotnet") return false;
      if (verb !== "build" && verb !== "test" && verb !== "vstest") return false;
      return dotnetArgsAllowed(verb, argValues(stage).slice(1));
    },
  },
  {
    name: "read-only file inspection (hash/stat/file/wc)",
    matches(stages) {
      // Hashing/inspecting outside the project could probe secrets — the
      // arguments were bounded to the project before any rule ran.
      const stage = stages[0];
      return stages.length === 1 && !!stage && INSPECT_VERBS.has(stage[0]?.value ?? "") && readOnlyStage(stage);
    },
  },
  {
    // Measured 2026-09-08 00:25: `ls Assets/Art/Generated/ | grep -i super`
    // went to the LLM reviewer, which was "inconclusive" twice, and a sprint
    // collecting sprite guids lost two turns to a listing. A pipeline whose
    // every stage is a read-only inspection command cannot change anything.
    name: "read-only inspection pipeline (ls/cat/grep/head/tail/find/wc/sort…)",
    matches(stages) {
      return stages.length > 0 && stages.every(readOnlyStage);
    },
  },
  {
    name: "git inspection + in-project integration (merge/checkout, no force, no push)",
    matches(stages, scope) {
      const stage = stages[0];
      if (stages.length !== 1 || !stage || stage[0]?.value !== "git") return false;
      // The subcommand comes first: global options (`-c core.pager=…`,
      // `--exec-path`) can run programs of the caller's choosing.
      const [verb, ...args] = argValues(stage);
      if (verb === undefined) return false;
      if (GIT_READ_VERBS.has(verb)) return !args.some((a) => /^--(?:ou(?!rs$)|ext-diff)/.test(a));
      if (verb === "branch") return gitBranchLists(args);
      if (verb === "merge") return gitMergeIntegrates(args);
      if (verb === "checkout") return gitCheckoutSwitches(args, scope);
      return false;
    },
  },
];

/**
 * Return the matching rule when the command is pre-approved without an LLM
 * review; null when it must go to the reviewer as before.
 */
export function matchProjectScopedAllowlist(
  command: string,
  projectRoot: string | undefined,
): ProjectShellAllowlistMatch | null {
  if (!projectRoot || !command.trim()) return null;
  // Nothing destructiveShellFlag names or suspects is pre-approved: a match
  // overrides the reviewer, so it must rest on a command read in full.
  if (destructiveShellFlag(command) !== null) return null;
  const scope: Scope = { root: projectRoot, paths: pathsFor(projectRoot) };
  const stages = plainCommands(command.trim(), ["|"], {
    cmd: process.platform === "win32" || scope.paths === path.win32,
  });
  if (!stages) return null;
  // The program itself is named literally; every argument stays in the project.
  for (const [program, ...args] of stages) {
    if (!program || program.expands.length > 0 || program.glob) return null;
    if (!args.every((word) => boundedWord(word, scope))) return null;
  }
  for (const rule of RULES) {
    try {
      if (rule.matches(stages, scope)) {
        return { rule: rule.name };
      }
    } catch {
      // A malformed rule must never block the review pipeline.
    }
  }
  return null;
}
