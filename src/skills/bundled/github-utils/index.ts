// ---------------------------------------------------------------------------
// GitHub Utils bundled skill — wraps `gh` CLI for PR, issue, and repo info.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { execFileNoThrow } from "../../../utils/execFileNoThrow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split an optional user-supplied args string into an array of tokens. */
function splitArgs(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw.trim().split(/\s+/);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const ghPrStatus: ITool = {
  name: "gh_pr_status",
  description: "Show the status of pull requests related to the current branch using the GitHub CLI.",
  inputSchema: {
    type: "object" as const,
    properties: {
      args: {
        type: "string",
        description: "Optional extra arguments passed to `gh pr status`",
      },
    },
    required: [],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const extra = splitArgs(input["args"]);
    const result = await execFileNoThrow("gh", ["pr", "status", ...extra], 15_000);
    if (result.exitCode !== 0) {
      return { content: `gh pr status failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
    }
    return { content: result.stdout };
  },
};

const ghIssueList: ITool = {
  name: "gh_issue_list",
  description: "List open issues for the current repository using the GitHub CLI.",
  inputSchema: {
    type: "object" as const,
    properties: {
      args: {
        type: "string",
        description: "Optional extra arguments passed to `gh issue list`",
      },
    },
    required: [],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const extra = splitArgs(input["args"]);
    const result = await execFileNoThrow("gh", ["issue", "list", "--limit", "10", ...extra], 15_000);
    if (result.exitCode !== 0) {
      return { content: `gh issue list failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
    }
    return { content: result.stdout || "No open issues." };
  },
};

const ghRepoView: ITool = {
  name: "gh_repo_view",
  description: "View repository information for the current repository using the GitHub CLI.",
  inputSchema: {
    type: "object" as const,
    properties: {
      args: {
        type: "string",
        description: "Optional extra arguments passed to `gh repo view`",
      },
    },
    required: [],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const extra = splitArgs(input["args"]);
    const result = await execFileNoThrow("gh", ["repo", "view", ...extra], 15_000);
    if (result.exitCode !== 0) {
      return { content: `gh repo view failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
    }
    return { content: result.stdout };
  },
};

export const tools = [ghPrStatus, ghIssueList, ghRepoView];
export default tools;
