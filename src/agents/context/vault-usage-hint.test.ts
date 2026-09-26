/**
 * The vault hint must describe the vault the agent actually has.
 *
 * The old hint fired on the mere presence of a vault registry and said "prefer
 * vault_search over file_read". The registry is populated even when the
 * PROJECT's vault is not indexed — Strada.Brain's own self-vault always
 * registers — so the agent was told to search a vault that could only answer
 * with Strada.Brain's files.
 *
 * Measured: `vault_search` for "ModuleConfig Service SystemBase IComponent
 * EntityMediator" returned `no vault hits`; another returned five hits from
 * Strada.Brain's own analysis notes, carrying the hint "No vault indexed for
 * projectPath". The agent tried two or three times per run and then stopped
 * asking. One run spent 105 file_read, 21 list_directory and 12 glob_search
 * calls on a project whose 668 files — 341 of them Strada.Core sources — sat
 * indexed and unused.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildToolUsageHints } from "./strada-knowledge.js";
import { Orchestrator } from "../orchestrator.js";
import { VaultRegistry } from "../../vault/vault-registry.js";
import type { IVault } from "../../vault/vault.interface.js";

describe("vault usage hint", () => {
  it("states what is indexed, with counts the agent can check", () => {
    const hint = buildToolUsageHints({ indexedFileCount: 668, frameworkFileCount: 341 });

    expect(hint).toContain("668");
    expect(hint).toContain("341");
    expect(hint).toMatch(/vault_search/);
    // Framework sources are the payoff case: 341 files the agent would
    // otherwise grep through one at a time.
    expect(hint).toMatch(/Strada\.Core/);
  });

  it("does not send the agent to a vault with nothing of this project in it", () => {
    // The failure case: registry present, project not indexed. Telling the
    // agent to prefer vault_search here is what taught it to distrust the hint.
    const hint = buildToolUsageHints({ indexedFileCount: 0, frameworkFileCount: 0 });

    expect(hint).toMatch(/NOT indexed/i);
    expect(hint).toMatch(/glob_search|grep_search|file_read/);
    expect(hint).not.toMatch(/Start code and symbol lookup with `vault_search`/);
  });

  it("omits the framework clause when no framework sources are indexed", () => {
    // A plain project with no Strada.Core installed: the count would be a lie.
    const hint = buildToolUsageHints({ indexedFileCount: 40, frameworkFileCount: 0 });

    expect(hint).toContain("40");
    expect(hint).not.toMatch(/Strada\.Core/);
    expect(hint).toMatch(/vault_search/);
  });

  it("says nothing when there is no vault at all", () => {
    expect(buildToolUsageHints(undefined)).toBe("");
    expect(buildToolUsageHints()).toBe("");
  });

  it("stays silent for a bare boolean caller", () => {
    // Legacy shape carries no counts, so it cannot make a checkable claim —
    // and repeating the old unconditional line is what caused the problem.
    expect(buildToolUsageHints(true)).toBe("");
    expect(buildToolUsageHints(false)).toBe("");
  });

  it("warns that the agent's own in-task writes may be missing", () => {
    // The agent works in a leased copy while the vault watches the real project,
    // so files it writes during the task are not indexed until the lease is
    // committed. Claiming otherwise would send it to vault_search for a file it
    // just wrote and get nothing back.
    const hint = buildToolUsageHints({ indexedFileCount: 100, frameworkFileCount: 0 });
    expect(hint).toMatch(/Files you write during this task may not/i);
    expect(hint).toMatch(/file_read/);
  });
});

/** A vault holding the given repo-relative paths. */
function vaultWith(paths: string[]) {
  return {
    id: "unity:test",
    kind: "unity",
    rootPath: "/tmp/test-project",
    listFiles: () => paths.map((path) => ({ path, indexedAt: 1 })),
  };
}

function orchestratorWithVault(vault: unknown | undefined): Orchestrator {
  return orchestratorWithRegistry({
    resolveVaultForPath: () => vault,
    list: () => (vault ? [vault] : []),
  });
}

function orchestratorWithRegistry(vaultRegistry: unknown, projectPath = "/tmp/test-project"): Orchestrator {
  const provider = {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(),
    healthCheck: vi.fn(),
  };
  return new Orchestrator({
    providerManager: {
      getProvider: () => provider,
      getProviderByName: () => provider,
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      listAvailable: () => [{ name: "mock", label: "mock", defaultModel: "default" }],
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { sendMessage: vi.fn(), type: "cli" } as never,
    projectPath,
    readOnly: false,
    requireConfirmation: false,
    vaultRegistry: vaultRegistry as never,
  });
}

function systemPromptOf(orchestrator: Orchestrator): string {
  return (orchestrator as unknown as { systemPrompt: string }).systemPrompt;
}

describe("the hint reaches the system prompt with real counts", () => {
  it("counts the project's own indexed files, not the registry's existence", () => {
    // The gate that shipped inert once already: a helper added, threaded, and
    // never actually supplied with data. Asserting on buildToolUsageHints alone
    // would not catch the orchestrator failing to call it with counts.
    const orchestrator = orchestratorWithVault(
      vaultWith([
        "Assets/Modules/PixelFlow/Domain/GridPosition.cs",
        "Assets/Modules/PixelFlow/Domain/BoardSize.cs",
        "Packages/Submodules/Strada.Core/Runtime/Modules/ModuleConfig.cs",
      ]),
    );

    const prompt = systemPromptOf(orchestrator);
    expect(prompt).toMatch(/indexed in the vault: 3 files/);
    expect(prompt).toMatch(/1 framework source file/);
  });

  it("warns the agent off when the project vault is empty", () => {
    const orchestrator = orchestratorWithVault(vaultWith([]));
    expect(systemPromptOf(orchestrator)).toMatch(/NOT indexed/i);
  });

  it("says nothing when no vault owns the project path", () => {
    // The self-vault case: a registry exists, but nothing covers this project.
    const orchestrator = orchestratorWithVault(undefined);
    expect(systemPromptOf(orchestrator)).toMatch(/NOT indexed/i);
  });
});

describe("the hint follows the vault's live state (cold boot)", () => {
  it("says the vault is still indexing, not that the project is unindexed", () => {
    const hint = buildToolUsageHints({ indexedFileCount: 12, frameworkFileCount: 0, indexing: true });

    expect(hint).toMatch(/still being indexed/i);
    expect(hint).toMatch(/partial/i);
    expect(hint).not.toMatch(/NOT indexed/i);
    // No count while indexing: a partial one would read as a small project.
    expect(hint).not.toContain("12");
  });

  it("moves from not registered, to indexing, to the real counts as the registry's init settles", async () => {
    // Real registry: bootstrap registers the project vault and indexes it in
    // the background, so an orchestrator built on a cold boot first sees no
    // vault or an empty one. Its hint was computed once and said "NOT
    // indexed" for the whole session.
    const root = join(tmpdir(), "strada-vault-hint-cold-boot");
    const registry = new VaultRegistry();
    const files: Array<{ path: string; indexedAt: number }> = [];
    const vault = {
      id: "unity:coldboot",
      kind: "unity-project",
      rootPath: root,
      listFiles: () => files,
      query: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IVault;
    const orchestrator = orchestratorWithRegistry(registry, root);
    expect(systemPromptOf(orchestrator)).toMatch(/NOT indexed/i);

    registry.register(vault);
    let finishInit!: () => void;
    registry.trackInit(vault, new Promise<void>((resolve) => { finishInit = resolve; }));
    files.push({ path: "Assets/Game/Bootstrap.cs", indexedAt: 1 });
    expect(systemPromptOf(orchestrator)).toMatch(/still being indexed/i);
    expect(systemPromptOf(orchestrator)).not.toMatch(/NOT indexed/i);

    files.push(
      { path: "Assets/Game/Board.cs", indexedAt: 1 },
      { path: "Packages/Submodules/Strada.Core/Runtime/Modules/ModuleConfig.cs", indexedAt: 1 },
    );
    finishInit();
    await new Promise((resolve) => setImmediate(resolve));

    const ready = systemPromptOf(orchestrator);
    expect(ready).toMatch(/indexed in the vault: 3 files/);
    expect(ready).toMatch(/1 framework source file/);
    expect(ready).not.toMatch(/still being indexed/i);
  });
});
