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
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOOL_FAILURE_ARCHIVE_DIR = "tool-failures";
/** Inputs are kept for context, not as a second copy of a file the tool wrote. */
const INPUT_CHARS = 4_000;

export function toolFailureArchiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["STRADA_HOME"] ?? homedir(), ".strada", TOOL_FAILURE_ARCHIVE_DIR);
}

export interface ArchivedToolFailure {
  readonly tool: string;
  readonly chatId: string;
  readonly input: unknown;
  readonly content: string;
  readonly at?: Date;
}

/** One file per failure; returns its path, or undefined when the disk refused (never throws). */
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
  if (inputText.length > INPUT_CHARS) inputText = `${inputText.slice(0, INPUT_CHARS)}\n… (${inputText.length - INPUT_CHARS} more chars)`;
  const body =
    `tool: ${failure.tool}\nchatId: ${failure.chatId}\nat: ${at.toISOString()}\n\n` +
    `== input ==\n${inputText}\n\n== result (${failure.content.length} chars) ==\n${failure.content}\n`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body, "utf8");
    return file;
  } catch {
    return undefined;
  }
}
