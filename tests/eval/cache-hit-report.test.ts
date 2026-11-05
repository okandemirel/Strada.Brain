/**
 * The prefix-cache hit-rate report: scripts/eval/cache-hit-report.mjs.
 *
 * The rate per call type is what a compaction decision has to rest on
 * (docs/memory/entries/2026-11-04-compaction-must-respect-the-prefix-cache.md),
 * so it must say what it measured: a group where no call reported the cached
 * share is "not measured", never 0%. The log lines here are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EXIT, cacheHitReport, formatReport, main, readProviderCalls } from "../../scripts/eval/cache-hit-report.mjs";

let dir = "";
let log = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cache-hit-report-"));
  log = join(dir, "strada-brain.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ level: "info", service: "strada-brain", message: "Provider call", ...fields });

describe("cache-hit-report", () => {
  it("rates each label and provider on its own, counts a missing cache field as 0 cached, and reads the rotated archive", () => {
    writeFileSync(
      join(dir, "strada-brain1.log.gz"),
      gzipSync(`${line({ timestamp: "2026-11-05 09:00:00", label: "turn", provider: "opencode", inputTokens: 1000, cachedInputTokens: 900 })}\n`),
    );
    writeFileSync(
      log,
      [
        line({ timestamp: "2026-11-05 10:00:00", label: "turn", provider: "opencode", inputTokens: 2000, cachedInputTokens: 1500 }),
        // The OpenAI-compatible parsers drop the field when nothing was cached.
        line({ timestamp: "2026-11-05 10:01:00", label: "turn", provider: "opencode", inputTokens: 1000 }),
        line({ timestamp: "2026-11-05 10:02:00", label: "streaming", provider: "opencode", inputTokens: 4000 }),
        line({ timestamp: "2026-11-05 10:03:00", label: "turn", provider: "claude", inputTokens: 500, cachedInputTokens: 0 }),
        line({ timestamp: "2026-11-05 10:04:00", label: "turn", provider: "opencode" }),
        JSON.stringify({ timestamp: "2026-11-05 10:05:00", message: "Provider call failed", label: "turn", provider: "opencode" }),
        "2026-11-05 10:06:00 [info] not a json line",
        "",
      ].join("\n"),
    );

    const { files, calls } = readProviderCalls(log);
    const groups = cacheHitReport(calls);

    expect(files.map((f: { cause: string | null }) => f.cause)).toEqual([null, null]);
    expect(groups).toEqual([
      { label: "streaming", provider: "opencode", calls: 1, withUsage: 1, withCacheField: 0, inputTokens: 4000, cachedInputTokens: 0, hitRate: null },
      { label: "turn", provider: "opencode", calls: 4, withUsage: 3, withCacheField: 2, inputTokens: 4000, cachedInputTokens: 2400, hitRate: 0.6 },
      { label: "turn", provider: "claude", calls: 1, withUsage: 1, withCacheField: 1, inputTokens: 500, cachedInputTokens: 0, hitRate: 0 },
    ]);

    const text = formatReport({ log, since: null, files, groups });
    expect(text).toMatch(/turn\s+opencode\s+4\s+3\s+2\s+4,000\s+2,400\s+60\.0%/);
    expect(text).toMatch(/turn\s+claude\s+.*\s0\.0%/);
    expect(text).toMatch(/streaming\s+opencode\s+.*not measured/);
    expect(text).toContain("do not add rows across labels");
  });

  it("--since keeps only the calls logged at or after it", () => {
    writeFileSync(
      log,
      [
        line({ timestamp: "2026-11-05 09:59:59", label: "turn", provider: "opencode", inputTokens: 1000, cachedInputTokens: 0 }),
        line({ timestamp: "2026-11-05 10:00:00", label: "turn", provider: "opencode", inputTokens: 1000, cachedInputTokens: 800 }),
      ].join("\n"),
    );
    const since = new Date(2026, 10, 5, 10, 0, 0).getTime();

    expect(cacheHitReport(readProviderCalls(log, since).calls)[0]).toMatchObject({ calls: 1, hitRate: 0.8 });
    expect(cacheHitReport(readProviderCalls(log).calls)[0]).toMatchObject({ calls: 2, hitRate: 0.4 });
  });

  it("names a log with no provider call, and refuses a bad invocation or a missing log", () => {
    writeFileSync(log, `${JSON.stringify({ message: "Bootstrapping Strada Brain" })}\n`);
    const { files, calls } = readProviderCalls(log);
    expect(formatReport({ log, since: null, files, groups: cacheHitReport(calls) })).toContain('no "Provider call" line');

    expect(main(["--log", join(dir, "absent.log")])).toBe(EXIT.USAGE);
    expect(main(["--since", "not a time", "--log", log])).toBe(EXIT.USAGE);
    expect(main(["--unknown"])).toBe(EXIT.USAGE);
    expect(main(["--log", log])).toBe(EXIT.PRINTED);
  });
});
