import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { TaskExecutionStore } from "./task-execution-store.js";

describe("TaskExecutionStore", () => {
  let db: Database.Database;
  let store: TaskExecutionStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new TaskExecutionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores session summaries separately from execution recovery state", () => {
    store.updateSessionSummary(
      "user-1",
      "Investigated the Unity level import failure.",
      ["Compare asset YAML against runtime state"],
      ["unity", "levels"],
    );

    const memory = store.getMemory("user-1");
    expect(memory?.sessionSummary).toContain("Unity level import failure");
    expect(memory?.openItems).toEqual(["Compare asset YAML against runtime state"]);
    expect(memory?.topics).toEqual(["unity", "levels"]);
    expect(memory?.branchSummary).toBeUndefined();
  });

  it("merges execution snapshots without overwriting session summaries", () => {
    store.updateSessionSummary(
      "user-2",
      "Recent session summary",
      ["Replay the failing editor path"],
      ["unity"],
    );
    store.updateExecutionSnapshot("user-2", {
      branchSummary: "Branch branch-2 | stable checkpoint: inspected Level_031",
      verifierSummary: "Verifier requires reproducing the live Unity failure path.",
      learnedInsights: ["Avoid assuming serialized YAML is enough without runtime confirmation."],
    });

    const memory = store.getMemory("user-2");
    expect(memory?.sessionSummary).toBe("Recent session summary");
    expect(memory?.branchSummary).toContain("branch-2");
    expect(memory?.verifierSummary).toContain("live Unity failure path");
    expect(memory?.learnedInsights).toEqual([
      "Avoid assuming serialized YAML is enough without runtime confirmation.",
    ]);
  });
});
