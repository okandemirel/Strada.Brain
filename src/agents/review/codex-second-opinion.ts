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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/** How to start the Codex CLI: an executable and the arguments that precede ours. */
export interface CodexCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/** First match for `name` on PATH (fixed-argv `where`, no shell), or undefined. */
function locateOnWindowsPath(name: string): string | undefined {
  try {
    const located = spawnSync("where", [name], { encoding: "utf8", timeout: 5000 });
    if (located.status !== 0 || typeof located.stdout !== "string") return undefined;
    return located.stdout.split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Codex CLI, startable without a shell.
 *
 * npm installs `codex` on Windows as a `codex.cmd` shim, which a shell-less
 * spawn never finds and Node refuses to run without a shell (CVE-2024-27980),
 * so every delivery on Windows reported "no second opinion". A shell is no
 * way out: the prompt is multi-line, and cmd.exe cannot carry a newline in an
 * argument. So Windows runs a native `codex.exe` when there is one, otherwise
 * the script the shim itself runs, with this Node.
 */
export function resolveCodexCommand(
  platform: NodeJS.Platform = process.platform,
  locate: (name: string) => string | undefined = locateOnWindowsPath,
): CodexCommand {
  if (platform !== "win32") return { command: "codex", prefixArgs: [] };
  const exe = locate("codex.exe");
  if (exe) return { command: exe, prefixArgs: [] };
  const shim = locate("codex.cmd");
  if (shim) {
    const script = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) return { command: process.execPath, prefixArgs: [script] };
  }
  // Nothing better found: the spawn fails, and the review says it could not run.
  return { command: "codex", prefixArgs: [] };
}

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
export function makeCodexSpawn(command?: string): CodexSpawn {
  // Resolved on first use, not at import: on Windows it asks PATH.
  let resolved: CodexCommand | undefined = command ? { command, prefixArgs: [] } : undefined;
  return (args, opts) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      resolved ??= resolveCodexCommand();
      const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
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
    // End of options: a prompt that starts with "-" is still the prompt.
    "--",
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

/**
 * How much of a GDD that is not in the project the review prompt quotes. The
 * prompt travels as ONE command-line argument, and Windows caps a whole
 * command line at 32,767 characters.
 */
export const REVIEW_GDD_QUOTE_CHARS = 16_000;

/** Where the reviewer finds the GDD: its path, or — when no file holds it — its text. */
function reviewGddLines(gddPath: string | undefined, gddText: string | undefined): string[] {
  if (gddPath !== undefined) return [`GDD: ${gddPath} — read it.`];
  // "(unknown path) — read it" sent the reviewer looking, and the design
  // document it found in the project was another one (review
  // campaign-artifacts P3).
  const notHere = "GDD: not saved in this project — do not look for one there: a design document you find in the project is another document.";
  if (gddText === undefined) return [`${notHere} No text of it was handed over; judge against the measurements below.`];
  const cut = gddText.length > REVIEW_GDD_QUOTE_CHARS
    ? ` (the first ${REVIEW_GDD_QUOTE_CHARS} of ${gddText.length} characters; the rest is not quoted)`
    : "";
  return [`${notHere} Its text${cut}:`, "<gdd>", gddText.slice(0, REVIEW_GDD_QUOTE_CHARS), "</gdd>"];
}

/**
 * The most of the GDD rows and their system-written checks the review prompt
 * carries, counted in UTF-8 bytes on every platform: a GDD in
 * a non-Latin script is three bytes a character. The whole argument has its
 * own cap per OS below, and the rows give way to it too.
 */
export const REVIEW_ROWS_MAX_CHARS = 60_000;

/**
 * The whole prompt on Windows, where it is one argument of a command line
 * capped at 32,767 UTF-16 characters, counted as libuv writes it there: every
 * `"` escaped as `\"`, the backslashes before one doubled. The rest of the
 * line is the executable and its options. The rows and checks give way to it,
 * never the question.
 */
export const WINDOWS_REVIEW_PROMPT_MAX_CHARS = 30_000;

/**
 * The whole prompt elsewhere, in UTF-8 bytes: Linux caps ONE argument at
 * 128 KiB (131,072 with its NUL), and the head alone — a GDD quote in a
 * non-Latin script, the measurements, the ladder — can take half of it.
 */
export const POSIX_REVIEW_PROMPT_MAX_BYTES = 120_000;

/** A prompt line's share of the argument on Linux: its UTF-8 bytes and the newline. */
const utf8LineSize = (line: string): number => Buffer.byteLength(line, "utf8") + 1;

/** A prompt line's share of the argument on a Windows command line: each `"` and the backslashes before it are escaped. */
function windowsLineSize(line: string): number {
  let size = line.length + 1;
  for (const m of line.matchAll(/(\\*)"/g)) size += m[1]!.length + 1;
  return size;
}

/** A GDD row the build system holds the game to, as the review prompt lists it. */
export interface ReviewRow {
  readonly rid: string;
  readonly label?: string;
  /** "§3.2", or the heading it sits under. */
  readonly where: string;
  /** The GDD's own words. */
  readonly text: string;
  /** The full name of its current system-written test, when it has one. */
  readonly test?: string;
}

/** A system-written acceptance file, as stored. */
export interface ReviewCheckFile {
  readonly path: string;
  readonly source: string;
}

/** What the scope gate did with a review's findings tail, in a person's words. */
export interface ReviewGateSummary {
  readonly reopened: readonly string[];
  readonly added: readonly string[];
  readonly disclosed: readonly string[];
  /** Shadow records what the findings would hold and decides nothing. */
  readonly mode?: "shadow" | "on";
}

const flat = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The most the rows section may take, in the unit `size` counts a line in. */
interface SectionCap {
  readonly max: number;
  readonly size: (line: string) => number;
}

/**
 * The rows and the checks, within every cap: rows that have a test first,
 * then the test files, then the rows with none yet — so the checks a finding
 * can call weak travel before the list that only stops a reviewer
 * re-reporting a known row. What does not fit is counted, never cut mid-file.
 */
function reviewRowLines(rows: readonly ReviewRow[], checks: readonly ReviewCheckFile[], caps: readonly SectionCap[]): string[] {
  const out: string[] = [];
  const used = caps.map(() => 0);
  let rowsLeft = 0;
  let filesLeft = 0;
  const fits = (lines: readonly string[]): boolean => {
    const sizes = caps.map((cap) => lines.reduce((n, l) => n + cap.size(l), 0));
    // 120 is room for the closing "not shown" count, which is written past the caps.
    if (sizes.some((size, i) => used[i]! + size > caps[i]!.max - 120)) return false;
    sizes.forEach((size, i) => {
      used[i]! += size;
    });
    out.push(...lines);
    return true;
  };
  const rowLine = (r: ReviewRow): string =>
    `- ${r.rid}${r.label ? ` [${r.label}]` : ""} (${flat(r.where, 60)}): "${flat(r.text, 240)}"${r.test ? ` — test ${r.test}` : ""}`;
  const tested = rows.filter((r) => r.test !== undefined);
  const untested = rows.filter((r) => r.test === undefined);
  if (rows.length === 0) fits(["(no GDD row can block yet)"]);
  if (tested.length > 0) fits(["Rows with a system-written check:"]);
  for (const r of tested) if (!fits([rowLine(r)])) rowsLeft += 1;
  if (checks.length > 0) fits(["The checks, as stored (system-owned under Assets/StradaAcceptance; each test's `// REQ <row id>` comment names its row):"]);
  for (const file of checks) if (!fits([`<check-file path="${file.path}">`, file.source, "</check-file>"])) filesLeft += 1;
  if (untested.length > 0) fits(["Rows with no check yet (already known: do not report them as missing):"]);
  for (const r of untested) if (!fits([rowLine(r)])) rowsLeft += 1;
  if (rowsLeft + filesLeft > 0) out.push(`(${rowsLeft} row(s) and ${filesLeft} check file(s) not shown: the prompt's size cap)`);
  return out;
}

/**
 * The delivery question, with the campaign's own measurements handed over so
 * the reviewer argues against evidence, not prose.
 *
 * With `rows` (a requirement ledger decides,) it also carries the
 * GDD rows and the checks the system wrote for them, and asks for a findings
 * tail the gate reads: a weak check reopens its row, a verbatim GDD quote
 * adds one. Without `rows` it is the advisory question it always was.
 */
export function deliveryReviewPrompt(params: {
  gddPath: string | undefined;
  gddText?: string;
  measurements: readonly string[];
  ladder: readonly string[];
  rows?: readonly ReviewRow[];
  checks?: readonly ReviewCheckFile[];
  platform?: NodeJS.Platform;
}): string {
  const head = [
    "You are an independent, adversarial release reviewer for a Unity game built autonomously from a GDD.",
    ...reviewGddLines(params.gddPath, params.gddText),
    "The build system's own measurements of the tree as it stands:",
    ...params.measurements.map((m) => `- ${m}`),
    "Its milestone ladder:",
    ...params.ladder.map((m) => `- ${m}`),
  ];
  const shape = [
    "",
    "Inspect the project (scenes, prefabs, scripts, tests, art) read-only. Answer in this exact shape:",
    "VERDICT: DELIVERABLE | NOT DELIVERABLE",
    "BLOCKERS: numbered list, each with the file(s) and the GDD requirement it fails; 'none' if none",
    "DISAGREEMENTS: where the measurements above are wrong or misleading, with evidence; 'none' if none",
    "NEXT: the three most valuable concrete changes, each one sentence",
  ];
  const close = ["Be terse and specific. Do not restate the GDD."];
  if (params.rows === undefined) return [...head, ...shape, ...close].join("\n");

  const findings = [
    "FINDINGS: last, ONE JSON object on its own, with nothing after it:",
    '{"weakChecks":[{"rid":"<row id>","why":"<how the check passes on a game that does not do what its row says>"}],"missing":[{"gddQuote":"<the GDD\'s exact words, at least 20 characters>","why":"<what the game lacks>"}]}',
    "weakChecks: only checks shown above, named by their row id — a check that asserts a literal, reflects on types, or observes something other than its row. " +
      "missing: only GDD rules the game does not meet that no row above states, quoted verbatim from the GDD; a paraphrase is discarded. " +
      "Empty arrays when there is nothing. These findings can reopen a row or add one; they never close one.",
  ];
  const intro = ["", "The GDD rows the build system holds this game to, and the acceptance checks it wrote for them:"];
  // The rows get what the rest of the ONE argument leaves, counted in the
  // unit its OS caps it in; the 2 is the quotes around it, or its NUL.
  const windows = (params.platform ?? process.platform) === "win32";
  const argSize = windows ? windowsLineSize : utf8LineSize;
  const fixed = [...head, ...intro, ...shape, ...findings, ...close].reduce((n, l) => n + argSize(l), 2);
  const caps: SectionCap[] = [
    { max: REVIEW_ROWS_MAX_CHARS, size: utf8LineSize },
    { max: Math.max(0, (windows ? WINDOWS_REVIEW_PROMPT_MAX_CHARS : POSIX_REVIEW_PROMPT_MAX_BYTES) - fixed), size: argSize },
  ];
  return [...head, ...intro, ...reviewRowLines(params.rows, params.checks ?? [], caps), ...shape, ...findings, ...close].join("\n");
}

function renderReviewGate(gate: ReviewGateSummary): string[] {
  const head =
    gate.mode === "shadow"
      ? "**What the review's findings would change (scope gate in shadow: recorded in the rows, delivery not held):**"
      : "**What the review's findings changed:**";
  const lines = [
    gate.reopened.length + gate.added.length === 0
      ? `${head} nothing — no GDD row was reopened or added.`
      : `${head} ${gate.reopened.length} GDD row(s) reopened, ${gate.added.length} added; ` +
        "each stays open until a system check of its own passes. The review never closes a row, and its VERDICT decides nothing.",
  ];
  for (const r of gate.reopened.slice(0, 8)) lines.push(`- reopened, its check called weak: ${r}`);
  if (gate.reopened.length > 8) lines.push(`- …and ${gate.reopened.length - 8} more reopened`);
  for (const a of gate.added.slice(0, 8)) lines.push(`- added from the GDD's own words, queued: ${a}`);
  if (gate.added.length > 8) lines.push(`- …and ${gate.added.length - 8} more added`);
  if (gate.disclosed.length > 0) {
    lines.push(`- disclosed only, changed nothing: ${flat(gate.disclosed.slice(0, 6).join("; "), 600)}${gate.disclosed.length > 6 ? ` (+${gate.disclosed.length - 6} more)` : ""}`);
  }
  return lines;
}

export function renderSecondOpinion(opinion: (SecondOpinion & { readonly gate?: ReviewGateSummary }) | undefined): string[] {
  if (!opinion) return ["**Independent review:** not run."];
  if (!opinion.ok) {
    return [`**Independent review (${opinion.model} via Codex):** UNAVAILABLE — ${opinion.error ?? "unknown error"}. This delivery carries no second opinion.`];
  }
  return [
    `**Independent review (${opinion.model} via Codex, read-only, ${Math.round(opinion.ms / 1000)}s):**`,
    ...opinion.text.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")),
    ...(opinion.gate ? renderReviewGate(opinion.gate) : []),
  ];
}
