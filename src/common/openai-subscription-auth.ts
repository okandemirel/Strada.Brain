import { existsSync, readFileSync } from "node:fs";

export const OPENAI_CHATGPT_AUTH_DEFAULT_FILE = "~/.codex/auth.json";

export type OpenAiSubscriptionAuthIssue =
  | "missing-auth-file"
  | "invalid-auth-file"
  | "missing-credentials"
  | "expired-token";

export interface OpenAiSubscriptionAuthInspection {
  readonly ok: boolean;
  readonly authFile: string;
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly expiresAt?: string;
  readonly issue?: OpenAiSubscriptionAuthIssue;
  readonly detail: string;
}

interface InspectOpenAiSubscriptionAuthOptions {
  readonly authFile?: string;
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
  readonly graceMs?: number;
}

function normalizeBase64Url(base64Url: string): string {
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  if (padding === 0) {
    return normalized;
  }
  return `${normalized}${"=".repeat(4 - padding)}`;
}

export function expandHomePath(
  pathValue: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (pathValue.startsWith("~/")) {
    const home = env["HOME"] ?? "";
    return `${home}/${pathValue.slice(2)}`;
  }
  return pathValue;
}

export function decodeJwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    const decoded = Buffer.from(normalizeBase64Url(payload), "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { exp?: unknown };
    if (typeof parsed.exp === "number" && Number.isFinite(parsed.exp)) {
      return parsed.exp * 1000;
    }
  } catch {
    return null;
  }

  return null;
}

export function inspectOpenAiSubscriptionAuth(
  options: InspectOpenAiSubscriptionAuthOptions = {},
): OpenAiSubscriptionAuthInspection {
  const env = options.env ?? process.env;
  const authFile = expandHomePath(
    options.authFile ?? OPENAI_CHATGPT_AUTH_DEFAULT_FILE,
    env,
  );
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? 60_000;

  let accessToken = options.accessToken;
  let accountId = options.accountId;

  if (!accessToken || !accountId) {
    if (!existsSync(authFile)) {
      return {
        ok: false,
        authFile,
        issue: "missing-auth-file",
        detail: `ChatGPT/Codex subscription auth file was not found at ${authFile}.`,
      };
    }

    try {
      const parsed = JSON.parse(readFileSync(authFile, "utf8")) as {
        tokens?: { access_token?: string; account_id?: string };
      };
      accessToken = accessToken ?? parsed.tokens?.access_token;
      accountId = accountId ?? parsed.tokens?.account_id;
    } catch (error) {
      return {
        ok: false,
        authFile,
        issue: "invalid-auth-file",
        detail: `ChatGPT/Codex subscription auth file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!accessToken || !accountId) {
    return {
      ok: false,
      authFile,
      issue: "missing-credentials",
      detail: "ChatGPT/Codex subscription auth is missing access_token/account_id.",
    };
  }

  const expiryMs = decodeJwtExpiryMs(accessToken);
  if (expiryMs !== null && expiryMs <= nowMs + graceMs) {
    return {
      ok: false,
      authFile,
      accessToken,
      accountId,
      expiresAt: new Date(expiryMs).toISOString(),
      issue: "expired-token",
      detail: `ChatGPT/Codex subscription access token expired at ${new Date(expiryMs).toISOString()}.`,
    };
  }

  return {
    ok: true,
    authFile,
    accessToken,
    accountId,
    expiresAt: expiryMs !== null ? new Date(expiryMs).toISOString() : undefined,
    detail: expiryMs !== null
      ? `ChatGPT/Codex subscription session is valid until ${new Date(expiryMs).toISOString()}.`
      : "ChatGPT/Codex subscription session is available.",
  };
}

