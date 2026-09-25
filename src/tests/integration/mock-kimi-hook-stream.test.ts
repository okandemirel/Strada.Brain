/**
 * The release smoke's mock provider must answer the way the real provider
 * parses. The orchestrator streams, and the mock only ever returned a JSON
 * completion, which the stream parser read as an empty response: every smoke
 * turn failed with "empty response (no text, no tool calls)".
 *
 * The hook replaces globalThis.fetch when imported, so this file restores it.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KimiProvider } from "../../agents/providers/kimi.js";
import { createLogger } from "../../utils/logger.js";

const realFetch = globalThis.fetch;

beforeAll(async () => {
  try { createLogger("error", "/tmp/strada-mock-kimi-hook-test.log"); } catch { /* already initialized */ }
  // A non-literal specifier: the hook is a .mjs script with no declarations.
  const hookUrl = pathToFileURL(path.join(process.cwd(), "scripts", "release", "mock-kimi-hook.mjs")).href;
  await import(hookUrl);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("mock-kimi-hook streaming", () => {
  it("streams a text reply the Kimi provider parses", async () => {
    const chunks: string[] = [];
    const response = await new KimiProvider("smoke-kimi-key").chatStream(
      "system",
      [{ role: "user", content: "My name is CodexTester" }],
      [],
      (chunk) => { chunks.push(chunk); },
    );
    expect(response.text).toBe("Nice to meet you, CodexTester.");
    expect(chunks.join("")).toBe("Nice to meet you, CodexTester.");
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage.inputTokens).toBe(100);
  });

  it("streams a tool call with its arguments", async () => {
    const response = await new KimiProvider("smoke-kimi-key").chatStream(
      "system",
      [{ role: "user", content: "Use file_write to create Assets/autonomy-proof.txt with exact content 'autonomy ok'." }],
      [],
      () => {},
    );
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toEqual([
      { id: "tool-autonomy", name: "file_write", input: { path: "Assets/autonomy-proof.txt", content: "autonomy ok\n" } },
    ]);
  });
});
