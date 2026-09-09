/**
 * The full text of a failed tool result, kept on disk.
 *
 * Measured 2026-09-08 03:46: unity_verify_change answered "Headless compile
 * failed with 1559 error(s)" inside a lease whose only changes were four
 * PNGs, two prefabs and a scene. The log kept one line of it; the compile
 * output — which assemblies were missing, which editor ran, which mode the
 * check took — went into the model's context and nowhere else, so the
 * question "why did a package-only compile break" could not be answered
 * after the fact. A failure's evidence is worth a file.
 *
 * Reviewed 2026-09-08 04:10 (first version): it archived AFTER the 8 KB
 * truncation the model sees, so the compile output was still cut; it wrote
 * the tool input verbatim, so a failed shell_exec carrying a bearer token
 * put the token on disk in a 0644 file; unit tests wrote into the user's
 * real ~/.strada; and 82 files appeared in six minutes with no bound. This
 * version archives the untruncated result, redacts both halves, keeps
 * tests in the run's temp root, and caps a day at ARCHIVE_DAY_CAP files.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { redactSensitiveText } from "./orchestrator-text-utils.js";
import { applySecretPatterns, DEFAULT_SECRET_PATTERNS } from "../security/secret-patterns.js";

export const TOOL_FAILURE_ARCHIVE_DIR = "tool-failures";
/** Inputs are kept for context, not as a second copy of a file the tool wrote. */
const INPUT_CHARS = 4_000;
/** Beyond this many files in one day, further failures are counted, not written. */
export const ARCHIVE_DAY_CAP = 500;
/** Day directories older than this are removed the first time the process archives. */
export const ARCHIVE_KEEP_DAYS = 14;

/**
 * Under vitest the archive lives in the run's temp root (removed with the
 * run); everywhere else under ~/.strada. STRADA_TOOL_FAILURE_DIR overrides.
 */
export function toolFailureArchiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env["STRADA_TOOL_FAILURE_DIR"]) return env["STRADA_TOOL_FAILURE_DIR"];
  if (env["VITEST"]) return join(tmpdir(), "strada-tool-failures");
  return join(env["STRADA_HOME"] ?? homedir(), ".strada", TOOL_FAILURE_ARCHIVE_DIR);
}

export interface ArchivedToolFailure {
  readonly tool: string;
  readonly chatId: string;
  readonly input: unknown;
  /** The result as the tool returned it — before any truncation for the model. */
  readonly content: string;
  readonly at?: Date;
}

/** Day (YYYY-MM-DD) each root was last pruned for — a long-lived daemon crosses midnights. */
const prunedRootDay = new Map<string, string>();

/** Remove day directories older than ARCHIVE_KEEP_DAYS; once per root per process. */
function pruneOldDays(root: string, today: Date): void {
  // Once per root per DAY, not once per process: Codex review 2026-09-09 —
  // archive September 8, then October 8 in the same process, and September
  // stayed. A daemon that runs for weeks accumulated every day it had seen.
  const day = today.toISOString().slice(0, 10);
  if (prunedRootDay.get(root) === day) return;
  prunedRootDay.set(root, day);
  const cutoff = new Date(today.getTime() - ARCHIVE_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  let days: string[];
  try {
    days = readdirSync(root);
  } catch {
    return;
  }
  for (const day of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
      try { rmSync(join(root, day), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * One file per failure; returns its path, or undefined when the day is at
 * its cap or the disk refused (never throws).
 */
export function archiveToolFailure(failure: ArchivedToolFailure, root: string = toolFailureArchiveRoot()): string | undefined {
  const at = failure.at ?? new Date();
  const day = at.toISOString().slice(0, 10);
  const stamp = at.toISOString().slice(11, 19).replace(/:/g, "") + "-" + String(at.getMilliseconds()).padStart(3, "0");
  const safeTool = failure.tool.replace(/[^A-Za-z0-9_.-]/g, "_");
  const dir = join(root, day);
  const file = join(dir, `${stamp}-${safeTool}.txt`);
  let inputText: string;
  try {
    inputText = JSON.stringify(failure.input, null, 2) ?? "undefined";
  } catch {
    inputText = String(failure.input);
  }
  // Redact BEFORE truncating (review 2026-09-08: a key straddling the cut
  // kept its head), and with the logger's own pattern set — private keys,
  // password=, AWS secrets — not only the API-key prefixes.
  inputText = redact(inputText);
  if (inputText.length > INPUT_CHARS) inputText = `${inputText.slice(0, INPUT_CHARS)}\n… (${inputText.length - INPUT_CHARS} more chars)`;
  const content = redact(failure.content);
  const body =
    `tool: ${failure.tool}\nchatId: ${failure.chatId}\nat: ${at.toISOString()}\n\n` +
    `== input ==\n${inputText}\n\n== result (${content.length} chars) ==\n${content}\n`;
  try {
    pruneOldDays(root, at);
    mkdirSync(dir, { recursive: true });
    if (existsSync(dir) && readdirSync(dir).length >= ARCHIVE_DAY_CAP) return undefined;
    // Same tool, same millisecond (parallel file_reads in one turn — review
    // 2026-09-08: five refusals left two files) — never overwrite, suffix.
    for (let n = 0; n < 100; n++) {
      const candidate = n === 0 ? file : file.replace(/\.txt$/, `-${n}.txt`);
      try {
        writeFileSync(candidate, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function redact(text: string): string {
  // The logger's pattern set, but never its 8 KB cut: the archive exists to
  // keep the whole result.
  return applySecretPatterns(redactSensitiveText(text), DEFAULT_SECRET_PATTERNS, Number.MAX_SAFE_INTEGER).content;
}
