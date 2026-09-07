import { describe, it, expect } from "vitest";
import { runCodexSecondOpinion, extractCodexAnswer, renderSecondOpinion, deliveryReviewPrompt, type CodexSpawn } from "./codex-second-opinion.js";

describe("codex second opinion", () => {
  it("passes model, effort, read-only sandbox and the project dir, and keeps the answer after the footer", async () => {
    let seen: string[] = [];
    const spawn: CodexSpawn = async (args) => {
      seen = args;
      return { code: 0, stdout: "VERDICT: NOT DELIVERABLE\nBLOCKERS: 1. x\ntokens used\n20.659\nVERDICT: NOT DELIVERABLE\nBLOCKERS: 1. x\n", stderr: "", timedOut: false };
    };
    const r = await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: "q", model: "gpt-6-astra", effort: "high" }, spawn);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("VERDICT: NOT DELIVERABLE\nBLOCKERS: 1. x");
    expect(seen.slice(0, 2)).toEqual(["exec", "-m"]);
    expect(seen).toContain("gpt-6-astra");
    expect(seen).toContain("model_reasoning_effort=high");
    expect(seen).toContain("read-only");
    expect(seen).toContain("--ephemeral");
    expect(seen[seen.indexOf("-C") + 1]).toBe("/tmp/p");
  });

  it("reports a failure as unavailable, never as an empty pass", async () => {
    const dead: CodexSpawn = async () => ({ code: 127, stdout: "", stderr: "codex: command not found", timedOut: false });
    const r = await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: "q" }, dead);
    expect(r.ok).toBe(false);
    expect(renderSecondOpinion(r)[0]).toContain("UNAVAILABLE");
    expect(renderSecondOpinion(r)[0]).toContain("command not found");
    expect(renderSecondOpinion(undefined)[0]).toContain("not run");
  });

  it("times out instead of hanging a delivery", async () => {
    const slow: CodexSpawn = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    const r = await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: "q", timeoutMs: 10 }, slow);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
  });

  it("extracts the answer even without a footer, and the prompt carries the measurements", () => {
    expect(extractCodexAnswer("just text\n")).toBe("just text");
    const p = deliveryReviewPrompt({ gddPath: "docs/G.md", measurements: ["0 renderers"], ladder: ["m1: green"] });
    expect(p).toContain("- 0 renderers");
    expect(p).toContain("VERDICT: DELIVERABLE | NOT DELIVERABLE");
  });
});
