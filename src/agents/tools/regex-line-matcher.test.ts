import { afterEach, describe, expect, it } from "vitest";

import { RegexTimeoutError, WorkerLineMatcher } from "./regex-line-matcher.js";

describe("WorkerLineMatcher", () => {
  const open: WorkerLineMatcher[] = [];
  const matcher = (source: string, flags: string, timeoutMs = 2_000): WorkerLineMatcher => {
    const m = new WorkerLineMatcher(source, flags, timeoutMs);
    open.push(m);
    return m;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((m) => m.close()));
  });

  it("tests every line from its start, in order, up to the limit", async () => {
    const m = matcher("a\\w", "g");
    expect(await m.match("ab\nxx\nac ad\nae", 10)).toEqual({
      hits: [[0, "ab"], [2, "ac ad"], [3, "ae"]],
      lineCount: 4,
    });
    expect(await m.match("ab\nac\nad", 2)).toEqual({ hits: [[0, "ab"], [1, "ac"]], lineCount: 3 });
  });

  it("rejects an overrunning match with RegexTimeoutError, and a later match gets a fresh worker", async () => {
    const m = matcher("(x+x+)+y", "g", 200);
    await expect(m.match("x".repeat(40), 20)).rejects.toBeInstanceOf(RegexTimeoutError);
    expect(await m.match("xxy", 20)).toEqual({ hits: [[0, "xxy"]], lineCount: 1 });
  });
});
