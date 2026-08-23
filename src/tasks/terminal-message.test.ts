/**
 * The question a blocked run asked, reaching the person who could answer it.
 *
 * Measured 2026-08-23 on run 53: the agent stopped to ask something, the control
 * plane wrote the tag `blocked:ask_user`, and `reason ?? (output || ...)` made
 * that sixteen-character tag the entire stored result. The 119-character
 * question was discarded. An unattended run that will not say what it asked
 * cannot be answered and cannot be resumed — it simply stops, looking like a
 * decision rather than a dead end.
 */

import { describe, expect, it } from "vitest";
import { terminalMessage } from "./terminal-message.js";

const QUESTION =
  "UNITY_PROJECT_PATH points at PixelFlow-Clean but the open editor is Lodestone. Which should I build?";

describe("a tag that stands in for an explanation", () => {
  it("gives way to what the worker actually said", () => {
    expect(terminalMessage("blocked:ask_user", QUESTION, "Task blocked")).toBe(QUESTION);
  });

  it("recognises tags of any depth", () => {
    for (const tag of ["blocked", "blocked:ask_user", "failed:provider:timeout"]) {
      expect(terminalMessage(tag, QUESTION, "Task blocked")).toBe(QUESTION);
    }
  });

  it("is still used when there is nothing else — a tag beats silence", () => {
    expect(terminalMessage("blocked:ask_user", "", "Task blocked")).toBe("blocked:ask_user");
  });
});

describe("a reason that is a real explanation", () => {
  it("keeps precedence, because it is the one that explains the ending", () => {
    const reason = 'All providers failed. Last error: Provider "OpenCode" sent no response within 300000ms';

    expect(terminalMessage(reason, "half-written draft", "Task failed")).toBe(reason);
  });

  it("is not mistaken for a tag because it contains a colon", () => {
    const reason = "Compilation failed: 3 errors in BoardService.cs";

    expect(terminalMessage(reason, "draft", "Task failed")).toBe(reason);
  });
});

describe("when there is little to go on", () => {
  it("falls back to the worker output when no reason was given", () => {
    expect(terminalMessage(undefined, QUESTION, "Task blocked")).toBe(QUESTION);
    expect(terminalMessage(null, QUESTION, "Task blocked")).toBe(QUESTION);
  });

  it("uses the fallback only when both are empty", () => {
    expect(terminalMessage("", "", "Task blocked")).toBe("Task blocked");
    expect(terminalMessage("   ", undefined, "Task failed")).toBe("Task failed");
  });

  it("does not report whitespace as an answer", () => {
    expect(terminalMessage("blocked:ask_user", "   \n  ", "Task blocked")).toBe("blocked:ask_user");
  });
});
