import { describe, expect, it } from "vitest";

import { describeThrown } from "./fetch-with-retry.js";

/**
 * What was thrown, in words.
 *
 * Measured 2026-08-22, run 47: OpenCode became unreachable and the retry log
 * recorded the reason nine times as `error: "[object Object]"`. Only the first
 * attempt said anything useful — "fetch failed" — and even that is the wrapper,
 * not the cause: fetch puts the real reason (ECONNREFUSED, ENOTFOUND, a socket
 * timeout) in err.cause. Three hours of retries produced no diagnosable line,
 * and the run died without ever naming what had gone wrong.
 */

describe("describing what was thrown", () => {
  it("unwraps the cause fetch hides the real reason in", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
    });

    const described = describeThrown(err);

    expect(described).toContain("fetch failed");
    expect(described).toContain("ECONNREFUSED");
  });

  it("never renders an object as [object Object]", () => {
    // This is the line that appeared nine times.
    expect(describeThrown({ errno: -61, code: "ECONNREFUSED", syscall: "connect" })).not.toContain(
      "[object Object]",
    );
    expect(describeThrown({ errno: -61, code: "ECONNREFUSED", syscall: "connect" })).toContain(
      "ECONNREFUSED",
    );
  });

  it("keeps a plain Error's message", () => {
    expect(describeThrown(new Error("socket hang up"))).toContain("socket hang up");
  });

  it("says something for the shapes with nothing to say", () => {
    for (const odd of [undefined, null, "", {}, 42]) {
      expect(describeThrown(odd).length, `nothing said for ${String(odd)}`).toBeGreaterThan(0);
    }
  });

  it("does not let a huge object flood the log", () => {
    const huge = { blob: "x".repeat(10_000) };

    expect(describeThrown(huge).length).toBeLessThan(400);
  });
});
