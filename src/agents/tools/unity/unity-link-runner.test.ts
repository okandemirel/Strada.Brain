import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { runUnityLink, CONSENT_SCRIPT } from "./unity-link-runner.js";
import type { execFile } from "node:child_process";

const VALID_LINK = {
  refreshToken: "rt-abcdefghij1234567890",
  identityHost: "https://api.unity.com",
  packagesHost: "https://packages-v2.unity.com",
  clientSecret: "packman-secret",
  linkedAt: 1787865600000,
};

/** A spawn stub that "runs Unity" by writing the link output and exiting 0. */
function fakeSpawnOk(output: unknown = VALID_LINK): typeof execFile {
  return ((bin: string, args: string[], _opts: unknown, cb: (e: (Error & { code?: number }) | null) => void) => {
    const outIdx = args.indexOf("-linkOutput");
    const outPath = args[outIdx + 1]!;
    writeFileSync(outPath, JSON.stringify(output));
    setImmediate(() => cb(null));
    return { unref: () => {} } as unknown as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

function fakeSpawnFail(code = 1): typeof execFile {
  return ((bin: string, args: string[], _opts: unknown, cb: (e: (Error & { code?: number }) | null) => void) => {
    const err = Object.assign(new Error("exit"), { code });
    setImmediate(() => cb(err));
    return { unref: () => {} } as unknown as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

describe("runUnityLink", () => {
  let fakeBinDir: string;
  let fakeBin: string;
  const storePath = join(homedir(), ".strada", "unity-asset-store.json");
  let hadStoreBefore: boolean;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "unity-link-test-"));
    fakeBin = join(fakeBinDir, "Unity");
    writeFileSync(fakeBin, "#!/bin/sh\n");
    hadStoreBefore = existsSync(storePath);
  });

  afterEach(() => {
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it("reports when the Unity binary does not exist", async () => {
    const result = await runUnityLink({ unityBin: join(fakeBinDir, "missing-unity") });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not found");
  });

  it("runs the consent flow and stores a validated token file", async () => {
    const result = await runUnityLink({ unityBin: fakeBin, spawnImpl: fakeSpawnOk() });
    expect(result.ok).toBe(true);
    expect(existsSync(storePath)).toBe(true);

    const stored = JSON.parse(readFileSync(storePath, "utf8"));
    expect(stored.refreshToken).toBe(VALID_LINK.refreshToken);
    expect(stored.packagesHost).toBe(VALID_LINK.packagesHost);
    if (!hadStoreBefore) rmSync(storePath, { force: true });
  });

  it("rejects an invalid token file instead of storing it", async () => {
    const result = await runUnityLink({
      unityBin: fakeBin,
      spawnImpl: fakeSpawnOk({ refreshToken: "short", identityHost: "not-a-url" }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("invalid");
  });

  it("surfaces a failing editor run with the log markers", async () => {
    const result = await runUnityLink({ unityBin: fakeBin, spawnImpl: fakeSpawnFail(2) });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exit 2");
  });
});

describe("CONSENT_SCRIPT", () => {
  it("carries the proven packman flow markers", () => {
    expect(CONSENT_SCRIPT).toContain('"packman"');
    expect(CONSENT_SCRIPT).toContain("GetAuthorizationCodeAsync");
    expect(CONSENT_SCRIPT).toContain("/v1/oauth2/token");
    expect(CONSENT_SCRIPT).toContain("UnityEditor.Connect.UnityConnect");
    expect(CONSENT_SCRIPT).toContain("UNITY-LINK-OK");
  });
});
