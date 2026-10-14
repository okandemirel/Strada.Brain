import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUnityLink, CONSENT_SCRIPT, editorVersion, installedEditorVersions } from "./unity-link-runner.js";
import { resolveStradaHomeEntry } from "../../../common/strada-home-entry.js";
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
  let scratchDir: string;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "unity-link-test-"));
    fakeCli = join(fakeBinDir, "unity");
    writeFileSync(fakeCli, "#!/bin/sh\n");
    storePath = join(fakeBinDir, "unity-asset-store.json");
    scratchDir = join(fakeBinDir, "scratch");
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
      scratchDir,
      unityCli: join(fakeBinDir, "missing-cli"),
      unityBin: join(fakeBinDir, "missing-editor"),
    });
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("unity");
  });

  const fakeHubConfig = () => ({
    identityHost: "https://api.unity.test",
    packagesHost: "https://packages.unity.test",
    clientSecret: "hub-secret",
  });

  it("runs the Hub-session flow, exchanges the code in Node, stores the link", async () => {
    stubTokenExchange();
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncher(),
      waitForOutputImpl: outputWriter({ code: VALID_CODE }),
      linkStorePath: storePath,
      scratchDir,
      // NEVER the real Hub config: reading it made this test pass only on
      // machines with the Hub installed (green on the dev Mac, red on CI).
      hubCloudConfigImpl: fakeHubConfig,
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
      hubCloudConfigImpl: fakeHubConfig,
      scratchDir,
      // no linkStorePath → would target the real ~/.strada store
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("refused under test");
  });

  it("refuses BEFORE building the scratch project under the real home (2026-09-17)", async () => {
    stubTokenExchange();
    const realScratch = join(resolveStradaHomeEntry("unity-link-project"), "Assets", "Editor", "StradaLinkConsent.cs");
    const before = existsSync(realScratch) ? statSync(realScratch).mtimeMs : undefined;
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncher(),
      waitForOutputImpl: outputWriter({ code: VALID_CODE }),
      hubCloudConfigImpl: fakeHubConfig,
      linkStorePath: storePath,
      // no scratchDir → would build the consent project under ~/.strada
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("scratchDir");
    const after = existsSync(realScratch) ? statSync(realScratch).mtimeMs : undefined;
    expect(after).toBe(before);
    expect(existsSync(storePath)).toBe(false);
  });

  /**
   * WHICH EDITOR VERSION the scratch project asks for.
   *
   * It used to be a literal — the version of the machine the file was written
   * on. That version goes stale on the next Hub update, and on a machine that
   * never had it the Hub refuses to open the scratch project at all. The
   * versions below are invented installs, chosen so a lexicographic sort would
   * get the order wrong.
   */
  describe("the editor version it pins the scratch project to", () => {
    const INSTALLED = ["2022.3.41f1", "6000.1.7f1", "6000.1.12f1"];

    // A developer's own machine may point these at a real project, and then
    // every case below would read that project's version instead of the
    // fixture's. Cleared here, restored after.
    const savedEnv: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const key of ["UNITY_PROJECT_PATH", "STRADA_UNITY_PROJECT"]) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    function editorsDirWith(versions: readonly string[]): string {
      const dir = join(fakeBinDir, "editors");
      mkdirSync(dir, { recursive: true });
      for (const v of versions) mkdirSync(join(dir, v, "Unity.app", "Contents", "MacOS"), { recursive: true });
      return dir;
    }

    async function linkWith(editorsDir: string): Promise<void> {
      stubTokenExchange();
      const result = await runUnityLink({
        unityCli: fakeCli,
        spawnImpl: fakeCliLauncher(),
        waitForOutputImpl: outputWriter({ code: VALID_CODE }),
        hubCloudConfigImpl: fakeHubConfig,
        linkStorePath: storePath,
        scratchDir,
        editorsDir,
      });
      expect(result.ok).toBe(true);
    }

    const pinnedVersion = (): string | undefined => {
      const file = join(scratchDir, "ProjectSettings", "ProjectVersion.txt");
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    };

    it("lists the installed versions newest first, by number and not by text", () => {
      // 6000.1.7f1 sorts ABOVE 6000.1.12f1 as text; as numbers it does not.
      expect(installedEditorVersions(editorsDirWith(INSTALLED))).toEqual([
        "6000.1.12f1",
        "6000.1.7f1",
        "2022.3.41f1",
      ]);
    });

    it("pins the newest editor actually installed", async () => {
      await linkWith(editorsDirWith(INSTALLED));

      expect(pinnedVersion()).toBe("m_EditorVersion: 6000.1.12f1\n");
    });

    it("prefers the configured project's own version over what is installed", async () => {
      const projectRoot = join(fakeBinDir, "configured-project");
      mkdirSync(join(projectRoot, "ProjectSettings"), { recursive: true });
      writeFileSync(join(projectRoot, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2023.2.20f1\n");
      process.env["UNITY_PROJECT_PATH"] = projectRoot;

      await linkWith(editorsDirWith(INSTALLED));

      expect(pinnedVersion()).toBe("m_EditorVersion: 2023.2.20f1\n");
    });

    it("writes no ProjectVersion.txt when no editor is installed, and lets the Hub choose", async () => {
      await linkWith(editorsDirWith([]));

      expect(pinnedVersion()).toBeUndefined();
      expect(editorVersion(join(fakeBinDir, "editors"))).toBeUndefined();
    });
  });

  it("rejects a malformed authorization-code file instead of exchanging", async () => {
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncher(),
      waitForOutputImpl: outputWriter({ code: "short" }),
      linkStorePath: storePath,
      scratchDir,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("authorization code");
  });

  it("surfaces an abandoned/failed consent as did-not-complete", async () => {
    const result = await runUnityLink({
      unityCli: fakeCli,
      spawnImpl: fakeCliLauncherFail(),
      waitForOutputImpl: async () => false,
      linkStorePath: storePath,
      scratchDir,
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
    // config is empty outside Hub launches (measured on a Unity 6.3 editor).
    expect(CONSENT_SCRIPT).not.toContain("/v1/oauth2/token");
  });

  it("keeps the token exchange in the Node runner with the Hub's config", () => {
    const source = readFileSync("src/agents/tools/unity/unity-link-runner.ts", "utf8");
    expect(source).toContain("/v1/oauth2/token");
    expect(source).toContain("cloudConfig.json");
    expect(source).toContain("packman_key");
  });
});
