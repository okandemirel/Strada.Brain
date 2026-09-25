/**
 * SelfVault's initial index walks the whole install root, measured at over
 * 150 s on a cold checkout, and boot used to wait for it. It now registers the
 * vault and indexes in the background, like the framework vaults.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { initSelfVaultFromBootstrap } from "./stage-knowledge.js";
import { SelfVault } from "../../vault/self-vault.js";
import { VaultRegistry } from "../../vault/vault-registry.js";
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from "../../test-helpers.js";

const tmp = createTempDirTracker("strada-self-vault-stage-");

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

function input(registry: VaultRegistry) {
  return {
    config: { vault: { enabled: false, debounceMs: 25 } },
    vaultRegistry: registry,
    embedding: createFakeEmbedding(),
    vectorStore: createFakeVectorStore(),
    repoRoot: tmp.makeDir(),
  };
}

describe("initSelfVaultFromBootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("returns while the initial index is still running, and starts watching once it finishes", async () => {
    const init = deferred();
    vi.spyOn(SelfVault.prototype, "init").mockReturnValue(init.promise);
    const startWatch = vi.spyOn(SelfVault.prototype, "startWatch").mockResolvedValue(undefined);
    const registry = new VaultRegistry();

    const startup = await within(initSelfVaultFromBootstrap(input(registry)), 2_000);

    expect(startup).toBeDefined();
    expect(registry.get("self:strada-brain")).toBe(startup!.vault);
    expect(registry.getInitState("self:strada-brain")).toEqual({ status: "indexing" });
    expect(startWatch).not.toHaveBeenCalled();

    init.resolve();
    await expect(startup!.ready).resolves.toBe(true);
    expect(startWatch).toHaveBeenCalledWith(25);
    expect(registry.getInitState("self:strada-brain")).toEqual({ status: "ready" });
    await registry.disposeAll();
  });

  it("reports an index failure through the registry instead of throwing into boot", async () => {
    const init = deferred();
    vi.spyOn(SelfVault.prototype, "init").mockReturnValue(init.promise);
    const startWatch = vi.spyOn(SelfVault.prototype, "startWatch").mockResolvedValue(undefined);
    const registry = new VaultRegistry();

    const startup = await within(initSelfVaultFromBootstrap(input(registry)), 2_000);
    init.reject(new Error("disk went away"));

    await expect(startup!.ready).resolves.toBe(false);
    expect(startWatch).not.toHaveBeenCalled();
    expect(registry.getInitState("self:strada-brain")).toMatchObject({ status: "error" });
    await registry.disposeAll();
  });

  it("does not start watchers when shutdown disposes the vault mid-index", async () => {
    const init = deferred();
    vi.spyOn(SelfVault.prototype, "init").mockReturnValue(init.promise);
    const startWatch = vi.spyOn(SelfVault.prototype, "startWatch").mockResolvedValue(undefined);
    const registry = new VaultRegistry();

    const startup = await within(initSelfVaultFromBootstrap(input(registry)), 2_000);
    await expect(registry.disposeAll()).resolves.toBeUndefined();
    init.resolve();

    await expect(startup!.ready).resolves.toBe(false);
    expect(startWatch).not.toHaveBeenCalled();
  });

  it("skips the vault entirely when self.enabled is false", async () => {
    const registry = new VaultRegistry();
    const startup = await initSelfVaultFromBootstrap({
      ...input(registry),
      config: { vault: { enabled: false, self: { enabled: false } } },
    });
    expect(startup).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});
