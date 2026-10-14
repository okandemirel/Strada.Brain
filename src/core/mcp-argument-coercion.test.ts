/**
 * A VALUE THE MODEL SENT AS TEXT, FOR A FIELD THAT IS NOT TEXT.
 *
 * Measured in a live run (2026-10-14): a worker called unity_scene_build with
 * its whole `spec` object JSON-encoded as a string and `emitBootTest` as
 * `"true"`. The tool answered "pass either `spec` (an object) or `specPath`",
 * the worker sent the same shape twice more, and the sprint spent three turns
 * without building its scene.
 *
 * What the schema declares is converted; nothing else is touched.
 */
import { describe, it, expect, vi } from "vitest";
import { coerceDeclaredTypes, registerStradaMcpTools } from "./strada-mcp-tool-loader.js";
import type { ITool, ToolContext } from "../agents/tools/tool.interface.js";

const SCENE_BUILD_SCHEMA = {
  type: "object",
  properties: {
    spec: { type: "object" },
    specPath: { type: "string" },
    emitBootTest: { type: "boolean" },
    angles: { type: "integer" },
    scale: { type: "number" },
    tags: { type: "array" },
    note: { type: "string" },
  },
};

describe("coerceDeclaredTypes", () => {
  it("reads the call the live run failed on", () => {
    const spec = { specVersion: 1, scene: { path: "Assets/Scenes/Boot.unity", addToBuildSettings: true } };
    expect(
      coerceDeclaredTypes({ spec: JSON.stringify(spec), emitBootTest: "true" }, SCENE_BUILD_SCHEMA),
    ).toEqual({ spec, emitBootTest: true });
  });

  it("converts each declared kind, and only from text that really is one", () => {
    expect(
      coerceDeclaredTypes(
        { tags: '["a","b"]', angles: "6", scale: "1.5", emitBootTest: "false" },
        SCENE_BUILD_SCHEMA,
      ),
    ).toEqual({ tags: ["a", "b"], angles: 6, scale: 1.5, emitBootTest: false });
  });

  it("leaves a declared string alone, even when it looks like JSON", () => {
    const input = { specPath: '{"not": "a path"}', note: "42" };
    expect(coerceDeclaredTypes(input, SCENE_BUILD_SCHEMA)).toBe(input);
  });

  it("passes through text that does not convert, so the tool still answers for it", () => {
    const broken = { spec: "{ not json", emitBootTest: "yes", angles: "six", tags: "a, b" };
    expect(coerceDeclaredTypes(broken, SCENE_BUILD_SCHEMA)).toBe(broken);
  });

  it("does not take an array for an object, nor an object for an array", () => {
    const swapped = { spec: '["a"]', tags: '{"a":1}' };
    expect(coerceDeclaredTypes(swapped, SCENE_BUILD_SCHEMA)).toBe(swapped);
  });

  it("keeps a fractional value out of an integer field", () => {
    expect(coerceDeclaredTypes({ angles: "2.5" }, SCENE_BUILD_SCHEMA)).toEqual({ angles: "2.5" });
    expect(coerceDeclaredTypes({ scale: "2.5" }, SCENE_BUILD_SCHEMA)).toEqual({ scale: 2.5 });
  });

  it("invents no key and touches nothing a schema does not declare", () => {
    const unknown = { whatever: '{"a":1}', spec: '{"a":1}' };
    expect(coerceDeclaredTypes(unknown, SCENE_BUILD_SCHEMA)).toEqual({ whatever: '{"a":1}', spec: { a: 1 } });
  });

  it("returns the input untouched when the schema declares no properties", () => {
    const input = { spec: '{"a":1}' };
    expect(coerceDeclaredTypes(input, { type: "object" })).toBe(input);
    expect(coerceDeclaredTypes(input, {})).toBe(input);
  });

  it("accepts a union type the way the schema writes it", () => {
    const schema = { properties: { value: { type: ["object", "null"] } } };
    expect(coerceDeclaredTypes({ value: '{"a":1}' }, schema)).toEqual({ value: { a: 1 } });
  });
});

/**
 * …AND THE ADAPTER THAT DISPATCHES THE CALL USES IT. The conversion above is
 * worth nothing if the adapter hands the model's own arguments to the tool,
 * which is how it was written before: the fix existed and was not wired.
 */
describe("the registered adapter converts before it calls the tool", () => {
  function registeredTool(): { tool: ITool; execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn().mockResolvedValue({ content: "ok" });
    let registered: ITool | undefined;
    registerStradaMcpTools(
      { has: () => false, register: (tool: ITool) => { registered = tool; } } as never,
      [
        {
          name: "unity_scene_build",
          description: "Build a scene from a spec",
          inputSchema: { type: "object", properties: { spec: { type: "object" }, emitBootTest: { type: "boolean" } } },
          metadata: { category: "unity-scene", requiresBridge: false, dangerous: false, readOnly: false },
          execute,
        },
      ] as never,
    );
    return { tool: registered!, execute };
  }

  it("hands the tool the object the model sent as text", async () => {
    const { tool, execute } = registeredTool();
    const context = { projectPath: "/p", workingDirectory: "/p", readOnly: false } as ToolContext;
    await tool.execute({ spec: '{"specVersion":1}', emitBootTest: "true" }, context);
    expect(execute.mock.calls[0]?.[0]).toEqual({ spec: { specVersion: 1 }, emitBootTest: true });
  });
});
