// ---------------------------------------------------------------------------
// A decomposition reply the parser could not read is kept whole on disk.
//
// 2026-09-09 17:33-19:41: five replies in one evening — 33k, 125k, 13.8k,
// 40k chars — each logged as a 300-char preview and a few flags, none of
// which said what the text after </reasoning> looked like, so every parser
// fix that day was a guess. One file per failure under
// ~/.strada/analysis/decomposition-failures/, capped so a bad night cannot
// fill the disk.
// ---------------------------------------------------------------------------
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const DECOMPOSITION_FAILURE_CAP = 200;

export function decompositionFailureRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env["STRADA_DECOMPOSITION_FAILURE_DIR"]) return env["STRADA_DECOMPOSITION_FAILURE_DIR"];
  if (env["VITEST"]) return join(tmpdir(), "strada-decomposition-failures");
  return join(env["STRADA_HOME"] ?? homedir(), ".strada", "analysis", "decomposition-failures");
}

/** Path of the archived reply, or undefined when nothing could be written (never throws). */
export function archiveDecompositionFailure(text: string, root: string = decompositionFailureRoot(), at: Date = new Date()): string | undefined {
  try {
    mkdirSync(root, { recursive: true });
    if (readdirSync(root).length >= DECOMPOSITION_FAILURE_CAP) return undefined;
    const stamp = at.toISOString().replace(/[:.]/g, "-");
    for (let n = 0; n < 50; n++) {
      const file = join(root, `${stamp}${n === 0 ? "" : `-${n}`}.txt`);
      try {
        writeFileSync(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return file;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
