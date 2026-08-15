/**
 * A tool that cannot run should not be in the tool block.
 *
 * buildWorkerToolDefinitions already conditions the offer per run — it drops
 * control-plane tools and anything whose metadata says it is unavailable, which
 * is how Unity bridge tools disappear when the Editor is closed. The dotnet
 * tools slipped through that: their availability is resolved once, at
 * registration, from whether the CLI is on PATH. That is half the precondition.
 * A Unity project has no .sln or .csproj until the Editor has generated them,
 * and `dotnet build` without one answers MSB1003.
 *
 * Measured on two from-scratch runs: three dotnet_build calls, three MSB1003s,
 * three wasted round-trips — while unity_verify_change, which compiles
 * headlessly with no Editor at all, sat in the same tool block unused.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { Orchestrator } from "./orchestrator.js";
import { AgentPhase } from "./agent-state.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function tool(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: true },
    execute: vi.fn().mockResolvedValue({ content: "ok" }),
  };
}

let projectPath: string;

function orchestratorFor(root: string): Orchestrator {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [tool("dotnet_build"), tool("dotnet_test"), tool("unity_verify_change"), tool("file_read")] as never,
    channel: createMockChannel() as never,
    projectPath: root,
    readOnly: false,
    requireConfirmation: false,
  });
}

const offered = (orch: Orchestrator): string[] =>
  (
    orch as unknown as {
      buildWorkerToolDefinitions: (
        task: unknown,
        phase: AgentPhase,
        role: string,
      ) => Array<{ name: string }>;
    }
  )
    .buildWorkerToolDefinitions({ complexity: "simple" }, AgentPhase.EXECUTING, "executor")
    .map((d) => d.name);

beforeEach(() => {
  projectPath = mkdtempSync(join(os.tmpdir(), "tool-offer-"));
});

describe("what the model is offered", () => {
  it("leaves out dotnet tools when the project has no solution", () => {
    const names = offered(orchestratorFor(projectPath));

    expect(names, "dotnet_build was offered with nothing to build").not.toContain("dotnet_build");
    expect(names).not.toContain("dotnet_test");
  });

  it("still offers the tool that works without an Editor", () => {
    const names = offered(orchestratorFor(projectPath));

    expect(names).toContain("unity_verify_change");
    expect(names).toContain("file_read");
  });

  it("offers them once a solution exists", () => {
    writeFileSync(join(projectPath, "PixelFlow.sln"), "");
    const names = offered(orchestratorFor(projectPath));

    expect(names).toContain("dotnet_build");
    expect(names).toContain("dotnet_test");
  });

  it("offers them for a .csproj as well as a .sln", () => {
    writeFileSync(join(projectPath, "Assembly-CSharp.csproj"), "");
    expect(offered(orchestratorFor(projectPath))).toContain("dotnet_build");
  });
});
