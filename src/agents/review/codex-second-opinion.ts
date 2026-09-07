/**
 * An independent second opinion from a different model family, through the
 * Codex CLI (`codex exec`, read-only sandbox, ephemeral).
 *
 * The campaign judges its own delivery with its own measurements; the user
 * asked (2026-09-07) for a second, independent verdict before anything is
 * called delivered. This runs OpenAI's Codex with the configured model
 * (default gpt-6-astra, reasoning effort high) against the project directory
 * and returns its text verbatim, or the reason it could not run — a review
 * that did not happen is reported as such, never blended into a pass.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SecondOpinion {
  readonly ok: boolean;
  readonly model: string;
  readonly text: string;
  readonly ms: number;
  readonly error?: string;
}

export interface CodexRunOptions {
  readonly projectRoot: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly effort?: string;
}

export type CodexSpawn = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

/**
 * Spawn `command` in its own process group and settle at the deadline no
 * matter what.
 *
 * Codex review 2026-09-07: the earlier version killed only the codex process
 * and then waited for "close", which fires only when every holder of the
 * stdout/stderr pipes has gone — a descendant that inherited them (a shell,
 * a tool codex launched) kept the delivery waiting past the timeout, for as
 * long as it lived. Now the whole process group is killed and the promise is
 * resolved by the timer itself, with whatever output had arrived.
 */
export function makeCodexSpawn(command = "codex"): CodexSpawn {
  return (args, opts) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      const settle = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const killTree = (): void => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* already gone */ }
      };
      const timer = setTimeout(() => {
        killTree();
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ code: null, stdout, stderr, timedOut: true });
      }, opts.timeoutMs);
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err) => settle({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false }));
      child.on("close", (code) => settle({ code, stdout, stderr, timedOut: false }));
    });
}

const defaultSpawn: CodexSpawn = makeCodexSpawn();

export function codexModel(): string {
  return process.env["STRADA_CODEX_MODEL"] ?? "gpt-6-astra";
}

export function codexEffort(): string {
  return process.env["STRADA_CODEX_EFFORT"] ?? "high";
}

/**
 * The answer is the output with a TRAILING "tokens used" footer removed.
 *
 * Only a footer at the very end is transport framing. Codex review
 * 2026-09-07: the earlier version cut at the LAST "tokens used" line anywhere
 * in the output, so an answer that quoted those words (a reviewer citing a
 * file that contains them) lost everything before the quote — a rejection
 * followed by a quoted "VERDICT: DELIVERABLE" came back as the pass.
 */
export function extractCodexAnswer(stdout: string): string {
  const lines = stdout.split("\n");
  let end = lines.length;
  while (end > 0 && /^[\d.,\s]*$/.test(lines[end - 1]!)) end--;
  if (end > 0 && /^tokens used\b/i.test(lines[end - 1]!.trim())) end--;
  return lines.slice(0, end).join("\n").trim();
}

/** Whether a prompt that asked for a VERDICT line got one — anything else is not a review. */
export function hasVerdict(text: string): boolean {
  return /^\s*VERDICT:\s*(NOT DELIVERABLE|DELIVERABLE)\b/m.test(text);
}

export async function runCodexSecondOpinion(opts: CodexRunOptions, spawnImpl: CodexSpawn = defaultSpawn): Promise<SecondOpinion> {
  const model = opts.model ?? codexModel();
  const effort = opts.effort ?? codexEffort();
  const started = Date.now();
  // The final assistant message goes to a file of its own (`-o`), so the
  // answer never has to be told apart from progress or footers on stdout;
  // stdout is the fallback when the file is absent (an older CLI, a fake).
  let scratch: string | undefined;
  let lastMessagePath: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "strada-codex-"));
    lastMessagePath = join(scratch, "last-message.md");
  } catch { /* no scratch dir: stdout only */ }
  const args = [
    "exec",
    "-m", model,
    "-c", `model_reasoning_effort=${effort}`,
    "-s", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C", opts.projectRoot,
    ...(lastMessagePath ? ["-o", lastMessagePath] : []),
    opts.prompt,
  ];
  try {
    const run = await spawnImpl(args, { cwd: opts.projectRoot, timeoutMs: opts.timeoutMs ?? 15 * 60_000 });
    const ms = Date.now() - started;
    if (run.timedOut) return { ok: false, model, text: "", ms, error: `codex timed out after ${Math.round(ms / 1000)}s` };
    if (run.code !== 0) return { ok: false, model, text: "", ms, error: `codex exited ${run.code}: ${(run.stderr || run.stdout).trim().slice(-300)}` };
    let text = "";
    if (lastMessagePath) {
      try { text = readFileSync(lastMessagePath, "utf8").trim(); } catch { /* fall back to stdout */ }
    }
    if (!text) text = extractCodexAnswer(run.stdout);
    if (!text) return { ok: false, model, text: "", ms, error: "codex returned no answer" };
    if (/VERDICT:/.test(opts.prompt) && !hasVerdict(text)) {
      return { ok: false, model, text: "", ms, error: `codex returned no VERDICT line (got: ${text.slice(0, 120).replace(/\s+/g, " ")}…)` };
    }
    return { ok: true, model, text, ms };
  } catch (err) {
    return { ok: false, model, text: "", ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/** The delivery question, with the campaign's own measurements handed over so the reviewer argues against evidence, not prose. */
export function deliveryReviewPrompt(params: { gddPath: string | undefined; measurements: readonly string[]; ladder: readonly string[] }): string {
  return [
    "You are an independent, adversarial release reviewer for a Unity game built autonomously from a GDD.",
    `GDD: ${params.gddPath ?? "(unknown path)"} — read it.`,
    "The build system's own measurements of the tree as it stands:",
    ...params.measurements.map((m) => `- ${m}`),
    "Its milestone ladder:",
    ...params.ladder.map((m) => `- ${m}`),
    "",
    "Inspect the project (scenes, prefabs, scripts, tests, art) read-only. Answer in this exact shape:",
    "VERDICT: DELIVERABLE | NOT DELIVERABLE",
    "BLOCKERS: numbered list, each with the file(s) and the GDD requirement it fails; 'none' if none",
    "DISAGREEMENTS: where the measurements above are wrong or misleading, with evidence; 'none' if none",
    "NEXT: the three most valuable concrete changes, each one sentence",
    "Be terse and specific. Do not restate the GDD.",
  ].join("\n");
}

export function renderSecondOpinion(opinion: SecondOpinion | undefined): string[] {
  if (!opinion) return ["**Independent review:** not run."];
  if (!opinion.ok) {
    return [`**Independent review (${opinion.model} via Codex):** UNAVAILABLE — ${opinion.error ?? "unknown error"}. This delivery carries no second opinion.`];
  }
  return [
    `**Independent review (${opinion.model} via Codex, read-only, ${Math.round(opinion.ms / 1000)}s):**`,
    ...opinion.text.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")),
  ];
}
