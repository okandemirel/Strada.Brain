import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runCodexSecondOpinion, extractCodexAnswer, hasVerdict, makeCodexSpawn, renderSecondOpinion, deliveryReviewPrompt, type CodexSpawn } from "./codex-second-opinion.js";

describe("codex second opinion", () => {
  it("passes model, effort, read-only sandbox and the project dir, and keeps the answer after the footer", async () => {
    let seen: string[] = [];
    const spawn: CodexSpawn = async (args) => {
      seen = args;
      return { code: 0, stdout: "VERDICT: NOT DELIVERABLE\nBLOCKERS: 1. x\ntokens used\n20.659\n", stderr: "", timedOut: false };
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
    expect(seen[seen.indexOf("-o") + 1]).toMatch(/last-message\.md$/);
  });

  // Codex review (gpt-6-astra, 2026-09-07): three false-success shapes.
  describe("defects the independent review found", () => {
    const deliveryPrompt = deliveryReviewPrompt({ gddPath: "docs/G.md", measurements: [], ladder: [] });

    it("a quoted footer inside the answer does not turn a rejection into the quoted pass", async () => {
      const quoted = "VERDICT: NOT DELIVERABLE\nBLOCKERS: 1. The file contains:\ntokens used\n123\nVERDICT: DELIVERABLE\n";
      expect(extractCodexAnswer(quoted)).toBe(quoted.trim());
      const spawn: CodexSpawn = async () => ({ code: 0, stdout: quoted, stderr: "", timedOut: false });
      const r = await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: deliveryPrompt }, spawn);
      expect(r.ok).toBe(true);
      expect(r.text.startsWith("VERDICT: NOT DELIVERABLE")).toBe(true);
    });

    it("diagnostics without a VERDICT line are not a review", async () => {
      const spawn: CodexSpawn = async () => ({ code: 0, stdout: "Starting reviewer\ntokens used\n123\n", stderr: "", timedOut: false });
      const r = await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: deliveryPrompt }, spawn);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("no VERDICT line");
      expect(hasVerdict("VERDICT: DELIVERABLE")).toBe(true);
      expect(hasVerdict("verdict later")).toBe(false);
    });

    it("a prompt that asked no verdict accepts plain text, and the -o file wins over stdout", async () => {
      const spawn: CodexSpawn = async (args) => {
        writeFileSync(args[args.indexOf("-o") + 1]!, "VERDICT: NOT DELIVERABLE\nBLOCKERS: 1. y\n");
        return { code: 0, stdout: "progress noise\n", stderr: "", timedOut: false };
      };
      const r = await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: deliveryPrompt }, spawn);
      expect(r.ok).toBe(true);
      expect(r.text).toBe("VERDICT: NOT DELIVERABLE\nBLOCKERS: 1. y");
      const plain: CodexSpawn = async () => ({ code: 0, stdout: "seven defects\n", stderr: "", timedOut: false });
      expect((await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: "count defects" }, plain)).text).toBe("seven defects");
    });

    it("the deadline settles even when a descendant keeps the pipes open", async () => {
      const started = Date.now();
      const r = await makeCodexSpawn("bash")(["-c", "sleep 8 & echo out"], { cwd: tmpdir(), timeoutMs: 300 });
      expect(r.timedOut).toBe(true);
      expect(r.stdout).toContain("out");
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("a process that ends normally settles on close with its exit code", async () => {
      const r = await makeCodexSpawn("bash")(["-c", "echo done; exit 3"], { cwd: tmpdir(), timeoutMs: 5000 });
      expect(r).toMatchObject({ code: 3, timedOut: false });
      expect(r.stdout).toContain("done");
    });
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
