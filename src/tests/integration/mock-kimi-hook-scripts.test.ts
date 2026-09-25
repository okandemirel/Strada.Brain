/**
 * The release smoke's mock provider scripts the agent's side of each scenario.
 * These pin the parts the current verifier flow depends on: the PAOR scenario
 * must end with a check the verifier pipeline accepts as targeted verification
 * (a shell `test -f` never was one, so the scenario could not pass), and
 * reviewers get the verdict format they parse.
 *
 * The hook replaces globalThis.fetch when imported, so this file restores it.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const realFetch = globalThis.fetch;
const KIMI_URL = "https://api.kimi.com/coding/v1/chat/completions";
const PAOR_PROMPT =
  "Run the PAOR recovery smoke: let the initial approach fail, then replan and create Assets/paor-proof.txt with exact content 'paor ok'.";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface Completion {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
  }>;
}

let verifyCommand = "";

beforeAll(async () => {
  // A non-literal specifier: the hook is a .mjs script with no declarations.
  const hookUrl = pathToFileURL(path.join(process.cwd(), "scripts", "release", "mock-kimi-hook.mjs")).href;
  const hook = (await import(hookUrl)) as { PAOR_VERIFY_COMMAND: string };
  verifyCommand = hook.PAOR_VERIFY_COMMAND;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function complete(messages: ChatMessage[]): Promise<{ text: string; tools: Array<{ name: string; input: Record<string, unknown> }> }> {
  const response = await fetch(KIMI_URL, { method: "POST", body: JSON.stringify({ messages, stream: false }) });
  const body = (await response.json()) as Completion;
  const message = body.choices[0]!.message;
  return {
    text: message.content ?? "",
    tools: (message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      input: JSON.parse(call.function.arguments) as Record<string, unknown>,
    })),
  };
}

function toolTurn(id: string, name: string, input: Record<string, unknown>, result: string): ChatMessage[] {
  return [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

const NOT_FOUND = "Error: file not found: Assets/missing-proof.txt — that directory holds: Resources";

describe("mock-kimi-hook PAOR recovery script", () => {
  it("fails the first approach twice, replans, writes the proof, runs the project check, then concludes", async () => {
    const system: ChatMessage = { role: "system", content: "You are Strada." };
    const prompt: ChatMessage = { role: "user", content: PAOR_PROMPT };

    const first = await complete([system, prompt]);
    expect(first.tools).toEqual([{ name: "file_read", input: { path: "Assets/missing-proof.txt" } }]);

    const afterOneFailure = [system, prompt, ...toolTurn("r1", "file_read", { path: "Assets/missing-proof.txt" }, NOT_FOUND)];
    const retry = await complete(afterOneFailure);
    // One failure does not send the loop to reflection; a second in a row does.
    expect(retry.tools).toEqual([{ name: "file_read", input: { path: "Assets/missing-proof.txt" } }]);

    const afterTwoFailures = [...afterOneFailure, ...toolTurn("r2", "file_read", { path: "Assets/missing-proof.txt" }, NOT_FOUND)];
    const reflection = await complete([
      ...afterTwoFailures,
      { role: "user", content: "## Reflection Phase\n\n### Recent Step Results\n\n- [FAIL] file_read: ..." },
    ]);
    expect(reflection.text.trim().endsWith("**REPLAN**")).toBe(true);
    expect(reflection.tools).toEqual([]);

    const replan = await complete([
      { role: "system", content: "You are Strada.\n\n## Replanning Phase\n\n### Failed Approaches" },
      ...afterTwoFailures.slice(1),
      { role: "user", content: "Please create a new plan." },
    ]);
    expect(replan.tools).toEqual([{ name: "file_write", input: { path: "Assets/paor-proof.txt", content: "paor ok\n" } }]);

    const afterWrite = [
      ...afterTwoFailures,
      ...toolTurn("w1", "file_write", { path: "Assets/paor-proof.txt", content: "paor ok\n" }, "File written: Assets/paor-proof.txt (2 lines, 8 bytes) (+.meta)"),
    ];
    const verify = await complete(afterWrite);
    expect(verify.tools).toEqual([{ name: "shell_exec", input: { command: verifyCommand } }]);

    const afterCheck = [
      ...afterWrite,
      ...toolTurn("v1", "shell_exec", { command: verifyCommand }, `$ ${verifyCommand}\nExit code: 0 | Duration: 172ms\n\n--- stdout ---\npaor proof verified`),
    ];
    const done = await complete(afterCheck);
    expect(done.text).toBe("PAOR recovery completed after replanning.");
    expect(done.tools).toEqual([]);

    // A verifier or loop-recovery prompt after the check does not restart the script.
    const again = await complete([...afterCheck, { role: "user", content: "[VERIFIER PIPELINE] Internal verification is not clean yet." }]);
    expect(again.text).toBe("PAOR recovery completed after replanning.");
  });

  it("verifies with a command the verifier pipeline counts as a test run", () => {
    // VERIFICATION_COMMAND_HEAD_RE in self-verification.ts: an npm test run is
    // a verification; `test -f … && grep …` never was one.
    expect(verifyCommand).toBe("npm test");
  });
});

describe("mock-kimi-hook reviewers", () => {
  it("answers the shell safety review with the JSON decision it parses", async () => {
    const review = await complete([
      { role: "system", content: "You are the shell safety arbiter for an autonomous coding agent." },
      { role: "user", content: `Mode: delegated\nTask: ${PAOR_PROMPT}\n\nCommand:\nnpm test` },
    ]);
    expect(JSON.parse(review.text)).toMatchObject({ decision: "approve", taskAligned: true, bounded: true });
    expect(review.tools).toEqual([]);
  });

  it("answers the supervisor's node review with a verdict, not prose", async () => {
    const review = await complete([
      { role: "system", content: "You are Strada." },
      { role: "user", content: "Review this supervisor worker result for obvious correctness, completeness, and safety issues.\nWorker output:\nPAOR recovery completed after replanning." },
    ]);
    expect(JSON.parse(review.text)).toEqual({ verdict: "approve" });
  });
});

