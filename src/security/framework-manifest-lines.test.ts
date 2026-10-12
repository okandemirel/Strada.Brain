/**
 * The Strada package lines of Packages/manifest.json are the installer's (WP-1.2).
 *
 * The package folders under Packages/Submodules/Strada.* are refused to
 * agents, but the manifest was not. A worker that followed an install recipe
 * (the package folder plus `"com.strada.modules": "file:Submodules/Strada.Modules"`)
 * ended with the folder refused or quarantined and the manifest line
 * published: the project's manifest then pointed at a package that never
 * landed, and Unity fails to resolve every package of a project like that.
 * Measured with a temp-copy lease: written=[Packages/manifest.json], both
 * package files quarantined.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { FileWriteTool } from "../agents/tools/file-write.js";
import { FileEditTool } from "../agents/tools/file-edit.js";
import { FileDeleteTool, FileRenameTool } from "../agents/tools/file-manage.js";
import { WorkspaceLeaseManager } from "../agents/multi/workspace-lease-manager.js";
import { LEASE_WRITTEN_LEDGER, systemOwnedDeletionReason } from "../agents/multi/system-owned-path.js";
import type { ToolContext } from "../agents/tools/tool.interface.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const MANIFEST = join("Packages", "manifest.json");
const ORIGINAL = `{
  "dependencies": {
    "com.strada.core": "file:Submodules/Strada.Core",
    "com.unity.ugui": "2.0.0"
  }
}
`;
const WITH_MODULES = ORIGINAL.replace(
  '"com.unity.ugui": "2.0.0"',
  '"com.unity.ugui": "2.0.0",\n    "com.strada.modules": "file:Submodules/Strada.Modules"',
);
const MODULES_FILE = join("Packages", "Submodules", "Strada.Modules", "package.json");

let project: string;
let ctx: ToolContext;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "manifest-lines-"));
  mkdirSync(join(project, "Packages", "Submodules", "Strada.Core"), { recursive: true });
  mkdirSync(join(project, "Assets", "Scripts"), { recursive: true });
  writeFileSync(join(project, "Packages", "Submodules", "Strada.Core", "package.json"), '{"name":"com.strada.core"}\n');
  writeFileSync(join(project, MANIFEST), ORIGINAL);
  ctx = { projectPath: project, workingDirectory: project, readOnly: false };
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const manifestNow = (): string => readFileSync(join(project, MANIFEST), "utf8");

describe("the file tools leave the Strada lines of the manifest to the installer", () => {
  it("file_write that adds a Strada package line is refused, naming the installer", async () => {
    const result = await new FileWriteTool().execute({ path: "Packages/manifest.json", content: WITH_MODULES }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('adds "com.strada.modules"');
    expect(result.content).toContain("dependency installer");
    expect(manifestNow()).toBe(ORIGINAL);
  });

  it("file_edit that adds, repoints or removes one is refused", async () => {
    const edit = new FileEditTool();
    const add = await edit.execute(
      {
        path: "Packages/manifest.json",
        old_string: '"com.unity.ugui": "2.0.0"',
        new_string: '"com.unity.ugui": "2.0.0",\n    "com.strada.modules": "file:Submodules/Strada.Modules"',
      },
      ctx,
    );
    const repoint = await edit.execute(
      { path: "Packages/manifest.json", old_string: "file:Submodules/Strada.Core", new_string: "file:../../Strada.Core" },
      ctx,
    );
    const remove = await edit.execute(
      { path: "Packages/manifest.json", old_string: '    "com.strada.core": "file:Submodules/Strada.Core",\n', new_string: "" },
      ctx,
    );

    expect(add.isError).toBe(true);
    expect(repoint.isError).toBe(true);
    expect(repoint.content).toContain('repoints "com.strada.core"');
    expect(remove.isError).toBe(true);
    expect(remove.content).toContain('removes "com.strada.core"');
    expect(manifestNow()).toBe(ORIGINAL);
  });

  it("file_delete of the manifest, and a rename onto it, are refused", async () => {
    expect((await new FileDeleteTool().execute({ path: "Packages/manifest.json", force: true }, ctx)).isError).toBe(true);
    writeFileSync(join(project, "Assets", "Scripts", "manifest.json"), WITH_MODULES);
    const rename = await new FileRenameTool().execute(
      { old_path: "Assets/Scripts/manifest.json", new_path: "Packages/manifest.json", overwrite: true },
      ctx,
    );
    expect(rename.isError).toBe(true);
    expect(manifestNow()).toBe(ORIGINAL);
  });

  it("an edit that leaves the Strada lines alone still lands (guard)", async () => {
    const result = await new FileEditTool().execute(
      { path: "Packages/manifest.json", old_string: '"com.unity.ugui": "2.0.0"', new_string: '"com.unity.ugui": "2.1.0"' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(manifestNow()).toContain('"com.unity.ugui": "2.1.0"');
    expect(manifestNow()).toContain('"com.strada.core": "file:Submodules/Strada.Core"');
  });
});

describe("a lease never publishes a manifest whose Strada lines changed", () => {
  it("the package is quarantined and so is the manifest line that would point at it", async () => {
    const leaseRoot = mkdtempSync(join(tmpdir(), "manifest-lines-lease-"));
    try {
      const manager = new WorkspaceLeaseManager({ projectRoot: project, leaseRoot, preferGitWorktree: false });
      const lease = await manager.acquireLease({ label: "t", forceTempCopy: true });
      // What a worker following a hand-install recipe does through the shell.
      mkdirSync(join(lease.path, "Packages", "Submodules", "Strada.Modules"), { recursive: true });
      writeFileSync(join(lease.path, MODULES_FILE), '{"name":"com.strada.modules"}\n');
      writeFileSync(join(lease.path, MANIFEST), WITH_MODULES);
      writeFileSync(join(lease.path, "Assets", "Scripts", "Board.cs"), "// board\n");

      const result = await lease.commit();
      await lease.release();

      expect(manifestNow()).toBe(ORIGINAL);
      expect(existsSync(join(project, MODULES_FILE))).toBe(false);
      expect(result.written).toEqual([join("Assets", "Scripts", "Board.cs")]);
      expect([...(result.refusedFrameworkPackage ?? [])].sort()).toEqual([MANIFEST, MODULES_FILE].sort());
      expect(readFileSync(join(result.conflictsQuarantinedUnder!, MANIFEST), "utf8")).toBe(WITH_MODULES);
    } finally {
      rmSync(leaseRoot, { recursive: true, force: true });
    }
  });

  it("a manifest change that leaves the Strada lines alone is published (guard)", async () => {
    const leaseRoot = mkdtempSync(join(tmpdir(), "manifest-lines-lease-"));
    try {
      const manager = new WorkspaceLeaseManager({ projectRoot: project, leaseRoot, preferGitWorktree: false });
      const lease = await manager.acquireLease({ label: "t", forceTempCopy: true });
      const bumped = ORIGINAL.replace('"com.unity.ugui": "2.0.0"', '"com.unity.ugui": "2.1.0"');
      writeFileSync(join(lease.path, MANIFEST), bumped);

      const result = await lease.commit();
      await lease.release();

      expect(result.written).toEqual([MANIFEST]);
      expect(manifestNow()).toBe(bumped);
    } finally {
      rmSync(leaseRoot, { recursive: true, force: true });
    }
  });

  it("a lease never deletes a manifest that carries Strada lines, even one a lease wrote", async () => {
    // Every commit that touched it was a campaign's, and the ledger agrees:
    // without the manifest rule that reads as the system's own file.
    const campaignOnly = async () => ({ exitCode: 0, stdout: "campaign: add the input package\n" });
    mkdirSync(join(project, ".strada"), { recursive: true });
    writeFileSync(join(project, LEASE_WRITTEN_LEDGER), "Packages/manifest.json\n");
    expect(await systemOwnedDeletionReason(campaignOnly, project, MANIFEST)).toBeUndefined();
    // A manifest with no Strada line is judged as before (guard).
    writeFileSync(join(project, MANIFEST), '{ "dependencies": { "com.unity.ugui": "2.0.0" } }\n');
    expect(await systemOwnedDeletionReason(campaignOnly, project, MANIFEST)).toContain("system's own");
  });
});
