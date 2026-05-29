import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export const OPENAI_CHATGPT_AUTH_DEFAULT_FILE = "~/.codex/auth.json";
/** Fallback OAuth issuer / client when they cannot be derived from the token. */
const DEFAULT_OPENAI_ISSUER = "https://auth.openai.com";
const FALLBACK_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

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

export function decodeJwtClaims(token: string | undefined | null): Record<string, unknown> | null {
  if (!token) {
    return null;
  }
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const decoded = Buffer.from(normalizeBase64Url(payload), "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function decodeJwtExpiryMs(token: string): number | null {
  const claims = decodeJwtClaims(token);
  if (claims && typeof claims["exp"] === "number" && Number.isFinite(claims["exp"])) {
    return (claims["exp"] as number) * 1000;
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

export interface OpenAiSubscriptionRefreshResult {
  readonly ok: boolean;
  readonly rotatedRefreshToken?: boolean;
  readonly error?: string;
}

interface RefreshOptions {
  readonly authFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: number;
}

function resolveOAuthClientId(
  accessClaims: Record<string, unknown> | null,
  idClaims: Record<string, unknown> | null,
): string {
  const fromAccess = accessClaims?.["client_id"];
  if (typeof fromAccess === "string" && fromAccess) {
    return fromAccess;
  }
  const aud = idClaims?.["aud"] ?? accessClaims?.["aud"];
  if (typeof aud === "string" && aud.startsWith("app_")) {
    return aud;
  }
  if (Array.isArray(aud)) {
    const appAud = aud.find((entry) => typeof entry === "string" && entry.startsWith("app_"));
    if (typeof appAud === "string") {
      return appAud;
    }
  }
  return FALLBACK_CODEX_CLIENT_ID;
}

// Coalesce concurrent refreshes for the same auth file into a single request.
const inFlightRefresh = new Map<string, Promise<OpenAiSubscriptionRefreshResult>>();

/**
 * Uses the stored refresh_token to obtain a fresh ChatGPT/Codex access token and
 * writes it back to the auth file (same shape the Codex CLI uses). The OAuth
 * issuer and client_id are derived from the existing token so we do not hardcode
 * OpenAI internals where avoidable.
 */
export function refreshOpenAiSubscriptionToken(
  options: RefreshOptions = {},
): Promise<OpenAiSubscriptionRefreshResult> {
  const env = options.env ?? process.env;
  const authFile = expandHomePath(options.authFile ?? OPENAI_CHATGPT_AUTH_DEFAULT_FILE, env);

  const existing = inFlightRefresh.get(authFile);
  if (existing) {
    return existing;
  }
  const run = performRefresh(authFile, options).finally(() => {
    inFlightRefresh.delete(authFile);
  });
  inFlightRefresh.set(authFile, run);
  return run;
}

async function performRefresh(
  authFile: string,
  options: RefreshOptions,
): Promise<OpenAiSubscriptionRefreshResult> {
  if (!existsSync(authFile)) {
    return { ok: false, error: `Auth file not found at ${authFile}.` };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: `Could not read auth file: ${error instanceof Error ? error.message : String(error)}` };
  }

  const tokens = (parsed["tokens"] && typeof parsed["tokens"] === "object"
    ? (parsed["tokens"] as Record<string, unknown>)
    : {});
  const refreshToken = typeof tokens["refresh_token"] === "string" ? tokens["refresh_token"] : undefined;
  if (!refreshToken) {
    return { ok: false, error: "No refresh_token available; sign in again." };
  }

  const accessClaims = decodeJwtClaims(typeof tokens["access_token"] === "string" ? tokens["access_token"] : null);
  const idClaims = decodeJwtClaims(typeof tokens["id_token"] === "string" ? tokens["id_token"] : null);
  const issuerClaim = (typeof accessClaims?.["iss"] === "string" && accessClaims["iss"])
    || (typeof idClaims?.["iss"] === "string" && idClaims["iss"])
    || DEFAULT_OPENAI_ISSUER;
  const issuer = String(issuerClaim).replace(/\/+$/, "");
  const clientId = resolveOAuthClientId(accessClaims, idClaims);
  const tokenUrl = `${issuer}/oauth/token`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email",
      }),
    });
  } catch (error) {
    return { ok: false, error: `Token refresh request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    return { ok: false, error: `Token refresh rejected (HTTP ${response.status}); sign in again.` };
  }

  let data: { access_token?: string; id_token?: string; refresh_token?: string };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    return { ok: false, error: "Token refresh returned an unreadable response." };
  }
  if (!data.access_token) {
    return { ok: false, error: "Token refresh response did not include an access token." };
  }

  tokens["access_token"] = data.access_token;
  if (data.id_token) {
    tokens["id_token"] = data.id_token;
  }
  let rotated = false;
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    tokens["refresh_token"] = data.refresh_token;
    rotated = true;
  }
  parsed["tokens"] = tokens;
  parsed["last_refresh"] = new Date(options.nowMs ?? Date.now()).toISOString();

  try {
    const tmp = `${authFile}.strada-refresh-tmp`;
    writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, authFile);
  } catch (error) {
    return { ok: false, error: `Refreshed token could not be saved: ${error instanceof Error ? error.message : String(error)}` };
  }

  return { ok: true, rotatedRefreshToken: rotated };
}

/**
 * Inspects the subscription auth and, when the access token has expired,
 * transparently refreshes it via the stored refresh_token before re-inspecting.
 * Returns the (still-failing) inspection when no refresh is possible so callers
 * can prompt the user to sign in again.
 */
export async function ensureOpenAiSubscriptionAuth(
  options: InspectOpenAiSubscriptionAuthOptions & { fetchImpl?: typeof fetch } = {},
): Promise<OpenAiSubscriptionAuthInspection> {
  const initial = inspectOpenAiSubscriptionAuth(options);
  if (initial.ok || initial.issue !== "expired-token") {
    return initial;
  }

  // Refresh is only meaningful for file-based auth: the refresh_token lives in the
  // auth file. When the caller supplied an explicit access token there is nothing
  // to refresh against, so surface the expired result unchanged.
  if (options.accessToken) {
    return initial;
  }

  const refreshed = await refreshOpenAiSubscriptionToken({
    authFile: options.authFile,
    env: options.env,
    fetchImpl: options.fetchImpl,
    nowMs: options.nowMs,
  });
  if (!refreshed.ok) {
    return { ...initial, detail: `${initial.detail} ${refreshed.error ?? ""}`.trim() };
  }

  // Re-read from the freshly written file; drop any stale explicit access token.
  return inspectOpenAiSubscriptionAuth({
    authFile: options.authFile,
    env: options.env,
    nowMs: options.nowMs,
    graceMs: options.graceMs,
  });
}

