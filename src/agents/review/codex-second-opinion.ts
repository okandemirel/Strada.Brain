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

const defaultSpawn: CodexSpawn = (args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn("codex", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });

export function codexModel(): string {
  return process.env["STRADA_CODEX_MODEL"] ?? "gpt-6-astra";
}

export function codexEffort(): string {
  return process.env["STRADA_CODEX_EFFORT"] ?? "high";
}

/** The answer is the text after the last "tokens used" footer, else everything. */
export function extractCodexAnswer(stdout: string): string {
  const lines = stdout.split("\n");
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^tokens used\b/i.test(lines[i]!.trim())) { cut = i; break; }
  }
  // The footer is "tokens used" and a count on the next line(s).
  let from = cut + 1;
  while (cut >= 0 && from < lines.length && /^[\d.,\s]*$/.test(lines[from]!)) from++;
  const tail = cut >= 0 ? lines.slice(from) : lines;
  // Codex prints the answer once before the footer and once after; keep the
  // after-copy when present, otherwise the whole output.
  const text = tail.join("\n").trim();
  if (text) return text;
  return lines.slice(0, cut >= 0 ? cut : undefined).join("\n").trim();
}

export async function runCodexSecondOpinion(opts: CodexRunOptions, spawnImpl: CodexSpawn = defaultSpawn): Promise<SecondOpinion> {
  const model = opts.model ?? codexModel();
  const effort = opts.effort ?? codexEffort();
  const started = Date.now();
  const args = [
    "exec",
    "-m", model,
    "-c", `model_reasoning_effort=${effort}`,
    "-s", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C", opts.projectRoot,
    opts.prompt,
  ];
  try {
    const run = await spawnImpl(args, { cwd: opts.projectRoot, timeoutMs: opts.timeoutMs ?? 15 * 60_000 });
    const ms = Date.now() - started;
    if (run.timedOut) return { ok: false, model, text: "", ms, error: `codex timed out after ${Math.round(ms / 1000)}s` };
    if (run.code !== 0) return { ok: false, model, text: "", ms, error: `codex exited ${run.code}: ${(run.stderr || run.stdout).trim().slice(-300)}` };
    const text = extractCodexAnswer(run.stdout);
    if (!text) return { ok: false, model, text: "", ms, error: "codex returned no answer" };
    return { ok: true, model, text, ms };
  } catch (err) {
    return { ok: false, model, text: "", ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
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
