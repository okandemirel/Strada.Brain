import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
 * than widening confinement for everything. "The user's own message" means text
 * a person sent through a channel, recorded where that message arrives — never
 * a task prompt, sub-goal or delegation brief a model wrote, and never a
 * user-role turn the agent synthesized inside a run.
 *
 * Read-only, exact paths only. This never authorizes a write, never authorizes a
 * directory, and never authorizes anything derived from an authorized path.
 */

/**
 * A quoted span that starts like a path is one path, spaces and all. Without
 * this the pattern below stopped at the first space even inside quotes:
 * "/Users/o/Desktop/Match 3 GDD.docx" authorized "/Users/o/Desktop/Match" and
 * never the document (audit 2026-10, security-config#3).
 */
const QUOTED_PATH_PATTERN = /(["'`])((?:\/|~\/|[A-Za-z]:[\\/]|file:\/\/)(?:(?!\1)[^\n])*)\1/gu;

/**
 * Absolute-looking paths in a message: POSIX /… and ~/…, Windows C:\…, and
 * file:// URLs. A POSIX path may carry shell escapes, as a path dragged into a
 * terminal does (Match\ 3\ GDD.docx); a Windows path's backslashes are its
 * separators.
 */
const PATH_PATTERN =
  /(?:^|[\s"'`(<])((?:\/|~\/)(?:\\[^\n]|[^\s"'`)<>|\\])+|[A-Za-z]:[\\/][^\s"'`)<>|]+|file:\/\/[^\s"'`)<>|]+)/gu;

/**
 * Trailing punctuation belongs to the sentence, not the path: "read /a/b.md."
 * names b.md, not "b.md.". An escaped character is the path's own.
 */
function trimSentencePunctuation(candidate: string): string {
  return candidate.replace(/(?<!\\)[.,;:!?)\]}]+$/u, "");
}

/**
 * A path as the user wrote it, as an absolute path: `~/` is their home
 * directory (not another account's `~bob/`), everything else is resolved.
 */
export function resolveUserNamedPath(named: string): string {
  return named.startsWith("~/") ? join(homedir(), named.slice(2)) : resolve(named);
}

/** What one matched candidate names, or undefined when it names no file. */
function namedPathOf(candidate: string, quoted: boolean): string | undefined {
  let text = trimSentencePunctuation(quoted ? candidate.trimEnd() : candidate);
  if (/^file:\/\//iu.test(text)) {
    try {
      text = fileURLToPath(text);
    } catch {
      return undefined;
    }
  } else if (!quoted && (text.startsWith("/") || text.startsWith("~/"))) {
    text = text.replace(/\\(.)/gu, "$1");
  }
  // A bare "/" or a path with no name is not a file the user asked for.
  if (text.length < 2) return undefined;
  return resolveUserNamedPath(text);
}

/** Every absolute path the user wrote, resolved and de-duplicated. */
export function extractUserAuthorizedPaths(message: string): string[] {
  if (!message) return [];

  const found = new Set<string>();
  // Quoted spans first, then blanked: their words are not paths of their own.
  const unquoted = message.replace(QUOTED_PATH_PATTERN, (_span, _quote: string, candidate: string) => {
    const named = namedPathOf(candidate, true);
    if (named !== undefined) found.add(named);
    return " ";
  });
  for (const match of unquoted.matchAll(PATH_PATTERN)) {
    const named = namedPathOf(match[1] ?? "", false);
    if (named !== undefined) found.add(named);
  }
  return [...found];
}

/** How many chats' authorizations one store keeps; the least recently written go first. */
export const MAX_AUTHORIZED_CHATS = 256;

/** How many paths one chat keeps; the oldest go first. */
export const MAX_AUTHORIZED_PATHS_PER_CHAT = 64;

/**
 * Add `paths` to what `key` may read, keeping the store bounded.
 *
 * The store is process-wide and keyed by chat, and every chat used to keep its
 * entry for the life of the daemon. Map order doubles as recency: a written key
 * is moved to the end, and the front is evicted past the cap.
 */
export function rememberUserAuthorizedPaths(
  store: Map<string, readonly string[]>,
  key: string,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  const merged = [...new Set([...(store.get(key) ?? []), ...paths])];
  store.delete(key);
  store.set(key, merged.slice(-MAX_AUTHORIZED_PATHS_PER_CHAT));
  while (store.size > MAX_AUTHORIZED_CHATS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
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
  const resolved = resolveUserNamedPath(target);
  return authorized.some((candidate) => candidate === resolved);
}
