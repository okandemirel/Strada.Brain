/**
 * The run's outcome as data (GDD-drift plan W00/W01).
 *
 * A sprint that ended on "loop detected" was settled green, because the only
 * trace of how it ended was a localized sentence in its result, and the gate
 * read prose. The key travels as data from W01 on; these pin the order the
 * scope gate folds a run's keys into one, so "red outranks an outage" and
 * "an outage outranks a clean finish" cannot drift between the items that
 * read it.
 */

import { describe, expect, it } from "vitest";
import {
  OUTAGE_TERMINALS,
  RED_TERMINALS,
  TERMINAL_KEYS,
  isTerminalKey,
  terminalClass,
  worstTerminal,
  type TerminalKey,
} from "./terminal-key.js";

describe("terminal keys", () => {
  it("every key is in exactly one class", () => {
    for (const key of TERMINAL_KEYS) {
      const inRed = RED_TERMINALS.has(key);
      const inOutage = OUTAGE_TERMINALS.has(key);
      expect(inRed && inOutage, key).toBe(false);
      const expected = inRed ? "red" : inOutage ? "outage" : key === "done" ? "done" : "interrupted";
      expect(terminalClass(key), key).toBe(expected);
    }
    expect(TERMINAL_KEYS.filter((k) => terminalClass(k) === "interrupted")).toEqual(["interrupted"]);
  });

  it("a stuck, cut-short or crashed run is red; a provider that failed it is an outage", () => {
    for (const key of ["task_stuck", "max_steps_reached", "token_budget_exceeded", "cut_short", "error"] as const) {
      expect(terminalClass(key), key).toBe("red");
    }
    for (const key of ["provider_quota", "provider_abort", "provider_ask_user"] as const) {
      expect(terminalClass(key), key).toBe("outage");
    }
  });

  it("recognizes only the keys it defines", () => {
    expect(isTerminalKey("task_stuck")).toBe(true);
    expect(isTerminalKey("done")).toBe(true);
    // Today's message key for a slow provider is not a terminal.
    expect(isTerminalKey("provider_slow")).toBe(false);
    expect(isTerminalKey("TASK_STUCK")).toBe(false);
    expect(isTerminalKey(undefined)).toBe(false);
    expect(isTerminalKey(3)).toBe(false);
  });
});

describe("worstTerminal: red, then outage, then interrupted, then done", () => {
  it("red outranks an outage, whichever came first", () => {
    // A measured m6: ten task_stuck stamps and a quota stamp; the red one decides.
    expect(worstTerminal(["provider_quota", "task_stuck"])).toBe("task_stuck");
    expect(worstTerminal(["task_stuck", "provider_quota"])).toBe("task_stuck");
    expect(worstTerminal(["done", "cut_short", "provider_abort"])).toBe("cut_short");
  });

  it("an outage outranks an interruption, and an interruption outranks done", () => {
    expect(worstTerminal(["done", "interrupted", "provider_ask_user"])).toBe("provider_ask_user");
    expect(worstTerminal(["done", "interrupted", "done"])).toBe("interrupted");
    expect(worstTerminal(["done", "done"])).toBe("done");
  });

  it("is deterministic inside a class: the key listed first in TERMINAL_KEYS wins", () => {
    expect(worstTerminal(["error", "task_stuck"])).toBe("task_stuck");
    expect(worstTerminal(["provider_ask_user", "provider_quota"])).toBe("provider_quota");
  });

  it("orders every pair of classes, not just the ones above", () => {
    const rank = { red: 3, outage: 2, interrupted: 1, done: 0 } as const;
    for (const a of TERMINAL_KEYS) {
      for (const b of TERMINAL_KEYS) {
        const worst = worstTerminal([a, b]) as TerminalKey;
        expect(rank[terminalClass(worst)], `${a} vs ${b}`).toBe(Math.max(rank[terminalClass(a)], rank[terminalClass(b)]));
      }
    }
  });

  it("no key observed is not a clean finish", () => {
    // A run nothing reported on proves nothing; the caller has to say so.
    expect(worstTerminal([])).toBeUndefined();
  });
});
