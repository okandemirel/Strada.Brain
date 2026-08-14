/**
 * A module without a test assembly is not the shape the framework declares.
 *
 * Strada.Core's DirectoryStructureConfig lists RuntimeTests and EditorTests as
 * module component types, and the agent preamble states that a module must carry
 * its own Tests/Runtime to exist at all. strada_create_module disagreed: it
 * filed include_tests among the optional extras (Views/, Data/), defaulted it
 * off, and described it as "a Tests/ folder".
 *
 * Measured on a from-scratch run: three well-chosen modules — Board, Input,
 * Presentation — and not one Tests folder between them. The agent had no reason
 * to pass a flag it was never told it needed, so every module it generated was
 * born untestable, and the conformance guard's untestedAssemblies check then
 * had to report the tool's own output as non-conformant.
 *
 * Tests are part of a module, so they are the default. Passing false is still
 * honoured for the cases that genuinely have nothing to test.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createLogger } from "../../../utils/logger.js";
import { ModuleCreateTool } from "./module-create.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const create = async (input: Record<string, unknown>) => {
  const projectPath = mkdtempSync(join(os.tmpdir(), "module-create-tests-"));
  const result = await new ModuleCreateTool().execute(input, { projectPath } as never);
  expect(result.isError, `refused: ${result.content}`).toBeFalsy();
  return join(projectPath, "Assets", "Modules", `${String(input["name"])}Module`);
};

describe("a generated module's tests", () => {
  it("carries Tests/Runtime and Tests/Editor without being asked", async () => {
    const base = await create({ name: "Board" });

    expect(existsSync(join(base, "Tests", "Runtime"))).toBe(true);
    expect(existsSync(join(base, "Tests", "Editor"))).toBe(true);
  });

  it("gives each test folder its own assembly", async () => {
    // Two assemblies, not one: an edit-mode test cannot live in a runtime
    // assembly, and a runtime test assembly must not be Editor-constrained.
    const base = await create({ name: "Board" });

    const runtime = readdirSync(join(base, "Tests", "Runtime"));
    const editor = readdirSync(join(base, "Tests", "Editor"));

    expect(runtime.filter((f) => f.endsWith(".Tests.asmdef"))).toHaveLength(1);
    expect(editor.filter((f) => f.endsWith(".Editor.Tests.asmdef"))).toHaveLength(1);
  });

  it("still omits them when explicitly told to", async () => {
    const base = await create({ name: "Board", include_tests: false });

    expect(existsSync(join(base, "Tests"))).toBe(false);
  });
});
