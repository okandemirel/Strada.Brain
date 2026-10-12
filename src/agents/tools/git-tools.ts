import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isSensitivePath } from "../../security/path-guard.js";
import { runProcess } from "../../utils/process-runner.js";
import { integerArg } from "./tool-input.js";
import { buildShellEnv, GIT_ENV_NAMES } from "./shell-env-policy.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

const GIT_TIMEOUT_MS = 30_000;

/**
 * Credential URL pattern: https://user:token@host or similar.
 * Scrub tokens from git stderr/stdout to prevent leaking credentials.
 */
const CREDENTIAL_URL_PATTERN = /(:\/\/[^:@\s]+:)[^@\s]+(@)/g;

/**
 * Sanitize a user-supplied git argument (ref, branch name, remote, path).
 * Rejects values that start with `-` to prevent argument injection,
 * and rejects shell metacharacters.
 */
function sanitizeGitArg(
  value: string,
  label: string,
  opts: { isPath?: boolean } = {},
): { valid: true; value: string } | { valid: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, error: `${label} is required` };
  }
  if (trimmed.startsWith("-")) {
    return { valid: false, error: `${label} must not start with '-'` };
  }
  // Reject shell metacharacters that could be exploited. A path may hold `\`:
  // it is the Windows separator (review TLS-15), and git runs without a shell.
  if ((opts.isPath ? /[;|&$`!\x00-\x1f\x7f]/ : /[;|&$`\\!\x00-\x1f\x7f]/).test(trimmed)) {
    return { valid: false, error: `${label} contains invalid characters` };
  }
  return { valid: true, value: trimmed };
}

/** Scrub credential URLs from git output */
function scrubCredentials(text: string): string {
  return text.replace(CREDENTIAL_URL_PATTERN, "$1[REDACTED]$2");
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runProcess({
    command: "git",
    args,
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    // Default-deny environment, as for shell_exec: git runs the repository's
    // hooks (and filters), which must not inherit this process's provider
    // keys and bot tokens. See shell-env-policy.ts.
    env: { ...buildShellEnv(process.env, GIT_ENV_NAMES).env, GIT_TERMINAL_PROMPT: "0" },
  });
  // Scrub credentials from output
  return {
    stdout: scrubCredentials(result.stdout),
    stderr: scrubCredentials(result.stderr),
    exitCode: result.exitCode,
  };
}

async function topLevel(cwd: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  const path = result.stdout.trim();
  if (result.exitCode !== 0 || !path) {
    return { ok: false, error: result.stderr.trim() || `git rev-parse failed (exit ${result.exitCode})` };
  }
  return { ok: true, path };
}

/**
 * The paths in NUL-separated, repository-relative git output that the
 * sensitive-file blocklist covers. file_read and shell_exec refuse these by
 * name, so a git tool that stages or prints them was the way around both
 * (audit tools#3).
 */
function sensitiveNames(nulSeparated: string, root: string): string[] {
  const names = nulSeparated.split("\0").filter((name) => name.length > 0);
  return [...new Set(names.filter((name) => isSensitivePath(resolve(root, name))))];
}

/** Repository-relative names of the files a `git diff` with these arguments covers. */
function diffNames(args: string[], cwd: string) {
  // diff.relative would hide changes outside cwd from this listing, not from a commit.
  return runGit(["-c", "diff.relative=false", "diff", "--name-only", "--no-renames", "-z", ...args], cwd);
}

/**
 * The lease manager's own files at a lease's top level (LEASE_SIDECAR_FILES in
 * workspace-lease-manager.ts). The blocklist covers them so the agent cannot
 * forge them, not because they hold a secret, and every git-worktree lease has
 * the owner file there, untracked: read as a secret, it refused every
 * `git_commit {files: ["."]}` in a lease. They are kept out of the commit by
 * this exact path; the same name anywhere else is still refused.
 */
const LEASE_SIDECAR_FILES: readonly string[] = [".strada-lease-owner.json", ".strada-lease-seed.json"];

/**
 * Why `ref` is not a diff between commits, or undefined when it is. For a
 * `<rev>:<path>`, a blob or tree id or `^{tree}`, git diffs the two objects and
 * `--name-only` names only the right-hand one, relative to its subtree:
 * `HEAD:.env..HEAD:file.txt` printed .env as `file.txt`, and `<tree>..HEAD:.ssh`
 * printed .ssh/config as `config`, past every name check git_diff makes.
 */
async function notACommitRange(ref: string, cwd: string): Promise<string | undefined> {
  const parsed = await runGit(["rev-parse", ref, "--"], cwd);
  if (parsed.exitCode !== 0) return parsed.stderr.trim() || `git rev-parse failed (exit ${parsed.exitCode})`;
  const ids = parsed.stdout.split("\n").map((line) => line.trim().replace(/^\^/, "")).filter((line) => line && line !== "--");
  const commits = ids.length > 0 && ids.every((id) => /^[0-9a-f]{40,64}$/.test(id))
    ? await runGit(["rev-parse", ...ids.map((id) => `${id}^{commit}`), "--"], cwd)
    : undefined;
  if (commits?.exitCode === 0) return undefined;
  return `'${ref}' does not name commits; git_diff compares commits only. ` +
    "Give the commit as 'ref' and the file as 'path', not a '<rev>:<path>' or an object id.";
}

// ─── git_status ───────────────────────────────────────────────────────────────

export class GitStatusTool implements ITool {
  readonly name = "git_status";
  readonly description =
    "Show the working tree status. Lists changed, staged, and untracked files.";

  readonly inputSchema = {
    type: "object",
    properties: {},
    required: [],
  };

  async execute(
    _input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const result = await runGit(["status", "--porcelain=v1", "-b"], context.projectPath);
    if (result.exitCode !== 0) {
      return { content: `Error: ${result.stderr || "git status failed"}`, isError: true };
    }
    // Audited 2026-09-02: `-b` always prints the `## branch` header, so stdout
    // was never empty on success and "Working tree is clean" was unreachable —
    // a clean tree came back as a bare header the model had to interpret.
    // Separate the header from the entries and judge cleanliness on the entries.
    const [head, ...entries] = result.stdout.split("\n").filter((line) => line.length > 0);
    if (entries.length === 0) {
      return { content: `${head ?? ""}\nWorking tree is clean. No changes.`.trimStart() };
    }
    return { content: result.stdout };
  }
}

// ─── git_diff ─────────────────────────────────────────────────────────────────

export class GitDiffTool implements ITool {
  readonly name = "git_diff";
  readonly description =
    "Show changes between commits, working tree, and staging area. " +
    "Use 'staged: true' to see staged changes. Optionally specify a file path.";

  readonly inputSchema = {
    type: "object",
    properties: {
      staged: {
        type: "boolean",
        description: "If true, show staged (cached) changes instead of unstaged.",
      },
      path: {
        type: "string",
        description: "Optional file path to diff (relative to project root).",
      },
      ref: {
        type: "string",
        description: "Optional ref to diff against (e.g., 'HEAD~3', 'main', commit hash).",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const revs: string[] = [];
    if (input["staged"]) revs.push("--cached");
    if (input["ref"]) {
      const ref = sanitizeGitArg(String(input["ref"]), "ref");
      if (!ref.valid) return { content: `Error: ${ref.error}`, isError: true };
      const notCommits = await notACommitRange(ref.value, context.projectPath);
      if (notCommits) return { content: `Error: ${notCommits}`, isError: true };
      revs.push(ref.value);
    }
    const pathspec: string[] = [];
    if (input["path"]) {
      const path = sanitizeGitArg(String(input["path"]), "path", { isPath: true });
      if (!path.valid) return { content: `Error: ${path.error}`, isError: true };
      if (isSensitivePath(resolve(context.projectPath, path.value))) {
        return { content: `Error: '${path.value}' is on the sensitive-file blocklist; git_diff does not show it.`, isError: true };
      }
      pathspec.push(path.value);
    }

    // A ref, a directory or no path at all reaches secret files no name check
    // sees, so what this diff covers is listed first and those are left out.
    const root = await topLevel(context.projectPath);
    if (!root.ok) return { content: `Error: ${root.error}`, isError: true };
    const listed = await diffNames([...revs, "--", ...pathspec], context.projectPath);
    if (listed.exitCode !== 0) {
      return { content: `Error: ${listed.stderr || "git diff failed"}`, isError: true };
    }
    const omitted = sensitiveNames(listed.stdout, root.path);
    if (omitted.length > 0) {
      for (const name of omitted) pathspec.push(`:(top,exclude,literal)${name}`);
      // Confirm the exclusion took before anything is printed.
      const recheck = await diffNames([...revs, "--", ...pathspec], context.projectPath);
      if (recheck.exitCode !== 0 || sensitiveNames(recheck.stdout, root.path).length > 0) {
        return {
          content: `Error: this diff shows files on the sensitive-file blocklist (${omitted.join(", ")}) and they cannot be left out of it.`,
          isError: true,
        };
      }
    }

    const result = await runGit(["diff", "--stat", "--patch", ...revs, "--", ...pathspec], context.projectPath);
    if (result.exitCode !== 0) {
      return { content: `Error: ${result.stderr || "git diff failed"}`, isError: true };
    }
    const note = omitted.length > 0 ? `Left out (sensitive-file blocklist): ${omitted.join(", ")}` : "";
    if (!result.stdout.trim()) {
      return { content: note ? `No differences outside the sensitive-file blocklist.\n${note}` : "No differences found." };
    }
    return { content: note ? `${result.stdout}\n${note}` : result.stdout };
  }
}

// ─── git_log ──────────────────────────────────────────────────────────────────

export class GitLogTool implements ITool {
  readonly name = "git_log";
  readonly description =
    "Show commit history. Defaults to last 20 commits in one-line format.";

  readonly inputSchema = {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "Number of commits to show (default: 20, max: 100).",
      },
      path: {
        type: "string",
        description: "Optional file path to filter history.",
      },
      format: {
        type: "string",
        description: "Output format: 'oneline' (default), 'short', 'full'.",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const countArg = integerArg(input, "count");
    if (!countArg.ok) return { content: countArg.error, isError: true };
    const count = Math.min(Math.max(1, countArg.value ?? 20), 100);
    // An enum: "full" was accepted and silently printed the default format.
    const fmt = input["format"] ?? "oneline";
    if (fmt !== "oneline" && fmt !== "short" && fmt !== "full") {
      return { content: `Error: 'format' must be one of oneline, short, full (got ${JSON.stringify(fmt)})`, isError: true };
    }

    const args = ["log", `-${count}`];
    if (fmt === "oneline") {
      args.push("--oneline", "--decorate");
    } else {
      args.push(`--format=${fmt}`);
    }

    if (input["path"]) {
      const path = sanitizeGitArg(String(input["path"]), "path", { isPath: true });
      if (!path.valid) return { content: `Error: ${path.error}`, isError: true };
      args.push("--");
      args.push(path.value);
    }

    const result = await runGit(args, context.projectPath);
    if (result.exitCode !== 0) {
      return { content: `Error: ${result.stderr || "git log failed"}`, isError: true };
    }
    return { content: result.stdout || "No commits found." };
  }
}

// ─── git_commit ───────────────────────────────────────────────────────────────

export class GitCommitTool implements ITool {
  readonly name = "git_commit";
  readonly description =
    "Stage files and create a git commit. " +
    "Can stage specific files or all changes. Always requires a commit message.";

  readonly inputSchema = {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Commit message (required).",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Files to stage before committing. If empty or omitted, commits only already-staged files. " +
          "Use ['.'] to stage all changes.",
      },
    },
    required: ["message"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: git commit is disabled in read-only mode", isError: true };
    }

    const message = String(input["message"] ?? "").trim();
    if (!message) {
      return { content: "Error: commit message is required", isError: true };
    }

    // Stage files if provided.
    // Audited 2026-09-02: `files` was cast to string[] unchecked, so a single
    // path given as a string (nothing validates tool input against the schema)
    // was iterated per character and spread into `git add -- A s s e t s / …`,
    // failing with an error that named neither the cause nor the file. A
    // string is one path; anything else that is not an array is rejected by
    // name. The sanitized (trimmed) value is what gets staged.
    const rawFiles = input["files"];
    let files: unknown[] | undefined;
    if (typeof rawFiles === "string") files = [rawFiles];
    else if (Array.isArray(rawFiles)) files = rawFiles;
    else if (rawFiles !== undefined && rawFiles !== null) {
      return { content: "Error: 'files' must be an array of file paths (or a single path string)", isError: true };
    }
    const root = await topLevel(context.projectPath);
    if (!root.ok) return { content: `Error: ${root.error}`, isError: true };
    if (files && files.length > 0) {
      // Validate each file path and use -- to prevent flag injection
      const staged: string[] = [];
      for (const f of files) {
        const check = sanitizeGitArg(String(f), "file path", { isPath: true });
        if (!check.valid) return { content: `Error: ${check.error}`, isError: true };
        staged.push(check.value);
      }
      // What `git add` would stage, checked before it does: `.`, a directory or
      // a glob reaches secret files that no name check on `files` sees, and a
      // refused file left staged would ride along with the user's next commit.
      // A deletion carries no content, so removing a tracked secret still works.
      const pathspec = [...staged, ...LEASE_SIDECAR_FILES.map((name) => `:(top,exclude,literal)${name}`)];
      const [tracked, untracked] = await Promise.all([
        diffNames(["--diff-filter=d", "--", ...pathspec], context.projectPath),
        runGit(["ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--", ...pathspec], context.projectPath),
      ]);
      const failed = [tracked, untracked].find((result) => result.exitCode !== 0);
      if (failed) {
        return { content: `Error staging files: ${failed.stderr}`, isError: true };
      }
      const refused = sensitiveNames(tracked.stdout + untracked.stdout, root.path);
      if (refused.length > 0) {
        return {
          content: `Error: refusing to stage files on the sensitive-file blocklist: ${refused.join(", ")}. ` +
            "Name the files to commit without them.",
          isError: true,
        };
      }
      // git refuses an add whose :(exclude) names an ignored file that exists
      // ("The following paths are ignored…", exit 1), and the owner file always
      // does: a project ignoring `.strada*` refused every commit that touched a
      // lease's top level. `add` never stages an ignored file, so only the
      // sidecars it would pick up are excluded; the listings above never refuse.
      const ignored = await runGit(["check-ignore", "--no-index", "--", ...LEASE_SIDECAR_FILES], root.path);
      const ignoredSidecars = ignored.exitCode === 0 ? ignored.stdout.split("\n").map((line) => line.trim()) : [];
      const addSpec = [
        ...staged,
        ...LEASE_SIDECAR_FILES
          .filter((name) => !ignoredSidecars.includes(name))
          .map((name) => `:(top,exclude,literal)${name}`),
      ];
      const addResult = await runGit(["add", "--", ...addSpec], context.projectPath);
      if (addResult.exitCode !== 0) {
        return { content: `Error staging files: ${addResult.stderr}`, isError: true };
      }
    }

    // A shell `git add -A` in a lease stages the lease's own files: they are
    // unstaged, neither committed nor a reason to refuse the rest.
    const index = await diffNames(["--cached", "--diff-filter=d"], context.projectPath);
    if (index.exitCode !== 0) {
      return { content: `Error: ${index.stderr || "git diff --cached failed"}`, isError: true };
    }
    const sidecars = index.stdout.split("\0").filter((name) => LEASE_SIDECAR_FILES.includes(name));
    if (sidecars.length > 0) {
      const reset = await runGit(["reset", "-q", "--", ...sidecars.map((name) => `:(top,literal)${name}`)], context.projectPath);
      if (reset.exitCode !== 0) {
        return { content: `Error: could not unstage ${sidecars.join(", ")}: ${reset.stderr}`, isError: true };
      }
    }

    // Verify there are staged changes
    const statusResult = await runGit(["diff", "--cached", "--quiet"], context.projectPath);
    if (statusResult.exitCode === 0) {
      return { content: "Nothing to commit: no staged changes. Stage files first.", isError: true };
    }
    // ...and that none of them is a secret file something else staged.
    const stagedSecrets = sensitiveNames(index.stdout, root.path).filter((name) => !sidecars.includes(name));
    if (stagedSecrets.length > 0) {
      return {
        content: `Error: refusing to commit: the index holds files on the sensitive-file blocklist: ${stagedSecrets.join(", ")}. ` +
          "They were staged outside git_commit; unstage them first.",
        isError: true,
      };
    }

    // Commit
    const commitResult = await runGit(["commit", "-m", message], context.projectPath);
    if (commitResult.exitCode !== 0) {
      return {
        content: `Error: commit failed\n${commitResult.stderr}\n${commitResult.stdout}`,
        isError: true,
      };
    }

    return { content: commitResult.stdout };
  }
}

// ─── git_branch ───────────────────────────────────────────────────────────────

/**
 * The one command both branch tools run to answer "which branches exist?".
 * Shared so the read tool and the read half of git_branch cannot drift apart.
 */
async function listBranches(projectPath: string): Promise<ToolExecutionResult> {
  const result = await runGit(
    ["branch", "-a", "--format=%(refname:short) %(objectname:short) %(subject)"],
    projectPath,
  );
  if (result.exitCode !== 0) {
    return { content: `Error: ${result.stderr}`, isError: true };
  }
  return { content: result.stdout || "No branches found." };
}

/**
 * Branch listing, split out as its own read-only tool (audited 2026-09-02).
 *
 * git_branch is correctly classified as a write — `git checkout [-b]` rewrites
 * the working tree — but that classification also removed LISTING from
 * write-disabled phases and sent every `action: "list"` to the human approval
 * queue. Listing runs one `git branch -a --format=…` and changes nothing, so it
 * lives here, where the read-only guard and the parallel dispatcher can both
 * see that it is a read.
 */
export class GitBranchListTool implements ITool {
  readonly name = "git_branch_list";
  readonly description =
    "List local and remote branches. Read-only: it cannot create or switch branches — " +
    "use 'git_branch' for that.";

  readonly inputSchema = {
    type: "object",
    properties: {},
    required: [],
  };

  async execute(
    _input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return listBranches(context.projectPath);
  }
}


export class GitBranchTool implements ITool {
  readonly name = "git_branch";
  readonly description =
    "List, create, or switch branches. " +
    "Actions: 'list' (default), 'create', 'checkout'.";

  readonly inputSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: 'list', 'create', 'checkout'. Default: 'list'.",
      },
      name: {
        type: "string",
        description: "Branch name (required for create/checkout).",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const action = String(input["action"] ?? "list");
    const name = String(input["name"] ?? "").trim();

    switch (action) {
      case "list":
        // Kept working here for callers that already ask for it, but the
        // read-only path agents should reach for is git_branch_list — this
        // tool is gated as a write (audited 2026-09-02).
        return listBranches(context.projectPath);
      case "create": {
        if (!name) return { content: "Error: branch name is required", isError: true };
        if (context.readOnly) return { content: "Error: branch creation disabled in read-only mode", isError: true };
        const nameCheck = sanitizeGitArg(name, "branch name");
        if (!nameCheck.valid) return { content: `Error: ${nameCheck.error}`, isError: true };
        const result = await runGit(["checkout", "-b", nameCheck.value], context.projectPath);
        if (result.exitCode !== 0) {
          return { content: `Error: ${result.stderr}`, isError: true };
        }
        return { content: `Created and switched to branch '${nameCheck.value}'` };
      }
      case "checkout": {
        if (!name) return { content: "Error: branch name is required", isError: true };
        if (context.readOnly) return { content: "Error: checkout is disabled in read-only mode", isError: true };
        const nameCheck = sanitizeGitArg(name, "branch name");
        if (!nameCheck.valid) return { content: `Error: ${nameCheck.error}`, isError: true };
        // `git switch`, not `git checkout`: checkout falls back to reading a
        // name that is not a ref as a PATHSPEC and restores those paths from
        // the index, silently discarding uncommitted work while this tool
        // reported a branch switch. switch only ever takes a branch.
        const result = await runGit(["switch", nameCheck.value], context.projectPath);
        if (result.exitCode !== 0) {
          return { content: `Error: ${result.stderr}`, isError: true };
        }
        return { content: `Switched to branch '${nameCheck.value}'` };
      }
      default:
        return { content: `Error: unknown action '${action}'. Use 'list', 'create', or 'checkout'.`, isError: true };
    }
  }
}

// ─── git_push ─────────────────────────────────────────────────────────────────

export class GitPushTool implements ITool {
  readonly name = "git_push";
  readonly description =
    "Push commits to the remote repository. Can set upstream tracking.";

  readonly inputSchema = {
    type: "object",
    properties: {
      remote: {
        type: "string",
        description: "Configured remote name, as listed by `git remote` (default: 'origin'). URLs and paths are refused.",
      },
      branch: {
        type: "string",
        description: "Local branch to push to the remote branch of the same name. Default: current branch.",
      },
      set_upstream: {
        type: "boolean",
        description: "Set upstream tracking (-u flag). Default: false.",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: git push is disabled in read-only mode", isError: true };
    }

    const remoteRaw = String(input["remote"] ?? "origin");
    const remoteCheck = sanitizeGitArg(remoteRaw, "remote");
    if (!remoteCheck.valid) return { content: `Error: ${remoteCheck.error}`, isError: true };

    // The refspec is built here, never passed through: git reads a pushed
    // argument as a REFSPEC, whose syntax can force-update or delete the
    // remote branch — neither of which this tool offers or its confirmation
    // shows. The name must be a valid branch name by git's own rules (which
    // exclude `:`), and both sides are fully qualified, so no input can make
    // the refspec start with `+` or have an empty source.
    let refspec: string | undefined;
    if (input["branch"]) {
      const branchCheck = sanitizeGitArg(String(input["branch"]), "branch");
      if (!branchCheck.valid) return { content: `Error: ${branchCheck.error}`, isError: true };
      const format = await runGit(["check-ref-format", "--branch", branchCheck.value], context.projectPath);
      const branch = format.stdout.trim();
      if (format.exitCode !== 0 || !branch) {
        return { content: `Error: '${branchCheck.value}' is not a valid branch name`, isError: true };
      }
      refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    }

    // A configured remote NAME only. git also accepts a URL or a filesystem
    // path here, which would send the commits somewhere nobody configured.
    const remotes = await runGit(["remote"], context.projectPath);
    if (remotes.exitCode !== 0) {
      return { content: `Error: could not list remotes\n${remotes.stderr}`, isError: true };
    }
    const remoteNames = remotes.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (!remoteNames.includes(remoteCheck.value)) {
      const configured = remoteNames.length > 0 ? `configured: ${remoteNames.join(", ")}` : "this repository has none";
      return {
        content: `Error: '${remoteCheck.value}' is not a configured remote (${configured}). ` +
          "Push to a remote name listed by `git remote`, not a URL or path.",
        isError: true,
      };
    }

    const args = ["push"];
    if (input["set_upstream"]) args.push("-u");
    args.push(remoteCheck.value);
    if (refspec) args.push(refspec);

    const result = await runGit(args, context.projectPath);
    if (result.exitCode !== 0) {
      return { content: `Error: push failed\n${result.stderr}`, isError: true };
    }
    return { content: result.stderr || result.stdout || "Push successful." };
  }
}

// ─── git_stash ────────────────────────────────────────────────────────────────

interface StashState {
  /** Ends the message of every entry git_stash pushes in this checkout. */
  tag: string;
  /** This checkout's git_stash entries, newest first. */
  own: { selector: string; subject: string }[];
  /** Entries on the stack that are not this checkout's. */
  others: number;
}

/**
 * refs/stash belongs to the repository, not the checkout: every linked
 * worktree — each workspace lease is one — pushes onto and pops from the
 * user's own stack. An agent that pushed nothing in its lease and then popped
 * took the user's WIP into the lease and dropped it from their list (audit
 * tools#2), and parallel leases could pop each other's entries. git_stash
 * tags what it pushes with the checkout it ran in and touches nothing else.
 * git has no compare-and-swap for a stash entry, so a push from another
 * checkout in the instant between this listing and the pop can still shift
 * the selector by one.
 */
async function readStash(cwd: string): Promise<({ ok: true } & StashState) | { ok: false; error: string }> {
  const root = await topLevel(cwd);
  if (!root.ok) return root;
  const tag = `[git_stash ${createHash("sha256").update(root.path).digest("hex").slice(0, 12)}]`;
  const result = await runGit(["stash", "list", "--format=%gs"], cwd);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || `git stash list failed (exit ${result.exitCode})` };
  }
  // The stack is listed newest first, so line n is stash@{n}.
  const subjects = result.stdout.split("\n").filter((line) => line.length > 0);
  const own = subjects
    .map((subject, n) => ({ selector: `stash@{${n}}`, subject }))
    .filter((entry) => entry.subject.endsWith(tag));
  return { ok: true, tag, own, others: subjects.length - own.length };
}

function otherStashesNote(others: number): string {
  if (others === 0) return "";
  return `${others} other stash ${others === 1 ? "entry" : "entries"} in this repository ` +
    "(the user's, or another checkout's) not shown: git_stash only touches what it stashed in this checkout.";
}

export class GitStashTool implements ITool {
  readonly name = "git_stash";
  readonly description =
    "Stash or restore changes in this checkout. Actions: 'push' (default), 'pop', 'list', 'drop'. " +
    "pop, drop and list see only the entries git_stash pushed in this same checkout; untracked files are not stashed.";

  readonly inputSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: 'push', 'pop', 'list', 'drop'. Default: 'push'.",
      },
      message: {
        type: "string",
        description: "Stash message (for push action).",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const action = String(input["action"] ?? "push");

    switch (action) {
      case "push": {
        if (context.readOnly) return { content: "Error: git stash is disabled in read-only mode", isError: true };
        let message = "";
        if (input["message"]) {
          const msgCheck = sanitizeGitArg(String(input["message"]), "stash message");
          if (!msgCheck.valid) return { content: `Error: ${msgCheck.error}`, isError: true };
          message = `${msgCheck.value} `;
        }
        const before = await readStash(context.projectPath);
        if (!before.ok) return { content: `Error: ${before.error}`, isError: true };
        const result = await runGit(["stash", "push", "-m", `${message}${before.tag}`], context.projectPath);
        if (result.exitCode !== 0) return { content: `Error: ${result.stderr}`, isError: true };
        // git exits 0 when there was nothing to save, in a localized message:
        // judge by whether this checkout gained an entry.
        const after = await readStash(context.projectPath);
        if (!after.ok) return { content: `Error: ${after.error}`, isError: true };
        if (after.own.length <= before.own.length) {
          return {
            content: "Nothing was stashed: no local changes to tracked files (untracked files are not stashed), " +
              "so there is no entry to pop.",
          };
        }
        return { content: result.stdout || "Changes stashed.", isError: false };
      }
      case "pop":
      case "drop": {
        if (context.readOnly) return { content: "Error: git stash is disabled in read-only mode", isError: true };
        const stash = await readStash(context.projectPath);
        if (!stash.ok) return { content: `Error: ${stash.error}`, isError: true };
        const entry = stash.own[0];
        if (!entry) {
          const note = otherStashesNote(stash.others);
          return {
            content: `Error: there is no stash entry git_stash pushed in this checkout to ${action}.${note ? ` ${note}` : ""}`,
            isError: true,
          };
        }
        const result = await runGit(["stash", action, entry.selector], context.projectPath);
        return {
          content: result.exitCode === 0
            ? result.stdout || (action === "pop" ? "Stash applied and removed." : "Stash dropped.")
            : `Error: ${result.stderr}`,
          isError: result.exitCode !== 0,
        };
      }
      case "list": {
        // Audited 2026-09-02: a failed `git stash list` (a lease without .git
        // exits 128 with empty stdout) read as "No stashes found." — a failed
        // check rendered as a clean one. readStash reports it as an error.
        const stash = await readStash(context.projectPath);
        if (!stash.ok) return { content: `Error: ${stash.error}`, isError: true };
        const lines = stash.own.map((entry) => `${entry.selector}: ${entry.subject}`);
        const note = otherStashesNote(stash.others);
        if (note) lines.push(note);
        return { content: lines.join("\n") || "No stashes found." };
      }
      default:
        return { content: `Error: unknown action '${action}'.`, isError: true };
    }
  }
}
