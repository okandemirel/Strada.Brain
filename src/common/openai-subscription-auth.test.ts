import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeJwtExpiryMs,
  inspectOpenAiSubscriptionAuth,
  refreshOpenAiSubscriptionToken,
  ensureOpenAiSubscriptionAuth,
} from "./openai-subscription-auth.js";

function createJwt(expSecondsFromNow: number, extraClaims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    ...extraClaims,
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("openai subscription auth helpers", () => {
  it("decodes JWT expiry timestamps", () => {
    const token = createJwt(600);
    const expiryMs = decodeJwtExpiryMs(token);
    expect(expiryMs).not.toBeNull();
    expect(expiryMs!).toBeGreaterThan(Date.now());
  });

  it("marks expired subscription tokens as invalid", () => {
    const inspection = inspectOpenAiSubscriptionAuth({
      accessToken: createJwt(-300),
      accountId: "acct_test",
    });

    expect(inspection.ok).toBe(false);
    expect(inspection.issue).toBe("expired-token");
  });
});

describe("openai subscription token refresh", () => {
  let tmpDir: string;
  let authFile: string;

  const ISS = "https://auth.openai.com";
  const CLIENT_ID = "app_TESTclient";

  function writeAuthFile(accessExpSeconds: number, opts: { refreshToken?: string | null } = {}): void {
    const tokens: Record<string, unknown> = {
      access_token: createJwt(accessExpSeconds, { iss: ISS, client_id: CLIENT_ID }),
      id_token: createJwt(accessExpSeconds, { iss: ISS, aud: [CLIENT_ID] }),
      account_id: "acct_test",
    };
    if (opts.refreshToken !== null) {
      tokens["refresh_token"] = opts.refreshToken ?? "rt_original";
    }
    fs.writeFileSync(authFile, JSON.stringify({ tokens, last_refresh: "2026-01-01T00:00:00.000Z" }, null, 2));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-codex-auth-"));
    authFile = path.join(tmpDir, "auth.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("refreshes an expired token using the stored refresh_token and writes it back", async () => {
    writeAuthFile(-300);
    const fresh = createJwt(3600, { iss: ISS, client_id: CLIENT_ID });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: fresh, refresh_token: "rt_rotated" }),
    });

    const result = await refreshOpenAiSubscriptionToken({ authFile, fetchImpl: fetchImpl as never });
    expect(result.ok).toBe(true);
    expect(result.rotatedRefreshToken).toBe(true);

    // Derived the OAuth endpoint + client_id from the token, not hardcoded.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ISS}/oauth/token`);
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "rt_original" });

    const saved = JSON.parse(fs.readFileSync(authFile, "utf8"));
    expect(saved.tokens.access_token).toBe(fresh);
    expect(saved.tokens.refresh_token).toBe("rt_rotated");
    expect(saved.last_refresh).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("fails to refresh when no refresh_token is present", async () => {
    writeAuthFile(-300, { refreshToken: null });
    const fetchImpl = vi.fn();
    const result = await refreshOpenAiSubscriptionToken({ authFile, fetchImpl: fetchImpl as never });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails to refresh on an HTTP error and leaves the auth file untouched", async () => {
    writeAuthFile(-300);
    const before = fs.readFileSync(authFile, "utf8");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const result = await refreshOpenAiSubscriptionToken({ authFile, fetchImpl: fetchImpl as never });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
    expect(fs.readFileSync(authFile, "utf8")).toBe(before);
  });

  it("ensureOpenAiSubscriptionAuth auto-refreshes an expired session and returns ok", async () => {
    writeAuthFile(-300);
    const fresh = createJwt(3600, { iss: ISS, client_id: CLIENT_ID });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: fresh }),
    });

    const inspection = await ensureOpenAiSubscriptionAuth({ authFile, fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(inspection.ok).toBe(true);
    expect(inspection.accessToken).toBe(fresh);
    expect(inspection.accountId).toBe("acct_test");
  });

  it("ensureOpenAiSubscriptionAuth does not refresh a still-valid session", async () => {
    writeAuthFile(3600);
    const fetchImpl = vi.fn();
    const inspection = await ensureOpenAiSubscriptionAuth({ authFile, fetchImpl: fetchImpl as never });
    expect(inspection.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ensureOpenAiSubscriptionAuth surfaces a failure when refresh is rejected", async () => {
    writeAuthFile(-300);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const inspection = await ensureOpenAiSubscriptionAuth({ authFile, fetchImpl: fetchImpl as never });
    expect(inspection.ok).toBe(false);
    expect(inspection.issue).toBe("expired-token");
  });
});

