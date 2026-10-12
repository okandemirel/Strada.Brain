import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexSecondOpinion, extractCodexAnswer, hasVerdict, makeCodexSpawn, renderSecondOpinion, deliveryReviewPrompt, resolveCodexCommand, REVIEW_ROWS_MAX_CHARS, WINDOWS_REVIEW_PROMPT_MAX_CHARS, type CodexSpawn } from "./codex-second-opinion.js";

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
      // The deadline must leave bash time to start and print: Git Bash on a
      // loaded Windows runner took longer than 300 ms, so stdout was still
      // empty when it fired. Settling well before the 8 s descendant exits is
      // what proves the pipes did not hold the call open.
      const started = Date.now();
      const r = await makeCodexSpawn("bash")(["-c", "sleep 8 & echo out"], { cwd: tmpdir(), timeoutMs: 2000 });
      expect(r.timedOut).toBe(true);
      expect(r.stdout).toContain("out");
      expect(Date.now() - started).toBeLessThan(7000);
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

  it("hands a GDD that is not in the project over as text, bounded, instead of '(unknown path) — read it' (review campaign-artifacts P3)", () => {
    const p = deliveryReviewPrompt({ gddPath: undefined, gddText: "# Space GDD\n\nThree asteroid fields.", measurements: [], ladder: [] });
    expect(p).not.toContain("(unknown path)");
    expect(p).toContain("not saved in this project");
    expect(p).toContain("Three asteroid fields.");
    // The prompt travels as one command-line argument: a long document is cut, and says so.
    const long = "# Big GDD\n\n" + "Lore. ".repeat(40_000);
    const bounded = deliveryReviewPrompt({ gddPath: undefined, gddText: long, measurements: [], ladder: [] });
    expect(bounded.length).toBeLessThan(30_000);
    expect(bounded).toContain(`of ${long.length} characters`);
    // A campaign with a file is still pointed at it, and its text is not inlined.
    const onDisk = deliveryReviewPrompt({ gddPath: "docs/G.md", gddText: "# Space GDD\n\nThree asteroid fields.", measurements: [], ladder: [] });
    expect(onDisk).toContain("GDD: docs/G.md — read it.");
    expect(onDisk).not.toContain("Three asteroid fields.");
  });

  describe("the review as a gate (GDD-drift W13)", () => {
    const base = { gddPath: "docs/G.md", measurements: ["0 renderers"], ladder: ["m1 Sprint: green"] };
    const rows = [
      { rid: "req-1-aa", label: "KP-01", where: "§3", text: "A kite gains one metre per second in an updraft.", test: "Strada.Acceptance.M1.Acceptance_M1.R1_aa" },
      { rid: "req-2-bb", where: "Towns", text: "Every town has its own post office." },
    ];
    const checks = [{ path: "Assets/StradaAcceptance/Acceptance_M1.cs", source: "// REQ req-1-aa — KP-01\nAssert.That(true);" }];

    it("without rows it is the advisory question it always was, byte for byte", () => {
      expect(deliveryReviewPrompt(base)).toBe(
        [
          "You are an independent, adversarial release reviewer for a Unity game built autonomously from a GDD.",
          "GDD: docs/G.md — read it.",
          "The build system's own measurements of the tree as it stands:",
          "- 0 renderers",
          "Its milestone ladder:",
          "- m1 Sprint: green",
          "",
          "Inspect the project (scenes, prefabs, scripts, tests, art) read-only. Answer in this exact shape:",
          "VERDICT: DELIVERABLE | NOT DELIVERABLE",
          "BLOCKERS: numbered list, each with the file(s) and the GDD requirement it fails; 'none' if none",
          "DISAGREEMENTS: where the measurements above are wrong or misleading, with evidence; 'none' if none",
          "NEXT: the three most valuable concrete changes, each one sentence",
          "Be terse and specific. Do not restate the GDD.",
        ].join("\n"),
      );
    });

    it("with rows it carries the rows and the stored checks, and asks for a findings tail that can only reopen or add", () => {
      const p = deliveryReviewPrompt({ ...base, rows, checks, platform: "linux" });
      const tested = p.indexOf("- req-1-aa [KP-01] (§3): \"A kite gains one metre per second in an updraft.\" — test Strada.Acceptance.M1.Acceptance_M1.R1_aa");
      const file = p.indexOf("// REQ req-1-aa — KP-01\nAssert.That(true);");
      const untested = p.indexOf("- req-2-bb (Towns): \"Every town has its own post office.\"");
      expect(tested).toBeGreaterThan(0);
      // The checks a finding can call weak travel before the rows that only guard against re-reporting.
      expect(file).toBeGreaterThan(tested);
      expect(untested).toBeGreaterThan(file);
      expect(p).toContain("VERDICT: DELIVERABLE | NOT DELIVERABLE");
      expect(p).toContain('{"weakChecks":[{"rid":"<row id>"');
      expect(p).toContain('"missing":[{"gddQuote":');
      expect(p).toContain("they never close one");
      expect(p.trimEnd().endsWith("Be terse and specific. Do not restate the GDD.")).toBe(true);
    });

    it("the rows and checks stay within REVIEW_ROWS_MAX_CHARS, and what does not fit is counted", () => {
      const many = Array.from({ length: 600 }, (_, i) => ({ rid: `req-${i}-cc`, where: "§9", text: `Rule ${i}: ${"words ".repeat(30)}` }));
      const p = deliveryReviewPrompt({ ...base, rows: many, checks: [], platform: "linux" });
      const fixed = deliveryReviewPrompt({ ...base, rows: [], checks: [], platform: "linux" }).length;
      expect(p.length - fixed).toBeLessThanOrEqual(REVIEW_ROWS_MAX_CHARS + 200);
      expect(p).toMatch(/\(\d+ row\(s\) and 0 check file\(s\) not shown: the prompt's size cap\)/);
    });

    it("on Windows the whole prompt fits the command line: the rows and checks give way, never the question", () => {
      const many = Array.from({ length: 600 }, (_, i) => ({ rid: `req-${i}-cc`, where: "§9", text: `Rule ${i}: ${"words ".repeat(30)}` }));
      const gddText = "# Big GDD\n\n" + "Lore. ".repeat(40_000);
      const p = deliveryReviewPrompt({ ...base, gddPath: undefined, gddText, rows: many, checks, platform: "win32" });
      expect(p.length).toBeLessThanOrEqual(WINDOWS_REVIEW_PROMPT_MAX_CHARS);
      expect(p).toContain("VERDICT: DELIVERABLE | NOT DELIVERABLE");
      expect(p).toContain('{"weakChecks"');
      expect(p).toContain("not shown: the prompt's size cap");
    });

    it("the report shows what the findings changed beside the verbatim answer", () => {
      const lines = renderSecondOpinion({
        ok: true,
        model: "fake-astra",
        text: "VERDICT: DELIVERABLE",
        ms: 2000,
        gate: { reopened: ["KP-01 (§3) — asserts true"], added: [], disclosed: ['missing "x": quote too short'] },
      });
      expect(lines[1]).toBe("> VERDICT: DELIVERABLE");
      const shown = lines.join("\n");
      expect(shown).toContain("1 GDD row(s) reopened, 0 added");
      expect(shown).toContain("reopened, its check called weak: KP-01 (§3) — asserts true");
      expect(shown).toContain("its VERDICT decides nothing");
      expect(shown).toContain('disclosed only, changed nothing: missing "x": quote too short');
      // In shadow the same findings are recorded and say they held nothing.
      const shadow = renderSecondOpinion({
        ok: true,
        model: "fake-astra",
        text: "VERDICT: DELIVERABLE",
        ms: 2000,
        gate: { reopened: ["KP-01 (§3) — asserts true"], added: [], disclosed: [], mode: "shadow" },
      }).join("\n");
      expect(shadow).toContain("would change (scope gate in shadow: recorded in the rows, delivery not held)");
      // An opinion with no gate record (the gate off, an older row) renders as it always did.
      expect(renderSecondOpinion({ ok: true, model: "m", text: "VERDICT: DELIVERABLE", ms: 1000 })).toEqual([
        "**Independent review (m via Codex, read-only, 1s):**",
        "> VERDICT: DELIVERABLE",
      ]);
    });
  });

  describe("starting the CLI (PRV-20)", () => {
    it("ends the options before the prompt, so a prompt starting with \"-\" stays the prompt", async () => {
      let seen: string[] = [];
      const spawn: CodexSpawn = async (args) => {
        seen = args;
        return { code: 0, stdout: "answer\n", stderr: "", timedOut: false };
      };
      await runCodexSecondOpinion({ projectRoot: "/tmp/p", prompt: "-h is not a flag here" }, spawn);
      expect(seen.at(-1)).toBe("-h is not a flag here");
      expect(seen.at(-2)).toBe("--");
    });

    it("runs the npm shim's script with Node on Windows, since a .cmd cannot be spawned without a shell", () => {
      const npmDir = mkdtempSync(join(tmpdir(), "strada-codex-npm-"));
      try {
        const script = join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
        mkdirSync(join(npmDir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
        writeFileSync(script, "");
        writeFileSync(join(npmDir, "codex.cmd"), "");
        const located = resolveCodexCommand("win32", (name) => (name === "codex.cmd" ? join(npmDir, "codex.cmd") : undefined));
        expect(located).toEqual({ command: process.execPath, prefixArgs: [script] });
      } finally {
        rmSync(npmDir, { recursive: true, force: true });
      }
    });

    it("prefers a native codex.exe on Windows, and runs plain codex elsewhere", () => {
      expect(resolveCodexCommand("win32", (name) => (name === "codex.exe" ? "C:\\bin\\codex.exe" : undefined)))
        .toEqual({ command: "C:\\bin\\codex.exe", prefixArgs: [] });
      expect(resolveCodexCommand("linux", () => { throw new Error("PATH is not consulted off Windows"); }))
        .toEqual({ command: "codex", prefixArgs: [] });
    });
  });
});
