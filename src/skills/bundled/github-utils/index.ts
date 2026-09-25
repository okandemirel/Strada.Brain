// ---------------------------------------------------------------------------
// GitHub Utils bundled skill — wraps `gh` CLI for PR, issue, and repo info.
// ---------------------------------------------------------------------------

import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";
import { execFileNoThrow } from "../../../utils/execFileNoThrow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split an optional args string into tokens. Single and double quotes group
 * words (`--search "is:open label:bug"`); nothing else is interpreted, since
 * no shell ever sees the result. Null when a quote is left open.
 */
export function splitArgs(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)|(["'])/g;
  let current: string | null = null;
  let lastEnd = -1;
  for (const m of raw.matchAll(re)) {
    if (m[4] !== undefined) return null;
    const piece = m[1] ?? m[2] ?? m[3] ?? "";
    // Adjacent pieces with no whitespace between them form one word (--label="a b").
    if (current !== null && m.index === lastEnd) current += piece;
    else {
      if (current !== null) tokens.push(current);
      current = piece;
    }
    lastEnd = m.index + m[0].length;
  }
  if (current !== null) tokens.push(current);
  return tokens;
}

/** Long flag name → whether it takes a value. Short aliases map onto these. */
interface FlagSpec {
  readonly flags: Readonly<Record<string, boolean>>;
  readonly aliases?: Readonly<Record<string, string>>;
}

const OUTPUT_FLAGS = { "--json": true, "--jq": true, "--template": true } as const;
const OUTPUT_ALIASES = { "-q": "--jq", "-t": "--template" } as const;

/**
 * SEC-18: the flags each tool accepts — read-only filters and output
 * formatting. Anything else is refused, notably `-R/--repo` and a positional
 * repository (which would read any repository the user's `gh` token can
 * see) and `--web`.
 */
const PR_STATUS_FLAGS: FlagSpec = {
  flags: { ...OUTPUT_FLAGS, "--conflict-status": false },
  aliases: { ...OUTPUT_ALIASES, "-c": "--conflict-status" },
};
const ISSUE_LIST_FLAGS: FlagSpec = {
  flags: {
    ...OUTPUT_FLAGS,
    "--limit": true,
    "--state": true,
    "--label": true,
    "--assignee": true,
    "--author": true,
    "--mention": true,
    "--milestone": true,
    "--search": true,
  },
  aliases: {
    ...OUTPUT_ALIASES,
    "-L": "--limit",
    "-s": "--state",
    "-l": "--label",
    "-a": "--assignee",
    "-A": "--author",
    "-m": "--milestone",
    "-S": "--search",
  },
};
const REPO_VIEW_FLAGS: FlagSpec = {
  flags: { ...OUTPUT_FLAGS, "--branch": true },
  aliases: { ...OUTPUT_ALIASES, "-b": "--branch" },
};

/**
 * Check `tokens` against `spec` and return them as `--flag` / `--flag=value`
 * (the `=` form, so a value can never be read as another flag), or why not.
 */
export function filterGhArgs(tokens: readonly string[], spec: FlagSpec): { args: string[] } | { error: string } {
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const written = eq > 0 ? token.slice(0, eq) : token;
    const name = spec.aliases?.[written] ?? written;
    const takesValue = spec.flags[name];
    if (takesValue === undefined) {
      return {
        error: token.startsWith("-")
          ? `flag ${written} is not allowed here (allowed: ${Object.keys(spec.flags).join(", ")})`
          : `positional argument "${token}" is not allowed; this tool reads the project's own repository`,
      };
    }
    if (!takesValue) {
      if (eq > 0) return { error: `flag ${written} takes no value` };
      args.push(name);
      continue;
    }
    const value = eq > 0 ? token.slice(eq + 1) : tokens[++i];
    if (value === undefined) return { error: `flag ${written} needs a value` };
    args.push(`${name}=${value}`);
  }
  return { args };
}

/** Run `gh <subcommand...> <filtered args>` in the project directory. */
async function runGh(
  subcommand: readonly string[],
  input: Record<string, unknown>,
  spec: FlagSpec,
  context: ToolContext,
  whenEmpty = "",
): Promise<ToolExecutionResult> {
  const label = `gh ${subcommand.filter((s) => !s.startsWith("-")).join(" ")}`;
  const tokens = splitArgs(input["args"]);
  if (!tokens) return { content: `${label}: unterminated quote in args`, isError: true };
  const filtered = filterGhArgs(tokens, spec);
  if ("error" in filtered) return { content: `${label}: ${filtered.error}`, isError: true };
  // SEC-18: the project's repository, not whatever the bot process was started in.
  const cwd = typeof context?.projectPath === "string" && context.projectPath ? context.projectPath : undefined;
  const result = await execFileNoThrow("gh", [...subcommand, ...filtered.args], 15_000, undefined, { cwd });
  if (result.exitCode !== 0) {
    return { content: `${label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
  }
  return { content: result.stdout || whenEmpty };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const ghPrStatus: ITool = {
  name: "gh_pr_status",
  description: "Show the status of pull requests related to the current branch of the project using the GitHub CLI.",
  inputSchema: {
    type: "object" as const,
    properties: {
      args: {
        type: "string",
        description: "Optional extra flags for `gh pr status`: --json, --jq, --template, --conflict-status",
      },
    },
    required: [],
  },
  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return runGh(["pr", "status"], input, PR_STATUS_FLAGS, context);
  },
};

const ghIssueList: ITool = {
  name: "gh_issue_list",
  description: "List open issues for the project's repository using the GitHub CLI.",
  inputSchema: {
    type: "object" as const,
    properties: {
      args: {
        type: "string",
        description:
          "Optional extra flags for `gh issue list`: --limit, --state, --label, --assignee, --author, --mention, " +
          "--milestone, --search, --json, --jq, --template",
      },
    },
    required: [],
  },
  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return runGh(["issue", "list", "--limit", "10"], input, ISSUE_LIST_FLAGS, context, "No open issues.");
  },
};

const ghRepoView: ITool = {
  name: "gh_repo_view",
  description: "View repository information for the project's repository using the GitHub CLI.",
  inputSchema: {
    type: "object" as const,
    properties: {
      args: {
        type: "string",
        description: "Optional extra flags for `gh repo view`: --branch, --json, --jq, --template",
      },
    },
    required: [],
  },
  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return runGh(["repo", "view"], input, REPO_VIEW_FLAGS, context);
  },
};

export const tools = [ghPrStatus, ghIssueList, ghRepoView];
export default tools;
