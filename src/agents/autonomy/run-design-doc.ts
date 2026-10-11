import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The design document a run is held to, when the run serves a campaign: the
 * campaign's GDD text, or no text when the campaign carries none.
 */
export interface RunDesignDoc {
  readonly text?: string;
}

const current = new AsyncLocalStorage<RunDesignDoc | null>();

/**
 * Runs `fn` with `doc` as the design document of every run it starts.
 *
 * Ambient rather than threaded: a campaign task's supervisor nodes, delegates
 * and decomposed goals each build a conformance guard of their own, and none
 * of them is handed the task. `null` says the work serves no campaign, so it
 * does not inherit the document of the task that happened to start it.
 */
export function withRunDesignDoc<T>(doc: RunDesignDoc | null, fn: () => T): T {
  return current.run(doc, fn);
}

/** The design document of the run in progress; undefined when it serves no campaign. */
export function currentRunDesignDoc(): RunDesignDoc | undefined {
  return current.getStore() ?? undefined;
}
