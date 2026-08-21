import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The preview is written inside a debug log call deep in the tool loop; this
// pins the rule that gives a failure more room than a success, which is the
// whole point and is otherwise invisible until someone reads a log at 3am.
const SOURCE = readFileSync("src/agents/orchestrator.ts", "utf8");

describe("what a tool result leaves in the log", () => {
  it("gives a failed result a longer preview than a successful one", () => {
    const success = /const TOOL_RESULT_LOG_PREVIEW = (\d+);/.exec(SOURCE)?.[1];
    const failure = /const TOOL_FAILURE_LOG_PREVIEW = (\d+);/.exec(SOURCE)?.[1];

    expect(success, "the success preview length is gone").toBeDefined();
    expect(failure, "failures no longer have their own preview length").toBeDefined();
    expect(Number(failure)).toBeGreaterThan(Number(success));
  });

  it("actually picks between them on isError", () => {
    const line = SOURCE.split("\n").find((l) => l.includes("result.isError ? TOOL_FAILURE_LOG_PREVIEW"));

    expect(line, "the preview no longer varies with the result").toBeDefined();
    expect(line).toContain("TOOL_RESULT_LOG_PREVIEW");
  });
});
