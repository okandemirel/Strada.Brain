/**
 * One acceptance measurement: a record is admitted only when it is this
 * run's, ran exactly the tests asked for,
 * skipped none, and adds up; failures past the 50-name cap are run again in
 * chunks until every one is named; a failure that passes on its one re-run is
 * flaky; a tree that moved measured nothing. Invented names only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptanceCompileErrorsIn,
  acceptanceDisagreesWithReceipt,
  failureMessagesIn,
  measureAcceptance,
  type AcceptanceBatch,
  type AcceptanceGateDeps,
} from "./acceptance-gate.js";
import type { PlaymodeRunEvidence } from "./playmode-run.js";
import type { AcceptanceSource } from "./scope-types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FILE = "Assets/StradaAcceptance/Acceptance_M1.cs";
const nameOf = (i: number): string => `Strada.Acceptance.M1.Acceptance_M1.R${String(i).padStart(3, "0")}_abcdef`;
const expectedOf = (n: number) => Array.from({ length: n }, (_, i) => ({ testName: nameOf(i + 1), path: FILE }));
const SOURCES: AcceptanceSource[] = [];

function record(names: string[], failed: string[], extra: Partial<PlaymodeRunEvidence> = {}): PlaymodeRunEvidence {
  return {
    found: true,
    total: names.length,
    passed: names.length - failed.length,
    failed: failed.length,
    skipped: 0,
    failedNames: failed.slice(0, 50),
    filter: names.join(";"),
    runId: "run-1",
    ...extra,
  };
}

function deps(run: (filter: string) => AcceptanceBatch | Promise<AcceptanceBatch>, extra: Partial<AcceptanceGateDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strada-acceptance-gate-"));
  dirs.push(dir);
  const removeEphemeral = vi.fn();
  const restore = vi.fn(() => ({ tamper: [] as string[], written: [], deleted: [] }));
  const runBatch = vi.fn(async (filter: string) => run(filter));
  const d: AcceptanceGateDeps = {
    projectRoot: dir,
    runBatch,
    revision: () => "rev-1",
    restore,
    removeEphemeral,
    ...extra,
  };
  return { d, runBatch, restore, removeEphemeral };
}

const measure = (d: AcceptanceGateDeps, n: number, mode: "committed" | "ephemeral" = "committed") =>
  measureAcceptance(d, { sources: SOURCES, expected: expectedOf(n), mode, compiledBefore: new Set() });

describe("admission", () => {
  it("admits this run's record of exactly the tests asked for: every test passes", async () => {
    const { d } = deps((filter) => ({ runId: "run-1", record: record(filter.split(";"), []) }));
    const m = await measure(d, 3);
    expect(m.run.admitted).toBe(true);
    expect(m.run.revision).toBe("rev-1");
    expect(Object.values(m.tests).map((t) => t.outcome)).toEqual(["pass", "pass", "pass"]);
  });

  it.each([
    ["a different filter", (names: string[]) => record(names, [], { filter: names.slice(1).join(";") }), "foreign-record"],
    ["another run's id", (names: string[]) => record(names, [], { runId: "run-0" }), "foreign-record"],
    ["a skipped test", (names: string[]) => record(names, [], { skipped: 1, passed: names.length - 1 }), "skipped"],
    ["one test short", (names: string[]) => record(names, [], { total: names.length - 1, passed: names.length - 1 }), "count-mismatch"],
    ["counts that do not add up", (names: string[]) => record(names, [], { passed: names.length - 1 }), "count-mismatch"],
  ])("refuses %s, and reads no pass from it", async (_what, make, kind) => {
    const { d } = deps((filter) => ({ runId: "run-1", record: make(filter.split(";")) }));
    const m = await measure(d, 3);
    expect(m.run.admitted).toBe(false);
    expect(m.run.refusal?.kind).toBe(kind);
    expect(Object.values(m.tests).some((t) => t.outcome === "pass")).toBe(false);
  });

  it("refuses a run the campaign did not bind to its ticket, and a record that is not there", async () => {
    const refused = deps(() => ({ runId: "run-1", record: record([nameOf(1)], []), refused: { kind: "foreign-record", detail: "the receipt was refused" } }));
    expect((await measure(refused.d, 1)).run.refusal?.kind).toBe("foreign-record");
    const missing = deps(() => ({ runId: "run-1", record: { found: false } }));
    expect((await measure(missing.d, 1)).run.refusal?.kind).toBe("no-record");
  });

  it("no runner, no assembly, a tree no revision binds: never a pass, and nothing is run", async () => {
    const none = deps(() => ({ record: { found: false } }));
    const { runBatch: _r, ...noRunner } = none.d;
    expect((await measure(noRunner as AcceptanceGateDeps, 1)).run.refusal?.kind).toBe("no-runner");
    const noAssembly = deps(() => ({ record: { found: false } }), { assemblyRefusal: () => ({ kind: "no-assembly", detail: "no runtime assembly" }) });
    expect((await measure(noAssembly.d, 1)).run.refusal?.kind).toBe("no-assembly");
    expect(noAssembly.runBatch).not.toHaveBeenCalled();
    const dirty = deps(() => ({ record: { found: false } }), { revision: () => "" });
    const m = await measure(dirty.d, 1);
    expect(m.run.refusal?.kind).toBe("tree-moved");
    expect(dirty.runBatch).not.toHaveBeenCalled();
  });

  it("a revision that moved while the run ran measured nothing", async () => {
    let calls = 0;
    const { d } = deps((filter) => ({ runId: "run-1", record: record(filter.split(";"), []) }), { revision: () => (calls++ === 0 ? "rev-1" : "rev-2") });
    const m = await measure(d, 2);
    expect(m.run.admitted).toBe(false);
    expect(m.run.refusal?.kind).toBe("tree-moved");
    expect(Object.values(m.tests).every((t) => t.outcome === "unmeasured")).toBe(true);
  });
});

describe("attribution", () => {
  it("attributes 60 failures past the 50-name cap by running the rest in chunks", async () => {
    const all = expectedOf(70).map((t) => t.testName);
    const failing = new Set(all.slice(0, 60));
    const { d, runBatch } = deps((filter) => {
      const names = filter.split(";");
      return { runId: "run-1", record: record(names, names.filter((n) => failing.has(n))) };
    });
    const m = await measure(d, 70);
    expect(m.run.admitted).toBe(true);
    expect(m.run.unattributed).toBe(0);
    expect(m.run.failedNames).toHaveLength(60);
    expect(Object.values(m.tests).filter((t) => t.outcome === "fail")).toHaveLength(60);
    expect(Object.values(m.tests).filter((t) => t.outcome === "pass")).toHaveLength(10);
    // the first run, one chunk of the twenty it did not name, and the re-run of the sixty
    expect(runBatch).toHaveBeenCalledTimes(3);
  });

  it("a failure past the cap that no chunk names is never read as a pass", async () => {
    const all = expectedOf(70).map((t) => t.testName);
    const { d } = deps((filter) => {
      const names = filter.split(";");
      // the chunk run fails without naming anything
      return names.length === 70
        ? { runId: "run-1", record: record(names, all.slice(0, 55)) }
        : { runId: "run-1", record: { ...record(names, []), failed: 1, passed: names.length - 1 } };
    });
    const m = await measure(d, 70);
    expect(m.run.unattributed).toBeGreaterThan(0);
    expect(Object.values(m.tests).some((t) => t.outcome === "pass")).toBe(false);
  });

  it("a failure that passes on its one re-run is flaky, not a fail and not a pass", async () => {
    let first = true;
    const { d } = deps((filter) => {
      const names = filter.split(";");
      const failed = first ? [nameOf(2)] : [];
      first = false;
      return { runId: "run-1", record: record(names, failed) };
    });
    const m = await measure(d, 3);
    expect(m.run.flaky).toEqual([nameOf(2)]);
    expect(m.tests[nameOf(2)]!.outcome).toBe("flaky");
    expect(m.tests[nameOf(1)]!.outcome).toBe("pass");
  });

  it("an acceptance file that does not compile: never compiled is a check fault, compiled before is a fail", async () => {
    const content = `${FILE}(14,9): error CS0103: The name 'Dock' does not exist in the current context`;
    const { d } = deps((filter) => ({ runId: "run-1", content, record: { ...record(filter.split(";"), []), total: 0, passed: 0 } }));
    const m = await measureAcceptance(d, { sources: SOURCES, expected: expectedOf(2), mode: "committed", compiledBefore: new Set([nameOf(1)]) });
    expect(m.run.admitted).toBe(false);
    expect(m.run.acceptanceCompileErrors).toHaveLength(1);
    expect(m.tests[nameOf(1)]).toMatchObject({ outcome: "fail", compiledBefore: true });
    expect(m.tests[nameOf(2)]).toMatchObject({ outcome: "check-fault", compiledBefore: false });
  });
});

describe("the folder around the run", () => {
  it("restores before the run (tamper travels with the result) and takes ephemeral checks back out", async () => {
    const { d, restore, removeEphemeral } = deps((filter) => ({ runId: "run-1", record: record(filter.split(";"), []) }));
    restore.mockReturnValue({ tamper: [FILE], written: [], deleted: [] });
    const m = await measure(d, 1, "ephemeral");
    expect(restore).toHaveBeenCalledWith(SOURCES, "ephemeral");
    expect(m.run.tamper).toEqual([FILE]);
    expect(removeEphemeral).toHaveBeenCalledTimes(1);
  });

  it("committed checks stay; a runner that throws is a refusal, and ephemeral checks are still removed", async () => {
    const committed = deps((filter) => ({ runId: "run-1", record: record(filter.split(";"), []) }));
    await measure(committed.d, 1, "committed");
    expect(committed.removeEphemeral).not.toHaveBeenCalled();
    const throwing = deps(() => {
      throw new Error("the editor is busy");
    });
    const m = await measure(throwing.d, 1, "ephemeral");
    expect(m.run.refusal?.kind).toBe("runner-error");
    expect(throwing.removeEphemeral).toHaveBeenCalledTimes(1);
  });

  it("a lock nobody could take runs nothing", async () => {
    const { d, runBatch } = deps(() => ({ record: { found: false } }), { lock: async () => ({ acquired: false, release: () => {} }) });
    expect((await measure(d, 1)).run.refusal?.kind).toBe("lock");
    expect(runBatch).not.toHaveBeenCalled();
  });
});

describe("reading the tool's output", () => {
  it("failure messages under 'Failed:' and compile errors naming the acceptance folder", () => {
    const content = [
      "PlayMode verification FAILED: 2 of 3 tests failed (filter: …).",
      "total=3 passed=1 failed=2",
      "",
      "Failed:",
      `  ${nameOf(1)}`,
      "      Expected: lit But was: dark",
      `  ${nameOf(2)}`,
      "      [strada-acceptance:no-service] IDock is not registered",
      "      --- output ---",
      "      boot ok",
      "",
      "Exceptions logged during play:",
      "  NullReferenceException",
    ].join("\n");
    expect(failureMessagesIn(content)).toEqual([
      { name: nameOf(1), message: "Expected: lit But was: dark" },
      { name: nameOf(2), message: "[strada-acceptance:no-service] IDock is not registered boot ok" },
    ]);
    const errors = acceptanceCompileErrorsIn(
      [
        "/abs/project/Assets/StradaAcceptance/Acceptance_M1.cs(14,9): error CS0103: The name 'Dock' does not exist",
        "Assets/Game/Ferry.cs(3,1): error CS1002: ; expected",
      ].join("\n"),
    );
    expect(errors).toEqual([{ path: FILE, line: 14, code: "CS0103", message: "The name 'Dock' does not exist" }]);
  });

  it("an admitted receipt binds the record only when it states the counts and the very filter asked for", () => {
    const rec = record([nameOf(1), nameOf(2)], [nameOf(2)]);
    const filter = `${nameOf(1)};${nameOf(2)}`;
    expect(acceptanceDisagreesWithReceipt({ total: 2, passed: 1, failed: 1, filter }, rec, filter)).toBeUndefined();
    expect(acceptanceDisagreesWithReceipt({ total: 2, passed: 2, failed: 0, filter }, rec, filter)).toMatch(/not the run its receipt describes/);
    expect(acceptanceDisagreesWithReceipt({ total: 2, passed: 1, failed: 1, filter: nameOf(1) }, rec, filter)).toMatch(/another test filter/);
    expect(acceptanceDisagreesWithReceipt({ filter }, rec, filter)).toMatch(/states no counts/);
  });
});
