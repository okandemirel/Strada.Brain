import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A run that stops because it ran out of retries has to say so.
 *
 * Measured 2026-08-22, run 47: OpenCode went unreachable at 20:23. The network
 * budget was spent one attempt at a time — 535ms, 1s, 2s, 4s … 60s — and the
 * tenth and last was logged at 22:09:48. After that: nothing. No line saying
 * the budget was gone, no task failure, no episode end. The process stayed
 * alive and silent for four hours, and the only way to learn what had happened
 * was to count the retry lines by hand.
 *
 * The throw itself was always there. It just left without a word.
 */

const source = readFileSync("src/common/fetch-with-retry.ts", "utf8");

describe("running out of network retries", () => {
  it("logs before it gives up", () => {
    const at = source.indexOf("networkAttempt >= networkMaxRetries");
    const branch = source.slice(at, source.indexOf("}", source.indexOf("throw", at)));

    expect(at, "the exhaustion branch moved; this measures nothing").toBeGreaterThan(-1);
    expect(branch, "the budget runs out in silence").toMatch(/logger\.(error|warn)/u);
  });

  it("says how many attempts were spent, and on what", () => {
    const at = source.indexOf("networkAttempt >= networkMaxRetries");
    const branch = source.slice(at, source.indexOf("}", source.indexOf("throw", at)));

    // The logger call itself, not merely the branch: the branch also throws
    // with describeThrown, so a check that scanned the whole branch passed
    // while the log line had been reduced back to String(err).
    const logCall = branch.slice(branch.indexOf("logger."), branch.indexOf("});", branch.indexOf("logger.")));

    expect(logCall).toContain("describeThrown");
    expect(logCall).toMatch(/attempts|networkMaxRetries/u);
  });

  it("still throws, so the caller's own handling is unchanged", () => {
    const at = source.indexOf("networkAttempt >= networkMaxRetries");
    const branch = source.slice(at, source.indexOf("}", source.indexOf("throw", at)) + 1);

    expect(branch).toContain("throw");
  });
});
