/**
 * A failed tool result is kept whole on disk — measured 2026-09-08, a
 * 1559-error compile verdict survived only as one log line.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveToolFailure, toolFailureArchiveRoot } from "./tool-failure-archive.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const freshRoot = (): string => { const r = mkdtempSync(join(tmpdir(), "tool-failure-archive-")); roots.push(r); return r; };

describe("archiveToolFailure", () => {
  it("writes the whole result, with the tool, chat and input, under <root>/<day>/", () => {
    const root = freshRoot();
    const content = `{"status":"failed","reason":"Headless compile failed with 1559 error(s)"}\n${"x".repeat(20_000)}`;
    const at = new Date("2026-09-08T03:46:00.123Z");
    const file = archiveToolFailure(
      { tool: "unity_verify_change", chatId: "cli-local", input: { runTests: false, scope: "Assets/Scenes" }, content, at },
      root,
    );
    expect(file).toBe(join(root, "2026-09-08", "034600-123-unity_verify_change.txt"));
    const text = readFileSync(file!, "utf8");
    expect(text).toContain("tool: unity_verify_change");
    expect(text).toContain("chatId: cli-local");
    expect(text).toContain('"scope": "Assets/Scenes"');
    // The result is kept in full — the 20 000 filler chars included, not a preview.
    expect(text).toContain(content);
    expect(text).toContain(`== result (${content.length} chars) ==`);
  });

  it("caps the echoed input, never the result", () => {
    const root = freshRoot();
    const file = archiveToolFailure(
      { tool: "file_write", chatId: "c", input: { content: "y".repeat(10_000) }, content: "Error: refused" },
      root,
    );
    const text = readFileSync(file!, "utf8");
    expect(text).toContain("more chars)");
    expect(text).toContain("Error: refused");
  });

  it("returns undefined instead of throwing when the root cannot be created", () => {
    const root = freshRoot();
    const blocker = join(root, "file-not-dir");
    writeFileSync(blocker, "");
    expect(archiveToolFailure({ tool: "t", chatId: "c", input: {}, content: "x" }, join(blocker, "sub"))).toBeUndefined();
  });

  it("lives under STRADA_HOME/.strada/tool-failures", () => {
    expect(toolFailureArchiveRoot({ STRADA_HOME: "/h" })).toBe(join("/h", ".strada", "tool-failures"));
    expect(existsSync(toolFailureArchiveRoot({ STRADA_HOME: "/definitely/not/there" }))).toBe(false);
  });
});
