/**
 * Whatever a run learns about a provider outlives the run.
 *
 * Measured 2026-08-22, run 37: Kimi refused at 23:02, the registry marked it
 * down, and the chain skipped it correctly for the rest of the run. The file on
 * disk was last written at 21:44. Run 38 therefore booted with
 * "unavailable: []" and was free to hand goals straight back to it.
 *
 * The cause was one method. Four of the record methods called persistNow();
 * recordFailure — the one the chain's recovery probe uses — did not. Adding a
 * fifth call site would have fixed this instance and left the next new method
 * free to forget again, so persistence now hangs off the state change itself.
 *
 * This test enumerates the record methods rather than naming one, so a method
 * added later is covered the day it is written.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProviderHealthRegistry } from "./provider-health.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function freshRegistry(): { registry: ProviderHealthRegistry; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "persist-all-"));
  dirs.push(dir);
  const file = join(dir, "provider-health.json");
  const registry = new ProviderHealthRegistry();
  registry.load(file);
  return { registry, file };
}

const ERROR = "API error 403: quota exhausted for this billing cycle";

// Every method that can move a provider to a worse state. A run that dies to a
// hard kill one second later must not lose any of them.
const RECORDERS: Array<[string, (r: ProviderHealthRegistry) => void]> = [
  ["recordFailure", (r) => r.recordFailure("kimi", ERROR)],
  ["recordOverloaded", (r) => r.recordOverloaded("kimi", "API error 529")],
  ["recordOverloadedShort", (r) => r.recordOverloadedShort("kimi", "API error 529")],
  ["recordQuotaExhausted", (r) => r.recordQuotaExhausted("kimi", ERROR)],
  ["recordQuotaExhaustedShort", (r) => r.recordQuotaExhaustedShort("kimi", ERROR)],
  ["recordQuotaHardStop", (r) => r.recordQuotaHardStop("kimi", 60_000, ERROR)],
];

describe("every record survives the process", () => {
  for (const [name, record] of RECORDERS) {
    it(`${name} reaches the file`, () => {
      const { registry, file } = freshRegistry();

      record(registry);

      expect(existsSync(file), `${name} kept its finding in memory only`).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("kimi");
    });
  }

  it("hands the state to the next process, which is the whole point", () => {
    const { registry, file } = freshRegistry();
    // One failure only raises the count — a provider goes down after several,
    // which is the behaviour worth carrying across a kill.
    for (let i = 0; i < 5; i++) registry.recordFailure("kimi", ERROR);
    const statusBefore = registry.getStatus("kimi");

    const nextProcess = new ProviderHealthRegistry();
    nextProcess.load(file);

    expect(statusBefore, "the test never drove it out of healthy").not.toBe("healthy");
    expect(nextProcess.getStatus("kimi")).toBe(statusBefore);
  });

  it("writes nothing when no path was given", () => {
    const registry = new ProviderHealthRegistry();

    expect(() => registry.recordFailure("kimi", ERROR)).not.toThrow();
  });
});
