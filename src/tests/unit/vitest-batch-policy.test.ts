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
import { failuresFromJsonReport, formatFailures, runAllBatches, MAX_LISTED_FAILURES } from "../../../scripts/vitest-batch-policy.mjs";

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

  it("lists every failing test of every batch at the end, grouped by file", async () => {
    const { err, log } = recorder();
    const exitCode = await runAllBatches([["a.test.ts"], ["b.test.ts"], ["c.test.ts"]], async (batch: string[]) => {
      if (batch[0] === "a.test.ts") {
        return { exitCode: 1, failures: [{ file: "src/a.test.ts", test: "a > works", message: "AssertionError: expected 1 to be 2\n    at a.test.ts:3" }] };
      }
      if (batch[0] === "c.test.ts") {
        return { exitCode: 1, failures: [{ file: "src/c.test.ts", message: "\nError: Cannot find module 'x'" }] };
      }
      return 0;
    }, log);
    expect(exitCode).toBe(1);
    const summary = err.join("\n");
    expect(summary).toContain("2 failing test(s) in 2 file(s)");
    expect(summary).toContain("  src/a.test.ts\n    - a > works: AssertionError: expected 1 to be 2");
    expect(summary).not.toContain("at a.test.ts:3");
    expect(summary).toContain("  src/c.test.ts\n    - (file failed to run): Error: Cannot find module 'x'");
    expect(summary).not.toContain("marked FAIL in its batch's output above");
  });

  it("caps the list and says how many it left out", () => {
    const many = Array.from({ length: MAX_LISTED_FAILURES + 5 }, (_, i) => ({ file: "src/x.test.ts", test: `t${i}`, message: "m" }));
    const lines = formatFailures(many);
    expect(lines.filter((l: string) => l.startsWith("    - "))).toHaveLength(MAX_LISTED_FAILURES);
    expect(lines.at(-1)).toContain("and 5 more");
  });

  it("reads failures from a vitest JSON report with platform-neutral paths", () => {
    const report = {
      testResults: [
        { name: "D:\\repo\\src\\a.test.ts", status: "failed", message: "", assertionResults: [
          { fullName: "a > ok", status: "passed", failureMessages: [] },
          { fullName: "a > bad", status: "failed", failureMessages: ["Error: bad\n at x"] },
        ] },
        { name: "D:\\repo\\src\\b.test.ts", status: "failed", message: "SyntaxError: nope", assertionResults: [] },
        { name: "D:\\repo\\src\\c.test.ts", status: "passed", message: "", assertionResults: [] },
      ],
    };
    const failures = failuresFromJsonReport(report, (file: string) => file.replace("D:\\repo\\", ""));
    expect(failures).toEqual([
      { file: "src/a.test.ts", test: "a > bad", message: "Error: bad\n at x" },
      { file: "src/b.test.ts", message: "SyntaxError: nope" },
    ]);
    expect(failuresFromJsonReport(null, (f: string) => f)).toEqual([]);
  });

  it("the runner delegates to the policy and keeps forwarded arguments as a single run", () => {
    const runner = readFileSync(path.join(repoRoot, "scripts", "run-vitest-batches.mjs"), "utf8");
    expect(runner).toMatch(/import \{[^}]*\brunAllBatches\b[^}]*\} from "\.\/vitest-batch-policy\.mjs"/);
    expect(runner).toMatch(/await runAllBatches\(batches,/);
    expect(runner).toMatch(/process\.exit\(exitCode\)/);
    // No early exit left inside the batch loop.
    expect(runner).not.toMatch(/for \(const \[index, batch\] of batches\.entries\(\)\)/);
    // `npm test -- <files>` is still one vitest run with the caller's arguments.
    expect(runner).toContain("runVitest([...BASE_ARGS, ...forwardedArgs])");
  });
});
