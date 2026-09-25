/**
 * With vault.enabled and Obsidian on, boot awaited the Unity project vault's
 * full index and the Obsidian vault's health check plus index before it went
 * on. Both now register and index in the background, the way SelfVault does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { initObsidianVaultFromBootstrap, initVaultsFromBootstrap } from "./stage-knowledge.js";
import { UnityProjectVault } from "../../vault/unity-project-vault.js";
import { ObsidianVault } from "../../vault/obsidian-vault.js";
import { VaultRegistry } from "../../vault/vault-registry.js";
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from "../../test-helpers.js";

const tmp = createTempDirTracker("strada-bg-vaults-stage-");

/** Resolves with the promise's value, or rejects if it is still pending after `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function unityProject(): string {
  const root = tmp.makeDir();
  mkdirSync(join(root, "Assets"), { recursive: true });
  mkdirSync(join(root, "ProjectSettings"), { recursive: true });
  mkdirSync(join(root, "Packages"), { recursive: true });
  writeFileSync(join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
  writeFileSync(join(root, "Packages", "manifest.json"), "{}\n");
  return root;
}

function unityInput(registry: VaultRegistry) {
  return {
    config: { vault: { enabled: true, debounceMs: 25 }, unityProjectPath: unityProject() },
    vaultRegistry: registry,
    embedding: createFakeEmbedding(),
    vectorStore: createFakeVectorStore(),
  };
}

function obsidianInput(registry: VaultRegistry) {
  return {
    config: {
      obsidian: { enabled: true, apiUrl: "http://127.0.0.1:1", apiKey: "test", vaultPath: tmp.makeDir() },
    },
    vaultRegistry: registry,
    embedding: createFakeEmbedding(),
    vectorStore: createFakeVectorStore(),
  };
}

describe("initVaultsFromBootstrap (Unity project vault)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("returns while the initial index is still running, and starts watching once it finishes", async () => {
    const init = deferred();
    vi.spyOn(UnityProjectVault.prototype, "init").mockReturnValue(init.promise);
    const startWatch = vi.spyOn(UnityProjectVault.prototype, "startWatch").mockResolvedValue(undefined);
    const registry = new VaultRegistry();

    const startup = await within(initVaultsFromBootstrap(unityInput(registry)), 2_000);

    expect(startup).toBeDefined();
    const id = startup!.vault.id;
    expect(registry.get(id)).toBe(startup!.vault);
    expect(registry.getInitState(id)).toEqual({ status: "indexing" });
    expect(startWatch).not.toHaveBeenCalled();

    init.resolve();
    await expect(startup!.ready).resolves.toBe(true);
    expect(startWatch).toHaveBeenCalledWith(25);
    expect(registry.getInitState(id)).toEqual({ status: "ready" });
    await registry.disposeAll();
  });

  it("does not start watchers when shutdown disposes the vault mid-index", async () => {
    const init = deferred();
    vi.spyOn(UnityProjectVault.prototype, "init").mockReturnValue(init.promise);
    const startWatch = vi.spyOn(UnityProjectVault.prototype, "startWatch").mockResolvedValue(undefined);
    const registry = new VaultRegistry();

    const startup = await within(initVaultsFromBootstrap(unityInput(registry)), 2_000);
    await expect(registry.disposeAll()).resolves.toBeUndefined();
    init.resolve();

    await expect(startup!.ready).resolves.toBe(false);
    expect(startWatch).not.toHaveBeenCalled();
  });

  it("reports an index failure through the registry instead of throwing into boot", async () => {
    const init = deferred();
    vi.spyOn(UnityProjectVault.prototype, "init").mockReturnValue(init.promise);
    const startWatch = vi.spyOn(UnityProjectVault.prototype, "startWatch").mockResolvedValue(undefined);
    const registry = new VaultRegistry();

    const startup = await within(initVaultsFromBootstrap(unityInput(registry)), 2_000);
    init.reject(new Error("disk went away"));

    await expect(startup!.ready).resolves.toBe(false);
    expect(startWatch).not.toHaveBeenCalled();
    expect(registry.getInitState(startup!.vault.id)).toMatchObject({ status: "error" });
    await registry.disposeAll();
  });

  it("indexes a real project in the background and a shutdown mid-index leaves nothing running", async () => {
    const registry = new VaultRegistry();
    const input = unityInput(registry);
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(input.config.unityProjectPath, "Assets", `S${i}.cs`), `public class S${i} {}\n`);
    }

    const startup = await within(initVaultsFromBootstrap(input), 2_000);
    await registry.disposeAll();

    await expect(startup!.ready).resolves.toBe(false);
    expect((startup!.vault as unknown as { watcher: unknown }).watcher).toBeNull();
  });
});

describe("initObsidianVaultFromBootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("returns while the health check and initial index are still running", async () => {
    const init = deferred();
    vi.spyOn(ObsidianVault.prototype, "init").mockReturnValue(init.promise);
    const registry = new VaultRegistry();

    const startup = await within(initObsidianVaultFromBootstrap(obsidianInput(registry)), 2_000);

    expect(startup).toBeDefined();
    const id = startup!.vault.id;
    expect(registry.get(id)).toBe(startup!.vault);
    expect(registry.getInitState(id)).toEqual({ status: "indexing" });

    init.resolve();
    await expect(startup!.ready).resolves.toBe(true);
    expect(registry.getInitState(id)).toEqual({ status: "ready" });
    await registry.disposeAll();
  });

  it("settles as not ready when shutdown disposes the vault mid-index", async () => {
    const init = deferred();
    vi.spyOn(ObsidianVault.prototype, "init").mockReturnValue(init.promise);
    const registry = new VaultRegistry();

    const startup = await within(initObsidianVaultFromBootstrap(obsidianInput(registry)), 2_000);
    await expect(registry.disposeAll()).resolves.toBeUndefined();
    init.resolve();

    await expect(startup!.ready).resolves.toBe(false);
  });

  it("is a no-op when Obsidian is disabled", async () => {
    const registry = new VaultRegistry();
    const input = obsidianInput(registry);
    const startup = await initObsidianVaultFromBootstrap({
      ...input,
      config: { obsidian: { ...input.config.obsidian, enabled: false } },
    });
    expect(startup).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});
