/**
 * `npm test` runs every batch and fails at the END (OPS-1).
 *
 * The runner used to exit on the first failing batch, so CI never ran the
 * batches after it: one red file hid a quarter of the suite, and a new
 * regression behind it looked exactly like the known failure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAllBatches } from "../../../scripts/vitest-batch-policy.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
}

describe("vitest batch policy", () => {
  it("runs every batch after a failure and exits with the first failing code", async () => {
    const batches = [["a.test.ts"], ["b.test.ts", "c.test.ts"], ["d.test.ts"], ["e.test.ts"]];
    const codes = new Map([["b.test.ts", 1], ["d.test.ts", 2]]);
    const ran: string[][] = [];
    const { err, log } = recorder();

    const exitCode = await runAllBatches(batches, async (batch: string[]) => {
      ran.push(batch);
      return codes.get(batch[0]!) ?? 0;
    }, log);

    expect(ran).toEqual(batches);
    expect(exitCode).toBe(1);
    const summary = err.join("\n");
    expect(summary).toContain("2 of 4 batches FAILED");
    expect(summary).toContain("batch 2/4 (2 files) exited 1");
    expect(summary).toContain("batch 3/4 (1 files) exited 2");
    expect(summary).not.toContain("batch 1/4");
    expect(summary).not.toContain("batch 4/4");
  });

  it("exits 0 and says so when every batch passes", async () => {
    const { out, err, log } = recorder();
    expect(await runAllBatches([["a.test.ts"], ["b.test.ts"]], async () => 0, log)).toBe(0);
    expect(out.at(-1)).toContain("all 2 batches passed");
    expect(err).toEqual([]);
  });

  it("a batch killed by a signal is a failure, and the batches after it still run", async () => {
    const ran: string[] = [];
    const { err, log } = recorder();
    const exitCode = await runAllBatches([["a.test.ts"], ["b.test.ts"]], async (batch: string[]) => {
      ran.push(batch[0]!);
      if (batch[0] === "a.test.ts") throw new Error("vitest exited via signal SIGKILL");
      return 0;
    }, log);
    expect(ran).toEqual(["a.test.ts", "b.test.ts"]);
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("batch 1/2 (1 files) exited 1 (vitest exited via signal SIGKILL)");
  });

  it("the runner delegates to the policy and keeps forwarded arguments as a single run", () => {
    const runner = readFileSync(path.join(repoRoot, "scripts", "run-vitest-batches.mjs"), "utf8");
    expect(runner).toContain('import { runAllBatches } from "./vitest-batch-policy.mjs"');
    expect(runner).toMatch(/process\.exit\(await runAllBatches\(batches,/);
    // No early exit left inside the batch loop.
    expect(runner).not.toMatch(/for \(const \[index, batch\] of batches\.entries\(\)\)/);
    // `npm test -- <files>` is still one vitest run with the caller's arguments.
    expect(runner).toContain("runVitest([...BASE_ARGS, ...forwardedArgs])");
  });
});
