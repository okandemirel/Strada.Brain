/**
 * vault_write_note must write into the project's vault, and only that one.
 *
 * Under a workspace lease the tool context's `projectPath` is the lease
 * directory, which no vault is registered against. The tool resolved on it,
 * missed, and fell back to "every registered vault": measured, one call wrote
 * GapAudit_2026-09-02.md into the game, the vendored Strada.Core and Strada.MCP
 * packages, the knowledge vault and Strada.Brain's own tree, and reported the
 * five writes as success.
 *
 * The registry here is the real one, so the lookup compares real paths: the
 * project is reached through a symlink and through the tmpdir's own lexical
 * form (/var vs /private/var on macOS), while its vault is registered against
 * the resolved root.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRegistry } from "../../vault/vault-registry.js";
import type { IVault } from "../../vault/vault.interface.js";
import type { ToolContext } from "./tool-core.interface.js";
import { VaultGraphExploreTool } from "./vault-graph-explore-tool.js";
import { VaultWriteNoteTool } from "./vault-write-note-tool.js";

interface FakeVault {
  id: string;
  kind: string;
  rootPath: string;
  writeFile: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  readCanvas: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

function fakeVault(id: string, kind: string, rootPath: string): FakeVault {
  return {
    id,
    kind,
    rootPath,
    writeFile: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ hits: [], budgetUsed: 0, truncated: false }),
    readCanvas: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    dispose: async () => undefined,
  };
}

let base: string;
let project: string;
let projectLink: string;
let lease: string;

beforeEach(() => {
  // Lexical tmpdir form on purpose: on macOS it is /var/..., realpath /private/var/...
  base = mkdtempSync(join(tmpdir(), "strada-vwn-lease-"));
  project = join(base, "SampleGame");
  mkdirSync(join(project, "Packages", "Submodules", "Strada.Core"), { recursive: true });
  mkdirSync(join(project, "Packages", "Submodules", "Strada.MCP"), { recursive: true });
  mkdirSync(join(project, ".strada", "knowledge"), { recursive: true });
  mkdirSync(join(base, "strada-brain"));
  projectLink = join(base, "SampleGame-link");
  symlinkSync(project, projectLink, "dir");
  lease = join(base, "strada-workspaces", "task-abc");
  mkdirSync(lease, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Every vault a campaign boot registers, the project vault optional. */
function campaignVaults(opts: { withProjectVault: boolean }): FakeVault[] {
  const vaults = [
    fakeVault("self:strada-brain", "self", join(base, "strada-brain")),
    fakeVault("generic:core", "framework", join(project, "Packages", "Submodules", "Strada.Core")),
    fakeVault("generic:mcp", "framework", join(project, "Packages", "Submodules", "Strada.MCP")),
    fakeVault("knowledge:k", "knowledge", join(project, ".strada", "knowledge")),
  ];
  if (opts.withProjectVault) {
    // Registered against the resolved root, as createAndRegister does.
    vaults.unshift(fakeVault("unity:project", "unity-project", realpathSync(project)));
  }
  return vaults;
}

function registryOf(vaults: FakeVault[]): VaultRegistry {
  const registry = new VaultRegistry();
  for (const v of vaults) registry.register(v as unknown as IVault);
  return registry;
}

function leasedContext(registry: VaultRegistry, sourceProjectPath: string | undefined): ToolContext {
  return {
    projectPath: lease,
    ...(sourceProjectPath ? { sourceProjectPath } : {}),
    workingDirectory: lease,
    readOnly: false,
    vaultRegistry: registry,
  } as unknown as ToolContext;
}

function writtenTo(vaults: FakeVault[]): string[] {
  return vaults.filter((v) => v.writeFile.mock.calls.length > 0).map((v) => v.id);
}

describe("vault_write_note under a workspace lease", () => {
  it("writes into the project vault only, resolved from the real root", async () => {
    const vaults = campaignVaults({ withProjectVault: true });

    for (const source of [project, projectLink]) {
      for (const v of vaults) v.writeFile.mockClear();
      const result = await new VaultWriteNoteTool().execute(
        { path: "analysis/GapAudit.md", content: "# Gap audit" },
        leasedContext(registryOf(vaults), source),
      );

      expect(result.isError, String(result.content)).toBeFalsy();
      expect(writtenTo(vaults), `sourceProjectPath=${source}`).toEqual(["unity:project"]);
      expect(result.content).toBe("written to unity:project");
    }
  });

  it("refuses, naming the vaults, when no vault owns the project", async () => {
    const vaults = campaignVaults({ withProjectVault: false });

    const result = await new VaultWriteNoteTool().execute(
      { path: "analysis/GapAudit.md", content: "# Gap audit" },
      leasedContext(registryOf(vaults), project),
    );

    expect(result.isError).toBe(true);
    expect(writtenTo(vaults)).toEqual([]);
    for (const v of vaults) expect(result.content).toContain(v.id);
  });

  it("does not broadcast when only the lease path is known", async () => {
    const vaults = campaignVaults({ withProjectVault: true });

    const result = await new VaultWriteNoteTool().execute(
      { path: "analysis/GapAudit.md", content: "# Gap audit" },
      leasedContext(registryOf(vaults), undefined),
    );

    expect(result.isError).toBe(true);
    expect(writtenTo(vaults)).toEqual([]);
  });

  it("does not take a Strada.Brain vault above the project for the project's", async () => {
    // A self vault that merely contains the project indexes its own files.
    const brainAbove = fakeVault("self:strada-brain", "self", base);
    const vaults = [brainAbove, ...campaignVaults({ withProjectVault: false }).slice(1)];

    const result = await new VaultWriteNoteTool().execute(
      { path: "analysis/GapAudit.md", content: "# Gap audit" },
      leasedContext(registryOf(vaults), project),
    );

    expect(result.isError).toBe(true);
    expect(writtenTo(vaults)).toEqual([]);
  });

  it("still writes to a vault named explicitly", async () => {
    const vaults = campaignVaults({ withProjectVault: false });

    const result = await new VaultWriteNoteTool().execute(
      { path: "notes/a.md", content: "x", vaultId: "knowledge:k" },
      leasedContext(registryOf(vaults), project),
    );

    expect(result.isError).toBeFalsy();
    expect(writtenTo(vaults)).toEqual(["knowledge:k"]);
  });
});

describe("vault_graph_explore under a workspace lease", () => {
  it("queries the project vault, not every vault", async () => {
    const vaults = campaignVaults({ withProjectVault: true });

    await new VaultGraphExploreTool().execute(
      { query: "MatchResolver" },
      leasedContext(registryOf(vaults), projectLink),
    );

    const queried = vaults.filter((v) => v.query.mock.calls.length > 0).map((v) => v.id);
    expect(queried).toEqual(["unity:project"]);
  });
});
