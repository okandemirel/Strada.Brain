import { spawnSync } from "node:child_process";

export type ClaudeSubscriptionAuthIssue =
  | "missing-auth-token"
  | "claude-cli-unavailable"
  | "invalid-auth-status";

export interface ClaudeSubscriptionAuthInspection {
  readonly ok: boolean;
  readonly issue?: ClaudeSubscriptionAuthIssue;
  readonly detail: string;
  readonly authToken?: string;
  readonly loggedIn?: boolean;
  readonly authMethod?: string;
  readonly subscriptionType?: string;
}

interface InspectClaudeSubscriptionAuthOptions {
  readonly authToken?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface ClaudeAuthStatusPayload {
  loggedIn?: unknown;
  authMethod?: unknown;
  subscriptionType?: unknown;
}

function readClaudeAuthStatus(): ClaudeSubscriptionAuthInspection | null {
  const result = spawnSync("claude", ["auth", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return {
      ok: false,
      issue: "claude-cli-unavailable",
      detail:
        "Claude CLI is not available on this machine. Run `claude auth login --claudeai`, then `claude setup-token`, paste the generated token, or switch Claude to API-key mode.",
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      issue: "invalid-auth-status",
      detail:
        "Claude CLI auth status could not be read. Run `claude auth login --claudeai`, then `claude setup-token`, paste the generated token, or switch Claude to API-key mode.",
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as ClaudeAuthStatusPayload;
    return {
      ok: false,
      issue: "missing-auth-token",
      detail:
        parsed.loggedIn === true && parsed.authMethod === "claude.ai"
          ? "Claude subscription login is available on this machine, but Strada needs a Claude auth token. Run `claude setup-token`, paste the generated token, or switch Claude to API-key mode."
          : "Claude subscription mode requires a Claude auth token. Run `claude auth login --claudeai`, then `claude setup-token`, paste the generated token, or switch Claude to API-key mode.",
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : undefined,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined,
    };
  } catch {
    return {
      ok: false,
      issue: "invalid-auth-status",
      detail:
        "Claude CLI auth status returned an unexpected response. Run `claude auth login --claudeai`, then `claude setup-token`, paste the generated token, or switch Claude to API-key mode.",
    };
  }
}

export function inspectClaudeSubscriptionAuth(
  options: InspectClaudeSubscriptionAuthOptions = {},
): ClaudeSubscriptionAuthInspection {
  const env = options.env ?? process.env;
  const authToken = options.authToken?.trim() || env["ANTHROPIC_AUTH_TOKEN"]?.trim();

  if (authToken) {
    return {
      ok: true,
      authToken,
      detail: "Claude subscription auth token is configured.",
    };
  }

  return readClaudeAuthStatus() ?? {
    ok: false,
    issue: "missing-auth-token",
    detail:
      "Claude subscription mode requires a Claude auth token. Run `claude auth login --claudeai`, then `claude setup-token`, paste the generated token, or switch Claude to API-key mode.",
  };
}
