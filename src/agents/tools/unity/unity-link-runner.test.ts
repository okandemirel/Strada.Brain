import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUnityLink, CONSENT_SCRIPT } from "./unity-link-runner.js";
import type { execFile } from "node:child_process";

const VALID_CODE = "authcode-1234567890abcdef";

/** A CLI-launcher stub: records the invocation; the "editor" itself is simulated by waitForOutputImpl. */
function fakeCliLauncher(): typeof execFile {
  return ((bin: string, args: string[], _opts: unknown, cb: (e: (Error & { code?: number }) | null) => void) => {
    setImmediate(() => cb(null));
    return { unref: () => {} } as unknown as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

function fakeCliLauncherFail(): typeof execFile {
  return ((bin: string, args: string[], _opts: unknown, cb: (e: (Error & { code?: number }) | null) => void) => {
    setImmediate(() => cb(Object.assign(new Error("exit"), { code: 2 })));
    return { unref: () => {} } as unknown as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

/** Stub the Node-side token exchange. */
function stubTokenExchange(): void {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ access_token: "at", refresh_token: "rt-refresh-1234567890", expires_in: 3600 }), { status: 200 }),
  );
}

describe("runUnityLink", () => {
  let fakeBinDir: string;
  let fakeCli: string;
  // NEVER the real ~/.strada store: this test used to overwrite the user's
  // live refresh token with the fixture below and leave it there — silently
  // destroying the account link on every full-suite run.
  let storePath: string;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "unity-link-test-"));
    fakeCli = join(fakeBinDir, "unity");
    writeFileSync(fakeCli, "#!/bin/sh\n");
    storePath = join(fakeBinDir, "unity-asset-store.json");
  });

  afterEach(() => {
    rmSync(fakeBinDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function outputWriter(content: unknown): (path: string, timeoutMs: number) => Promise<boolean> {
    return async (path: string) => {
      writeFileSync(path, JSON.stringify(content));
      return true;
    };
  }

  it("reports when no Unity install can be found", async () => {
    const result = await runUnityLink({
      unityCli: join(fakeBinDir, "missing-cli"),
      unityBin: join(fakeBinDir, "missing-editor"),
    });
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("unity");
  });

  it("runs the Hub-session flow, exchanges the code in Node, stores the link", async () => {
    stubTokenExchange();
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncher(),
      waitForOutputImpl: outputWriter({ code: VALID_CODE }),
      linkStorePath: storePath,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(storePath)).toBe(true);

    const stored = JSON.parse(readFileSync(storePath, "utf8"));
    expect(stored.refreshToken).toBe("rt-refresh-1234567890");
    expect(stored.packagesHost).toContain("packages");
  });

  it("refuses to write the REAL link store under test", async () => {
    stubTokenExchange();
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncher(),
      waitForOutputImpl: outputWriter({ code: VALID_CODE }),
      // no linkStorePath → would target the real ~/.strada store
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("refused under test");
  });

  it("rejects a malformed authorization-code file instead of exchanging", async () => {
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncher(),
      waitForOutputImpl: outputWriter({ code: "short" }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("authorization code");
  });

  it("surfaces an abandoned/failed consent as did-not-complete", async () => {
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncherFail(),
      waitForOutputImpl: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("did not complete");
  });
});

describe("CONSENT_SCRIPT", () => {
  it("carries the proven packman flow markers (code step only — exchange lives in Node)", () => {
    expect(CONSENT_SCRIPT).toContain('"packman"');
    expect(CONSENT_SCRIPT).toContain("GetAuthorizationCodeAsync");
    expect(CONSENT_SCRIPT).toContain("UnityEditor.Connect.UnityOAuth");
    expect(CONSENT_SCRIPT).toContain("UNITY-LINK-OK");
    // The exchange must NOT be in the editor script: UnityConnect's packages
    // config is empty outside Hub launches (measured on 6000.3.22f1).
    expect(CONSENT_SCRIPT).not.toContain("/v1/oauth2/token");
  });

  it("keeps the token exchange in the Node runner with the Hub's config", () => {
    const source = readFileSync("src/agents/tools/unity/unity-link-runner.ts", "utf8");
    expect(source).toContain("/v1/oauth2/token");
    expect(source).toContain("cloudConfig.json");
    expect(source).toContain("packman_key");
  });
});
