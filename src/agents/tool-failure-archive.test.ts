/**
 * A failed tool result is kept whole on disk — measured 2026-09-08, a
 * 1559-error compile verdict survived only as one log line.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_DAY_CAP, ARCHIVE_KEEP_DAYS, archiveToolFailure, toolFailureArchiveRoot } from "./tool-failure-archive.js";

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

  it("lives under STRADA_HOME/.strada/tool-failures, under the temp root while vitest runs, or where STRADA_TOOL_FAILURE_DIR says", () => {
    expect(toolFailureArchiveRoot({ STRADA_HOME: "/h" })).toBe(join("/h", ".strada", "tool-failures"));
    expect(existsSync(toolFailureArchiveRoot({ STRADA_HOME: "/definitely/not/there" }))).toBe(false);
    // Reviewed 2026-09-08: the first version's unit tests wrote nonexistent_tool
    // failures into the user's real ~/.strada.
    expect(toolFailureArchiveRoot({ VITEST: "true" })).toBe(join(tmpdir(), "strada-tool-failures"));
    expect(toolFailureArchiveRoot({ VITEST: "true", STRADA_TOOL_FAILURE_DIR: "/x" })).toBe("/x");
    expect(toolFailureArchiveRoot()).toBe(join(tmpdir(), "strada-tool-failures"));
  });

  it("redacts credentials in both the input and the result", () => {
    const root = freshRoot();
    const key = "sk-ant-api03-SECRETSECRETSECRETSECRET";
    const file = archiveToolFailure(
      { tool: "shell_exec", chatId: "c", input: { command: `curl -H 'Authorization: Bearer ${key}'` }, content: `Error: 401 for key ${key}` },
      root,
    );
    const text = readFileSync(file!, "utf8");
    expect(text).not.toContain("SECRETSECRET");
    expect(text).toContain("[REDACTED]");
  });

  it("stops writing after ARCHIVE_DAY_CAP files in a day and says so by returning undefined", () => {
    const root = freshRoot();
    const at = new Date("2026-09-08T10:00:00.000Z");
    const day = join(root, "2026-09-08");
    mkdirSync(day, { recursive: true });
    for (let i = 0; i < ARCHIVE_DAY_CAP; i++) writeFileSync(join(day, `f${i}.txt`), "");
    expect(archiveToolFailure({ tool: "t", chatId: "c", input: {}, content: "x", at }, root)).toBeUndefined();
    expect(readdirSync(day)).toHaveLength(ARCHIVE_DAY_CAP);
  });

  it("removes day directories older than ARCHIVE_KEEP_DAYS when it first archives", () => {
    const root = freshRoot();
    mkdirSync(join(root, "2026-01-01"), { recursive: true });
    mkdirSync(join(root, "2026-09-07"), { recursive: true });
    const at = new Date("2026-09-08T10:00:00.000Z");
    expect(archiveToolFailure({ tool: "t", chatId: "c", input: {}, content: "x", at }, root)).toBeTruthy();
    expect(existsSync(join(root, "2026-01-01"))).toBe(false);
    expect(existsSync(join(root, "2026-09-07"))).toBe(true);
  });

  it("never overwrites: five failures of one tool in the same millisecond leave five files", () => {
    // Review 2026-09-08: parallel file_read refusals in one turn left two files of five.
    const root = freshRoot();
    const at = new Date("2026-09-08T12:00:00.000Z");
    const files = new Set<string>();
    for (let i = 0; i < 5; i++) {
      files.add(archiveToolFailure({ tool: "file_read", chatId: "c", input: { path: `p${i}` }, content: `refused ${i}` }, root, ) as string);
    }
    void at;
    expect(files.size).toBe(5);
    for (const f of files) expect(existsSync(f)).toBe(true);
  });

  it("redacts with the logger's pattern set, before any cut, and never truncates the result", () => {
    const root = freshRoot();
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    const long = "y".repeat(12_000) + " password=hunter2secret " + "z".repeat(12_000);
    const file = archiveToolFailure(
      // JSON.stringify(input, null, 2) puts the key at text offset 3993, so a
      // 4000-char cut made before redaction keeps "sk-ant-" — too short for the
      // key pattern to catch afterwards, long enough to name the vendor.
      { tool: "shell_exec", chatId: "c", input: { command: "x".repeat(3_976) + " sk-ant-api03-SECRETSECRETSECRETSECRET" }, content: `${key}\n${long}` },
      root,
    );
    const text = readFileSync(file!, "utf8");
    expect(text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
    expect(text).not.toContain("hunter2secret");
    expect(text).not.toContain("SECRETSECRET");
    // The key straddled the 4000-char input cut: not even its head survives.
    expect(text).not.toContain("sk-ant");
    // The 24k+ result is kept whole (no 8 KB logger cut).
    expect(text).toContain("y".repeat(12_000));
    expect(text).toContain("z".repeat(12_000));
  });
});
