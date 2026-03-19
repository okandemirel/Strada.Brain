import { describe, expect, it } from "vitest";
import {
  decodeJwtExpiryMs,
  inspectOpenAiSubscriptionAuth,
} from "./openai-subscription-auth.js";

function createJwt(expSecondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
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

