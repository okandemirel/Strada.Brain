/**
 * Do not let an agent rebuild a tool it already has.
 *
 * The factory's conflict check compares the PREFIXED name, so a request for
 * `file_write` never collided with the built-in `file_write` — it became
 * `dynamic_file_write` and the agent walked away with a second, worse writer.
 *
 * Measured on a live run: the agent asked create_tool for `file_write`, then
 * `write_file`, then `write_minified_file`, each a shell-backed writer, and
 * never called the real file_write once — 148 tools were registered and it built
 * its own anyway. The third wrote five .asmdef files through a shell, which ate
 * the JSON quoting, and reported success on all five; the run ended with four
 * assembly definitions Unity cannot parse.
 *
 * Being told the tool already existed is what stops this at the first request.
 */

import { describe, it, expect, vi } from "vitest";
import { CreateToolTool } from "./create-tool.js";
import type { ToolContext } from "../tool-core.interface.js";

function contextWith(existing: Record<string, string>): ToolContext & {
  registered: unknown[];
} {
  const registered: unknown[] = [];
  return {
    projectPath: "/proj",
    workingDirectory: "/proj",
    readOnly: false,
    registerDynamicTool: (tool: unknown) => registered.push(tool),
    lookupTool: (name: string) =>
      existing[name] ? ({ name, description: existing[name] } as never) : undefined,
    registered,
  } as unknown as ToolContext & { registered: unknown[] };
}

async function createTool(
  context: ToolContext,
  name: string,
): Promise<{ content: string; isError?: boolean }> {
  const tool = new CreateToolTool();
  return (
    tool as unknown as {
      execute(i: Record<string, unknown>, c: ToolContext): Promise<{ content: string; isError?: boolean }>;
    }
  ).execute(
    {
      name,
      description: "writes a file",
      strategy: "shell",
      command: "printf '%s' \"$content\" > \"$path\"",
      parameters: [
        { name: "path", type: "string", required: true },
        { name: "content", type: "string", required: true },
      ],
    },
    context,
  );
}

describe("create_tool and existing tools", () => {
  it("refuses to recreate a built-in, and says which one", async () => {
    const context = contextWith({ file_write: "Writes a file to the project" });

    const result = await createTool(context, "file_write");

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/already exists/i);
    // Naming the existing tool is the point — a bare refusal invites the agent
    // to retry under a different name, which is exactly what it did.
    expect(result.content).toContain("file_write");
    expect(result.content).toContain("Writes a file to the project");
    expect(context.registered).toHaveLength(0);
  });

  it("still allows a genuinely new tool", async () => {
    const context = contextWith({ file_write: "Writes a file" });

    const result = await createTool(context, "summarize_shader_errors");

    expect(result.isError).toBeFalsy();
    expect(context.registered).toHaveLength(1);
  });

  it("copes with a context that cannot look tools up", async () => {
    // lookupTool is optional on ToolContext; its absence must not break
    // creation, only weaken the check.
    const context = contextWith({});
    (context as unknown as { lookupTool?: unknown }).lookupTool = undefined;

    const result = await createTool(context, "some_new_tool");

    expect(result.isError).toBeFalsy();
  });
});
