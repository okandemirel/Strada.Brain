/**
 * PRV-3: a subscription seat has no API key, so its health identity was
 * `…|nokey` whatever token it ran on. A bench earned by a token the server
 * rotated then survived `codex login` and a restart, against a token that had
 * earned nothing. The subscription token now feeds the fingerprint.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatCredentialSecret } from "./subscription-credential.js";
import { ProviderHealthRegistry } from "./provider-health.js";

const URL = "https://chatgpt.com/backend-api/codex";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seat-cred-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function codexAuthFile(accessToken: string): string {
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ tokens: { access_token: accessToken, account_id: "acct-1" } }));
  return file;
}

const identityFor = (secret: string | undefined): string =>
  ProviderHealthRegistry.seatIdentity(URL, "gpt-5.4", secret);

describe("a subscription seat's identity follows its token", () => {
  it("a ChatGPT/Codex re-login (new token in the auth file) is a new seat identity", () => {
    const credential = { openaiAuthMode: "chatgpt-subscription" as const, openaiChatgptAuthFile: codexAuthFile("token-before") };
    const before = identityFor(seatCredentialSecret("openai", credential, undefined));
    codexAuthFile("token-after");
    const after = identityFor(seatCredentialSecret("openai", credential, undefined));

    expect(before).not.toMatch(/\|nokey$/u);
    expect(after).not.toBe(before);
    // The file only ever holds a fingerprint, never token material.
    expect(after).not.toContain("token-after");
  });

  it("an unchanged token keeps the identity, so a real bench survives a restart", () => {
    const credential = { openaiAuthMode: "chatgpt-subscription" as const, openaiChatgptAuthFile: codexAuthFile("same-token") };
    expect(identityFor(seatCredentialSecret("openai", credential, undefined)))
      .toBe(identityFor(seatCredentialSecret("openai", credential, undefined)));
  });

  it("a Claude subscription is fingerprinted by its bearer token", () => {
    const a = seatCredentialSecret("claude", { anthropicAuthMode: "claude-subscription", anthropicAuthToken: "tok-a" }, undefined);
    const b = seatCredentialSecret("claude", { anthropicAuthMode: "claude-subscription", anthropicAuthToken: "tok-b" }, undefined);
    expect(a).toBeDefined();
    expect(identityFor(a)).not.toBe(identityFor(b));
  });

  it("an API-key seat is still fingerprinted by its key", () => {
    expect(seatCredentialSecret("deepseek", { apiKey: "sk-1" }, "sk-1")).toBe("sk-1");
    expect(seatCredentialSecret("claude", { apiKey: "sk-ant" }, "sk-ant")).toBe("sk-ant");
  });

  it("a subscription with no readable token falls back to no fingerprint", () => {
    const credential = { openaiAuthMode: "chatgpt-subscription" as const, openaiChatgptAuthFile: join(dir, "missing.json") };
    expect(seatCredentialSecret("openai", credential, undefined)).toBeUndefined();
  });
});
