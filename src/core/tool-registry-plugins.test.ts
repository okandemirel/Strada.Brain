import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { ToolRegistry, classifyRuntimeToolMetadata } from "./tool-registry.js";
import type { ITool } from "../agents/tools/tool.interface.js";

/**
 * Plugin and skill tools are code Strada did not write. They used to be
 * force-registered `readOnly: true`, which short-circuited the orchestrator's
 * write heuristic (`looksLikeWriteTool`) that exists for exactly this case:
 * a plugin `write_asmdef` {path, content} then wrote files with no
 * confirmation, stayed offered in write-disabled phases, and ran in the
 * parallel dispatch group. Audited 2026-09-02.
 */
describe("runtime-registered tool classification (audited 2026-09-02)", () => {
  let pluginRoot: string;

  beforeAll(() => {
    createLogger("error", "test.log");
    pluginRoot = mkdtempSync(join(tmpdir(), "strada-plugin-classify-"));
    const pluginDir = join(pluginRoot, "unity");
    mkdirSync(pluginDir);
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "unity", version: "1.0.0", entry: "index.js" }),
    );
    writeFileSync(
      join(pluginDir, "index.js"),
      [
        "export const tools = [",
        "  {",
        '    name: "write_asmdef",',
        '    description: "writes an asmdef",',
        '    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },',
        '    async execute() { return { content: "ok" }; },',
        "  },",
        "  {",
        '    name: "list_asmdefs",',
        '    description: "lists asmdefs",',
        '    inputSchema: { type: "object", properties: {} },',
        '    async execute() { return { content: "[]" }; },',
        "  },",
        "];",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  it("registers a plugin file writer as a write tool, not read-only", async () => {
    const registry = new ToolRegistry([pluginRoot]);
    await registry.initialize({ shellEnabled: false } as unknown as Parameters<ToolRegistry["initialize"]>[0]);

    const writer = registry.getMetadata("plugin_unity_write_asmdef");
    expect(writer).toBeDefined();
    expect(writer!.readOnly).toBe(false);
    expect(writer!.dangerous).toBe(true);
    expect(writer!.requiresConfirmation).toBe(true);

    // A genuinely read-only plugin tool keeps its read-only classification.
    const lister = registry.getMetadata("plugin_unity_list_asmdefs");
    expect(lister).toBeDefined();
    expect(lister!.readOnly).toBe(true);
    expect(lister!.dangerous).toBe(false);
  });

  it("classifies skill-shaped tools by the same heuristic (the default-on sibling)", () => {
    // Skills load unconditionally and can be agent-authored via create_skill;
    // their registrar in bootstrap stamped the same forced readOnly:true.
    const skillWriter: ITool = {
      name: "skill_asm_write_asmdef",
      description: "writes",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      execute: async () => ({ content: "ok" }),
    };
    expect(classifyRuntimeToolMetadata(skillWriter, "custom")).toMatchObject({
      category: "custom",
      readOnly: false,
      dangerous: true,
      requiresConfirmation: true,
    });

    const skillReader: ITool = {
      name: "skill_asm_inspect",
      description: "reads",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: async () => ({ content: "ok" }),
    };
    expect(classifyRuntimeToolMetadata(skillReader, "custom")).toMatchObject({
      readOnly: true,
      dangerous: false,
    });
  });

  it("honors a tool's own intrinsic isReadOnly declaration over the name heuristic", () => {
    // A plugin that knows it writes can say so even when its name does not.
    const declaredWriter: ITool = {
      name: "plugin_x_render",
      description: "renders to disk",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
      metadata: { isReadOnly: false } as unknown as ITool["metadata"],
    };
    expect(classifyRuntimeToolMetadata(declaredWriter, "code")).toMatchObject({ readOnly: false, dangerous: true });
  });
});
