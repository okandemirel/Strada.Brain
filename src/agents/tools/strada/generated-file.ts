import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileInsideRoot } from "../file-write.js";

/**
 * Write a generated stub only where nothing is there yet.
 *
 * The strada_create_* tools wrote with a plain writeFile, which truncates: a
 * module folder that already held an implemented <Name>System.cs got it replaced
 * by the template, and the tool reported "created" (audit tools#0). The
 * conformance gate sends the agent to strada_create_module precisely when a
 * module folder already holds code, so that was the normal path, not a corner.
 *
 * The file is opened O_CREAT|O_EXCL through the same root-contained,
 * no-follow open file_write uses: an existing file — or one that appears
 * between a check and the write — is left untouched and reported as "kept".
 */
export async function createGeneratedFile(
  projectPath: string,
  fullPath: string,
  content: string,
): Promise<"created" | "kept"> {
  await mkdir(dirname(fullPath), { recursive: true });
  try {
    await writeFileInsideRoot(projectPath, fullPath, content, { exclusive: true });
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "kept";
    throw error;
  }
}

/**
 * The refusal a single-file generator gives for a path that is not a .cs file,
 * or null when it is one. Unity compiles only .cs files: a mediator written to
 * `…/EnemyMediator` was reported created and never existed as a type.
 */
export function notCsFile(kind: string, relPath: string, className: string): string | null {
  if (/\.cs$/i.test(relPath)) return null;
  return (
    `Error: path must name the .cs file the ${kind} goes in (e.g., '…/${className}.cs'); ` +
    `'${relPath}' is not one, and Unity compiles only .cs files. No ${kind} was generated.`
  );
}

/** The refusal a single-file generator gives for a path that is already taken. */
export function alreadyExists(kind: string, relPath: string): string {
  return (
    `Error: ${relPath} already exists, so no ${kind} was generated and the file was left as it was. ` +
    "Read it and edit it to change it; delete it first only if replacing it with a fresh stub is really what you want."
  );
}
