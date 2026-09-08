import { describe, it, expect } from "vitest";
import { suggestTool, unknownToolMessage } from "./unknown-tool-hint.js";

const TOOLS = ["shell_exec", "file_read", "file_write", "grep_search", "glob_search", "unity_generate_sprite", "unity_bind_sprite"];

describe("unknown tool hint", () => {
  it("names shell_exec for 'bash' — measured 2026-09-08, two turns lost to that guess", () => {
    expect(suggestTool("bash", TOOLS)).toBe("shell_exec");
    expect(unknownToolMessage("bash", TOOLS)).toBe(
      "Error: unknown tool 'bash' — did you mean shell_exec? Only the tools in this request's tool list exist; call one of those by its exact name.",
    );
  });

  it("matches by shared tokens when no alias applies", () => {
    expect(suggestTool("generate_sprite", TOOLS)).toBe("unity_generate_sprite");
    expect(suggestTool("unity_sprite_bind", TOOLS)).toBe("unity_bind_sprite");
  });

  it("suggests nothing for a name that resembles nothing, and never a tool that is not registered", () => {
    expect(suggestTool("frobnicate", TOOLS)).toBeUndefined();
    expect(suggestTool("bash", ["file_read"])).toBeUndefined();
    expect(unknownToolMessage("frobnicate", TOOLS)).toContain("unknown tool 'frobnicate'");
    expect(unknownToolMessage("frobnicate", TOOLS)).not.toContain("did you mean");
  });
});
