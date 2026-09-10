/**
 * The verifier must see the worker's whole result — measured 2026-09-10: a
 * 1 800-character slice cut a JSON block mid-object and the verifier rejected
 * the node three times as "truncated/incomplete". Its own cut.
 */
import { describe, expect, it } from "vitest";
import { buildVerificationPrompt, VERIFICATION_OUTPUT_CHARS } from "./supervisor-verification.js";
import type { NodeResult } from "./supervisor-types.js";

function node(output: string): NodeResult {
  return { nodeId: "n1" as never, status: "ok", output, artifacts: [], toolResults: [], provider: "p", model: "m", cost: 0, duration: 1 };
}

describe("buildVerificationPrompt", () => {
  it("shows a long structured result whole — a 4 000-character JSON block is not cut", () => {
    const tests = JSON.stringify({ tests: { total: 215, failed: [], names: Array.from({ length: 120 }, (_, i) => `Suite.Test_${i}_ReachesWonState`) } }, null, 1);
    expect(tests.length).toBeGreaterThan(1800);
    const prompt = buildVerificationPrompt(node(`Done.\n\`\`\`json\n${tests}\n\`\`\``));
    expect(prompt).toContain(tests);
    expect(prompt).not.toContain("cut by the system");
  });

  it("when it must cut, it says so and forbids reading the cut as incompleteness", () => {
    const long = "x".repeat(VERIFICATION_OUTPUT_CHARS + 500);
    const prompt = buildVerificationPrompt(node(long));
    expect(prompt).toContain(`cut by the system at ${VERIFICATION_OUTPUT_CHARS} of ${long.length} characters`);
    expect(prompt).toContain("NOT the worker's incompleteness");
    expect(prompt).not.toContain("x".repeat(VERIFICATION_OUTPUT_CHARS + 1));
  });
});
