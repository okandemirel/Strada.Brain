import { resolve } from "node:path";

/**
 * Files the user named themselves, and may therefore be read.
 *
 * Path confinement stops the agent reaching outside the project, which is right
 * for anything it chooses on its own. It also blocked the product's central
 * scenario: the user hands over a game design document and asks for the game to
 * be built. Such a document lives on a desktop or in another repository, not
 * inside the Unity project — measured, the agent tried twice and was refused
 * with "Command attempts to read an absolute file outside the project
 * directory", never read the document, and planned a generic game from the one
 * sentence it had. None of the design's actual content — the board, the swap,
 * the cascade — appears anywhere in that run.
 *
 * The authorization comes from the user's own message. A path they typed is a
 * path they asked to be read, which is a narrower and more honest permission
 * than widening confinement for everything.
 *
 * Read-only, exact paths only. This never authorizes a write, never authorizes a
 * directory, and never authorizes anything derived from an authorized path.
 */

/** Absolute-looking paths in a message: POSIX /… and Windows C:\… */
const PATH_PATTERN = /(?:^|[\s"'`(<])((?:\/|[A-Za-z]:[\\/])[^\s"'`)<>|]+)/gu;

/**
 * Trailing punctuation belongs to the sentence, not the path: "read /a/b.md."
 * names b.md, not "b.md.".
 */
function trimSentencePunctuation(candidate: string): string {
  return candidate.replace(/[.,;:!?)\]}]+$/u, "");
}

/** Every absolute path the user wrote, resolved and de-duplicated. */
export function extractUserAuthorizedPaths(message: string): string[] {
  if (!message) return [];

  const found = new Set<string>();
  for (const match of message.matchAll(PATH_PATTERN)) {
    const candidate = trimSentencePunctuation(match[1] ?? "");
    // A bare "/" or a path with no name is not a file the user asked for.
    if (candidate.length < 2) continue;
    found.add(resolve(candidate));
  }
  return [...found];
}

/**
 * May this exact file be read on the user's authority?
 *
 * Compares resolved paths for equality. Prefix matching would turn a named file
 * into a named directory, and a named directory into everything beneath it.
 */
export function isUserAuthorizedPath(
  target: string,
  authorized: readonly string[] | undefined,
): boolean {
  if (!authorized || authorized.length === 0) return false;
  const resolved = resolve(target);
  return authorized.some((candidate) => candidate === resolved);
}
