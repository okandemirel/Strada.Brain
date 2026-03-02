import { spawn } from "node:child_process";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 16_384;

/**
 * Execute a git command and return its output.
 */
function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT * 2) stdout = stdout.slice(-MAX_OUTPUT);
    });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT * 2) stderr = stderr.slice(-MAX_OUTPUT);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, GIT_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.length > MAX_OUTPUT ? stdout.slice(-MAX_OUTPUT) : stdout,
        stderr: stderr.length > MAX_OUTPUT ? stderr.slice(-MAX_OUTPUT) : stderr,
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, exitCode: 128 });
    });
  });
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
    if (!result.stdout.trim()) {
      return { content: "Working tree is clean. No changes." };
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
    const args = ["diff", "--stat", "--patch"];
    if (input["staged"]) args.push("--cached");
    if (input["ref"]) args.push(String(input["ref"]));
    if (input["path"]) {
      args.push("--");
      args.push(String(input["path"]));
    }

    const result = await runGit(args, context.projectPath);
    if (result.exitCode !== 0) {
      return { content: `Error: ${result.stderr || "git diff failed"}`, isError: true };
    }
    if (!result.stdout.trim()) {
      return { content: "No differences found." };
    }
    return { content: result.stdout };
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
    const count = Math.min(Math.max(1, Number(input["count"] ?? 20)), 100);
    const fmt = String(input["format"] ?? "oneline");

    const args = ["log", `-${count}`];
    if (fmt === "oneline") {
      args.push("--oneline", "--decorate");
    } else if (fmt === "short") {
      args.push("--format=short");
    }

    if (input["path"]) {
      args.push("--");
      args.push(String(input["path"]));
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

    // Stage files if provided
    const files = input["files"] as string[] | undefined;
    if (files && files.length > 0) {
      const addResult = await runGit(["add", ...files], context.projectPath);
      if (addResult.exitCode !== 0) {
        return { content: `Error staging files: ${addResult.stderr}`, isError: true };
      }
    }

    // Verify there are staged changes
    const statusResult = await runGit(["diff", "--cached", "--quiet"], context.projectPath);
    if (statusResult.exitCode === 0) {
      return { content: "Nothing to commit: no staged changes. Stage files first.", isError: true };
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
      case "list": {
        const result = await runGit(["branch", "-a", "--format=%(refname:short) %(objectname:short) %(subject)"], context.projectPath);
        if (result.exitCode !== 0) {
          return { content: `Error: ${result.stderr}`, isError: true };
        }
        return { content: result.stdout || "No branches found." };
      }
      case "create": {
        if (!name) return { content: "Error: branch name is required", isError: true };
        if (context.readOnly) return { content: "Error: branch creation disabled in read-only mode", isError: true };
        const result = await runGit(["checkout", "-b", name], context.projectPath);
        if (result.exitCode !== 0) {
          return { content: `Error: ${result.stderr}`, isError: true };
        }
        return { content: `Created and switched to branch '${name}'` };
      }
      case "checkout": {
        if (!name) return { content: "Error: branch name is required", isError: true };
        const result = await runGit(["checkout", name], context.projectPath);
        if (result.exitCode !== 0) {
          return { content: `Error: ${result.stderr}`, isError: true };
        }
        return { content: `Switched to branch '${name}'` };
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
        description: "Remote name (default: 'origin').",
      },
      branch: {
        type: "string",
        description: "Branch to push. Default: current branch.",
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

    const remote = String(input["remote"] ?? "origin");
    const args = ["push"];

    if (input["set_upstream"]) args.push("-u");
    args.push(remote);

    if (input["branch"]) {
      args.push(String(input["branch"]));
    }

    const result = await runGit(args, context.projectPath);
    if (result.exitCode !== 0) {
      return { content: `Error: push failed\n${result.stderr}`, isError: true };
    }
    return { content: result.stderr || result.stdout || "Push successful." };
  }
}

// ─── git_stash ────────────────────────────────────────────────────────────────

export class GitStashTool implements ITool {
  readonly name = "git_stash";
  readonly description =
    "Stash or restore changes. Actions: 'push' (default), 'pop', 'list', 'drop'.";

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
        const args = ["stash", "push"];
        if (input["message"]) args.push("-m", String(input["message"]));
        const result = await runGit(args, context.projectPath);
        return {
          content: result.exitCode === 0
            ? result.stdout || "Changes stashed."
            : `Error: ${result.stderr}`,
          isError: result.exitCode !== 0,
        };
      }
      case "pop": {
        const result = await runGit(["stash", "pop"], context.projectPath);
        return {
          content: result.exitCode === 0
            ? result.stdout || "Stash applied and removed."
            : `Error: ${result.stderr}`,
          isError: result.exitCode !== 0,
        };
      }
      case "list": {
        const result = await runGit(["stash", "list"], context.projectPath);
        return { content: result.stdout || "No stashes found." };
      }
      case "drop": {
        const result = await runGit(["stash", "drop"], context.projectPath);
        return {
          content: result.exitCode === 0
            ? result.stdout || "Stash dropped."
            : `Error: ${result.stderr}`,
          isError: result.exitCode !== 0,
        };
      }
      default:
        return { content: `Error: unknown action '${action}'.`, isError: true };
    }
  }
}
