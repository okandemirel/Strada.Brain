/**
 * The Unity editor is one process driving one project. This is the queue in
 * front of it.
 *
 * audited 2026-09-02: `isParallelSafeToolCall` keeps the verification tools out
 * of the leading parallel group, but that only orders the calls inside ONE
 * model turn. Two tasks — two sub-agents, two supervisor nodes, two Orchestrator
 * instances in the one process — take their turns concurrently, so two
 * `unity_verify_change` calls could sit in the editor together: each one
 * restarts the other's compile and reads the other's console, and both verdicts
 * then describe code neither call compiled. A verdict about the wrong code is
 * worse than a slow one, so callers QUEUE here; nothing is ever refused for
 * being second, and the wait is logged with what it waited behind.
 *
 * Process-wide by construction: the state is module-level, because the thing
 * being protected (the editor) is not owned by any Orchestrator instance.
 */

import { getLogger } from "../utils/logger.js";

/**
 * Tools that DRIVE the editor rather than merely read a file the editor wrote.
 *
 * The three prefixes mirror `isParallelSafeToolCall`'s within-turn rule;
 * `unity_prerender_frames` is named outright because it drops a one-shot render
 * script into the project, runs it, and deletes it again — two at once
 * overwrite each other's script and each other's output.
 */
const EDITOR_EXCLUSIVE_PREFIXES = ["unity_verify", "unity_compile", "unity_playmode"] as const;
const EDITOR_EXCLUSIVE_NAMES: ReadonlySet<string> = new Set(["unity_prerender_frames"]);

/** Does this tool need the editor to itself? */
export function isUnityEditorExclusiveTool(toolName: string): boolean {
  return (
    EDITOR_EXCLUSIVE_NAMES.has(toolName) ||
    EDITOR_EXCLUSIVE_PREFIXES.some((prefix) => toolName.startsWith(prefix))
  );
}

/** Tail of the wait queue: resolves when the current holder has released. */
let queueTail: Promise<void> = Promise.resolve();
/** The tool currently in the editor, so a waiter can say what it waited behind. */
let currentHolder: string | null = null;

/** What a caller waited for. Reported only when it actually waited. */
export interface UnityEditorWait {
  readonly waitedMs: number;
  readonly behind: string;
}

/**
 * Run `run` with exclusive use of the editor, queueing behind any call already
 * holding it. The lock is released whether `run` resolves or throws — a crashed
 * verification must not lock the editor for the life of the process — and the
 * error is rethrown to the caller unchanged.
 */
export async function withUnityEditorLock<T>(
  toolName: string,
  run: () => Promise<T>,
  onWait?: (wait: UnityEditorWait) => void,
): Promise<T> {
  const predecessor = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  const behind = currentHolder;
  const waitStart = Date.now();
  // A predecessor that rejected still hands the editor on; its error belongs to
  // its own caller, not to whoever is next in line.
  await predecessor.catch(() => undefined);
  if (behind !== null) {
    onWait?.({ waitedMs: Date.now() - waitStart, behind });
  }

  currentHolder = toolName;
  try {
    return await run();
  } finally {
    currentHolder = null;
    release();
  }
}

/** Log the wait at the call site's chat/tool, so a slow verify is explainable. */
export function logUnityEditorWait(
  toolName: string,
  chatId: string,
  wait: UnityEditorWait,
): void {
  getLogger().info("Waited for the Unity editor", {
    chatId,
    tool: toolName,
    behind: wait.behind,
    waitedMs: wait.waitedMs,
  });
}
