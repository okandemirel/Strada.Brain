import { describe, expect, it, vi } from "vitest";
import { registerStradaMcpTools } from "./strada-mcp-tool-loader.js";

describe("registerStradaMcpTools", () => {
  it("registers unique Strada.MCP tools into the main toolchain", () => {
    const register = vi.fn();
    const registry = {
      has: vi.fn().mockReturnValue(false),
      register,
    };

    const result = registerStradaMcpTools(registry, [
      {
        name: "unity_scene_info",
        description: "Get scene info",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          category: "unity-scene",
          requiresBridge: false,
          dangerous: false,
          readOnly: true,
        },
        execute: vi.fn(),
      },
    ]);

    expect(result).toEqual({ registered: 1, skipped: 0 });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[1]).toMatchObject({
      category: "custom",
      dangerous: false,
      readOnly: true,
      dependencies: ["strada-mcp"],
    });
  });

  it("skips tool names that already exist in the registry", () => {
    const registry = {
      has: vi.fn().mockReturnValue(true),
      register: vi.fn(),
    };

    const result = registerStradaMcpTools(registry, [
      {
        name: "file_read",
        description: "Read file",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          category: "file",
          requiresBridge: false,
          dangerous: false,
          readOnly: true,
        },
        execute: vi.fn(),
      },
    ]);

    expect(result).toEqual({ registered: 0, skipped: 1 });
    expect(registry.register).not.toHaveBeenCalled();
  });
});
