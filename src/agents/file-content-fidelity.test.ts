/**
 * The model edits what file_read showed it, so file_read must show the file.
 *
 * Audit orchestrator#1: every tool result went through the prompt-injection
 * rewriter, which NFKC-normalizes, hides base64 behind "[base64:Nch]", turns
 * "override … the … system" into "[filtered:override]" and deletes every \r.
 * On a CRLF Unity script the model never saw a line ending it could match, so
 * a multi-line file_edit answered "old_string not found", and the file_write
 * fallback put "(はい)!" and the literal placeholder on disk in place of the
 * original text. These tests drive the real tools through the orchestrator,
 * where the sanitizer runs.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { FileEditTool } from "./tools/file-edit.js";
import { FileReadTool } from "./tools/file-read.js";
import { GrepSearchTool } from "./tools/search.js";
import { createMockChannel, createMockProvider } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const ICON =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAA==";
const OVERRIDE_LINE = "    protected override void OnUpdate() { } // ticks the movement system";
const LINES = [
  "using UnityEngine;",
  "public class A {",
  '    string s = "（はい）！";',
  `    const string Icon = "${ICON}";`,
  OVERRIDE_LINE,
  "    int x = 1;",
  "}",
  "",
];
const CRLF_SOURCE = LINES.join("\r\n");

let projectPath: string;
let orch: Orchestrator;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "file-content-fidelity-"));
  writeFileSync(join(projectPath, "A.cs"), CRLF_SOURCE);
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [new FileReadTool(), new FileEditTool(), new GrepSearchTool()] as never,
    channel: createMockChannel() as never,
    projectPath,
    readOnly: false,
    requireConfirmation: false,
  });
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

async function run(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  const [result] = await (
    orch as unknown as {
      executeToolCalls: (c: string, t: unknown[], o: unknown) => Promise<Array<{ content: string; isError?: boolean }>>;
    }
  ).executeToolCalls("chat-fidelity", [{ id: `tc-${name}`, name, input }], { mode: "background" });
  return result!;
}

/** The source lines as the model reads them back out of a numbered file_read result. */
function shownLines(readResult: string): string[] {
  return readResult
    .split("\n")
    .filter((line) => /^\s*\d+ \| /.test(line))
    .map((line) => line.replace(/^\s*\d+ \| /, ""));
}

describe("file content reaches the model as it is on disk", () => {
  it("file_read keeps the CR line endings, full-width text, base64 and C# that reads like a directive", async () => {
    const read = await run("file_read", { path: "A.cs" });

    expect(read.isError).toBeFalsy();
    expect(read.content).not.toContain("[base64:");
    expect(read.content).not.toContain("[filtered:");
    // Line by line, exactly what the file holds between its line breaks.
    expect(shownLines(read.content)).toEqual(CRLF_SOURCE.split("\n"));
  });

  it("grep_search hits keep the matched line's text", async () => {
    const hits = await run("grep_search", { pattern: "Icon|はい|override", file_pattern: "**/*.cs" });

    expect(hits.content).toContain(`const string Icon = "${ICON}";`);
    expect(hits.content).toContain('string s = "（はい）！";');
    expect(hits.content).toContain(OVERRIDE_LINE.trim());
  });

  it("a multi-line edit copied from that read lands, and the file keeps CRLF and every byte around it", async () => {
    const read = await run("file_read", { path: "A.cs" });
    // A model copies the lines it saw and joins them with \n — it does not
    // emit the \r it was shown.
    const seen = shownLines(read.content).map((line) => line.replace(/\r$/, ""));
    const oldString = seen.slice(1, 6).join("\n");
    const newString = oldString.replace("int x = 1;", "int x = 2;");

    const edit = await run("file_edit", { path: "A.cs", old_string: oldString, new_string: newString });

    expect(edit.content).not.toMatch(/old_string not found/);
    expect(edit.isError).toBeFalsy();
    const onDisk = readFileSync(join(projectPath, "A.cs"), "utf-8");
    expect(onDisk).toBe(CRLF_SOURCE.replace("int x = 1;", "int x = 2;"));
  });
});
