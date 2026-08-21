/**
 * A run that ends "4 of 5 failed" has to say which four, and why.
 *
 * Measured 2026-08-21, run 37: the supervisor logged that it had started, then
 * sixty-five minutes later that five nodes had run and four had failed. Between
 * those two lines it said nothing about a single node — not which one, not on
 * which provider, not with what error. The whole log held no error-level entry
 * at all. The decision that ended the run was unexaminable, and the data was
 * sitting in nodeResults the whole time.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { summariseNodeOutcomes } from "./node-outcome-summary.js";

const node = (over: Record<string, unknown>) =>
  ({
    nodeId: "n1",
    status: "ok",
    output: "",
    artifacts: [],
    toolResults: [],
    provider: "opencode",
    model: "ox-alpha-free",
    cost: 0,
    ...over,
  }) as never;

describe("saying which node failed and why", () => {
  it("names every node that did not succeed", () => {
    const lines = summariseNodeOutcomes([
      node({ nodeId: "n1", status: "ok" }),
      node({ nodeId: "n2", status: "failed", output: "CS0246: type not found" }),
      node({ nodeId: "n3", status: "skipped" }),
    ]);

    expect(lines.join(" ")).toContain("n2");
    expect(lines.join(" ")).toContain("n3");
  });

  it("carries the reason, not just the verdict", () => {
    const lines = summariseNodeOutcomes([
      node({ nodeId: "n2", status: "failed", blockedReason: "needs a decision about scoring" }),
    ]);

    expect(lines[0], "the verdict without the reason is what run 37 already had").toContain(
      "needs a decision about scoring",
    );
  });

  it("falls back to the node's own output when there is no blocked reason", () => {
    const lines = summariseNodeOutcomes([
      node({ nodeId: "n2", status: "failed", output: "line one\nthe error is here" }),
    ]);

    expect(lines[0]).toContain("the error is here");
  });

  it("says which provider produced the failure", () => {
    // A node that failed on a dying provider and one that failed on its own
    // work need different responses.
    const lines = summariseNodeOutcomes([
      node({ nodeId: "n2", status: "failed", provider: "kimi", output: "403" }),
    ]);

    expect(lines[0]).toContain("kimi");
  });

  it("stays quiet when every node succeeded", () => {
    expect(summariseNodeOutcomes([node({ status: "ok" }), node({ status: "ok" })])).toEqual([]);
  });

  it("does not let one enormous output flood the log", () => {
    const lines = summariseNodeOutcomes([
      node({ nodeId: "n2", status: "failed", output: "x".repeat(5000) }),
    ]);

    expect(lines[0]!.length).toBeLessThan(400);
  });

  it("is what the settling log actually reports", () => {
    // The function proved above is worth nothing if the call site does not use
    // it — this is the wiring that went missing seven times today.
    const source = readFileSync("src/tasks/background-executor.ts", "utf8");
    const settle = source.slice(source.indexOf('route: "supervisor"'));
    const call = settle.slice(0, settle.indexOf("});"));

    expect(call, "the settling log still reports a tally with no detail").toContain(
      "summariseNodeOutcomes",
    );
  });
});
