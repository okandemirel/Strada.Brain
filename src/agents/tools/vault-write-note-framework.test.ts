/**
 * vault_write_note writes only where the file tools would (WP-1.2).
 *
 * The tool writes through a vault's own root, past validatePath and the
 * lease. Given a vaultId it wrote into any registered vault: reproduced, with
 * the vendored Strada.Core's framework vault it put Runtime/Patched.cs and a
 * sprint report into Packages/Submodules/Strada.Core and indexed them as the
 * framework, and since the framework vaults can be rooted at the upstream
 * checkouts beside the install, it could write into those repositories too.
 * Its own "no vault for this project" error listed those vault ids to pick.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRegistry } from "../../vault/vault-registry.js";
import type { IVault } from "../../vault/vault.interface.js";
import type { ToolContext } from "./tool-core.interface.js";
import { VaultWriteNoteTool } from "./vault-write-note-tool.js";

interface FakeVault {
  id: string;
  kind: string;
  rootPath: string;
  writeFile: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

function fakeVault(id: string, kind: string, rootPath: string): FakeVault {
  return { id, kind, rootPath, writeFile: vi.fn().mockResolvedValue(undefined), dispose: async () => undefined };
}

let base: string;
let project: string;
let lease: string;
let vaults: FakeVault[];

beforeEach(() => {
  // The lexical tmpdir form on purpose: /var/... on macOS, /private/var/... real.
  base = mkdtempSync(join(tmpdir(), "strada-vwn-framework-"));
  project = join(base, "WidgetShop");
  mkdirSync(join(project, "Packages", "Submodules", "Strada.Core", "Runtime"), { recursive: true });
  mkdirSync(join(project, ".strada", "knowledge"), { recursive: true });
  writeFileSync(
    join(project, "Packages", "manifest.json"),
    '{ "dependencies": { "com.strada.core": "file:Submodules/Strada.Core" } }\n',
  );
  mkdirSync(join(base, "Strada.Modules"));
  mkdirSync(join(base, "strada-brain"));
  lease = join(base, "workspaces", "task-1");
  mkdirSync(lease, { recursive: true });
  vaults = [
    fakeVault("unity:project", "unity-project", project),
    fakeVault("knowledge:k", "knowledge", join(project, ".strada", "knowledge")),
    // What bootstrap registers for the frameworks: the vendored copy, and an
    // upstream checkout beside the install.
    fakeVault("generic:vendoredcore", "unity-project", join(project, "Packages", "Submodules", "Strada.Core")),
    fakeVault("generic:modulescheckout", "unity-project", join(base, "Strada.Modules")),
    fakeVault("self:strada-brain", "self", join(base, "strada-brain")),
  ];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function registry(only?: string[]): VaultRegistry {
  const r = new VaultRegistry();
  for (const v of vaults) if (!only || only.includes(v.id)) r.register(v as unknown as IVault);
  return r;
}

function direct(reg: VaultRegistry): ToolContext {
  return { projectPath: project, workingDirectory: project, readOnly: false, vaultRegistry: reg } as unknown as ToolContext;
}

function leased(reg: VaultRegistry): ToolContext {
  return {
    projectPath: lease,
    sourceProjectPath: project,
    workingDirectory: lease,
    readOnly: false,
    vaultRegistry: reg,
  } as unknown as ToolContext;
}

const written = (): string[] => vaults.filter((v) => v.writeFile.mock.calls.length > 0).map((v) => v.id);

describe("vault_write_note refuses what the file tools refuse", () => {
  it("never writes into a framework vault, vendored or checked out, nor a vault outside the project", async () => {
    for (const context of [direct(registry()), leased(registry())]) {
      for (const vaultId of ["generic:vendoredcore", "generic:modulescheckout", "self:strada-brain"]) {
        for (const path of ["Runtime/Patched.cs", "docs/sprint-report.md"]) {
          const result = await new VaultWriteNoteTool().execute({ path, content: "# x", vaultId }, context);
          expect(result.isError, `${vaultId} ${path}`).toBe(true);
        }
      }
    }
    expect(written()).toEqual([]);
  });

  it("names why: the framework is read, not written; a vault outside the project is not the project's", async () => {
    const vendored = await new VaultWriteNoteTool().execute(
      { path: "Runtime/Patched.cs", content: "// patch", vaultId: "generic:vendoredcore" },
      direct(registry()),
    );
    const checkout = await new VaultWriteNoteTool().execute(
      { path: "notes/run.md", content: "# run", vaultId: "generic:modulescheckout" },
      direct(registry()),
    );

    expect(vendored.content).toContain("framework package");
    expect(checkout.content).toContain("outside this project");
  });

  it("does not reach a framework package or the manifest's Strada lines through the project's own vault", async () => {
    const tool = new VaultWriteNoteTool();
    const intoPackage = await tool.execute(
      { path: "Packages/Submodules/Strada.Core/Runtime/Patched.cs", content: "// patch" },
      leased(registry()),
    );
    const manifest = await tool.execute(
      {
        path: "Packages/manifest.json",
        content: '{ "dependencies": { "com.strada.core": "file:Submodules/Strada.Core", "com.strada.modules": "file:Submodules/Strada.Modules" } }\n',
      },
      direct(registry()),
    );

    expect(intoPackage.isError).toBe(true);
    expect(manifest.isError).toBe(true);
    expect(manifest.content).toContain('adds "com.strada.modules"');
    expect(written()).toEqual([]);
  });

  it("does not offer a framework vault when no vault owns the project", async () => {
    const result = await new VaultWriteNoteTool().execute(
      { path: "analysis/GapAudit.md", content: "# Gap audit" },
      leased(registry(["generic:vendoredcore", "generic:modulescheckout", "self:strada-brain", "knowledge:k"])),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("knowledge:k");
    for (const id of ["generic:vendoredcore", "generic:modulescheckout", "self:strada-brain"]) {
      expect(result.content).not.toContain(id);
    }
  });

  it("still writes a note into the project's vault and its knowledge vault (guard)", async () => {
    const tool = new VaultWriteNoteTool();
    const note = await tool.execute({ path: "analysis/GapAudit.md", content: "# Gap audit" }, leased(registry()));
    const knowledge = await tool.execute(
      { path: "notes/a.md", content: "x", vaultId: "knowledge:k" },
      direct(registry()),
    );

    expect(note.isError, String(note.content)).toBeFalsy();
    expect(knowledge.isError, String(knowledge.content)).toBeFalsy();
    expect(written().sort()).toEqual(["knowledge:k", "unity:project"]);
  });
});
