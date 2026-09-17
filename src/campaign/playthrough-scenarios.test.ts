import { describe, expect, it } from "vitest";
import * as contract from "./playthrough-verdict.js";

// Exercise the verdict module's public contract. Missing exports are assertion
// failures on the old reader, not a missing-module / zero-test load failure.
/**
 * Round 13 #32: the numbers in a verdict are the producer's claim; the frames
 * and the save artifact are the evidence. The default here is a run that DID
 * leave both, so these cases still test what they were written to test.
 */
const ONDISK = { framesOnDisk: 4, artifactExists: () => true };

function parse(rows: unknown, count: unknown = 4, disk = ONDISK) {
  expect(contract).toHaveProperty("parsePlaythroughScenarios");
  return contract.parsePlaythroughScenarios(rows, count, disk);
}

const reached = [
  { id: "menu-to-game", fromState: "Menu", toState: "Playing" },
  { id: "win", outcome: "Won", reachedOutcome: true },
  { id: "lose", outcome: "Lost", reachedOutcome: true },
  { id: "save-load", saveCompleted: true, loadCompleted: true, artifact: "Recordings/playthrough/save-slot-1.json", saveId: "slot-1", loadedSaveId: "slot-1", savedStateHash: "state-a", loadedStateHash: "state-a" },
  { id: "scene-transition", transitionCompleted: true, fromScene: "Home", toScene: "Level" },
].map((row) => ({ ...row, startAccepted: true, reached: true, actions: 2, frames: { before: 0, after: 1 } }));

describe("scenario evidence contract", () => {
  it("REACHED requires each specific observation and ordered captured frames", () => {
    expect(parse(reached).map((row) => [row.id, row.status])).toEqual([
      ["menu-to-game", "reached"], ["win", "reached"], ["lose", "reached"],
      ["save-load", "reached"], ["scene-transition", "reached"],
    ]);
    const contradictions = [
      { ...reached[0], fromState: "Playing" },
      { ...reached[1], outcome: "Lost" },
      { ...reached[2], reachedOutcome: false },
      { ...reached[3], loadedStateHash: "different" },
      { ...reached[4], toScene: "Home" },
    ];
    expect(parse(contradictions).every((row) => row.status === "not-reached")).toBe(true);
    for (const count of [undefined, 0, 1]) {
      expect(contract.parsePlaythroughScenarios(reached, count, ONDISK).every((row) => row.status === "not-reached")).toBe(true);
    }
    for (const patch of [
      { reached: false }, { startAccepted: undefined }, { actions: 0 },
      { frames: undefined }, { frames: { before: 0, after: 0 } },
      { frames: { before: 2, after: 1 } }, { frames: { before: 0, after: 4 } },
    ]) {
      expect(parse(reached.map((row) => ({ ...row, ...patch }))).every((row) => row.status === "not-reached")).toBe(true);
    }
    for (const field of ["saveCompleted", "loadCompleted", "saveId", "loadedSaveId", "savedStateHash", "loadedStateHash"]) {
      expect(parse([{ ...reached[3], [field]: undefined }])[3]?.status).toBe("not-reached");
    }
    expect(parse([{ ...reached[3], loadedSaveId: "slot-2" }])[3]?.status).toBe("not-reached");
    expect(parse([{ ...reached[4], transitionCompleted: false }])[4]?.status).toBe("not-reached");
  });

  it("REFUSED overrides a reached claim for every refusal signal", () => {
    for (const patch of [{ startAccepted: false }, { outcome: "Refused" }, { missing: "driver cannot load" }]) {
      expect(parse(reached.map((row) => ({ ...row, ...patch }))).every((row) => row.status === "refused")).toBe(true);
    }
  });

  it("reports every absent scenario as not-measured by name", () => {
    for (const raw of [undefined, null, {}, [], [null, 42, [], { id: "unknown" }]]) {
      expect(parse(raw).map((row) => [row.id, row.status])).toEqual([
        ["menu-to-game", "not-measured"], ["win", "not-measured"], ["lose", "not-measured"],
        ["save-load", "not-measured"], ["scene-transition", "not-measured"],
      ]);
    }
    expect(parse([reached[1]])[0]?.status).toBe("not-measured");
  });

  it("parses only whole scenario numbers and preserves absent fields instead of zero", () => {
    for (const invalid of [0.5, -1, "2", null, {}, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const row = parse([{ ...reached[1], actions: invalid, frames: { before: invalid, after: invalid } }])[1];
      expect(row?.status).toBe("not-reached");
      expect(row?.evidence).not.toHaveProperty("actions");
      expect(row?.evidence?.frames).not.toHaveProperty("before");
      expect(row?.evidence?.frames).not.toHaveProperty("after");
      expect(parse([reached[1]], invalid)[1]?.status).toBe("not-reached");
    }
    const absent = parse([{ id: "win", frames: {} }])[1]?.evidence;
    expect(absent).not.toHaveProperty("actions");
    expect(absent?.frames).toEqual({});
    expect(parse([{ id: "win", actions: 0, frames: { before: 0, after: 0 } }])[1]?.evidence)
      .toMatchObject({ actions: 0, frames: { before: 0, after: 0 } });
  });

  it("accepts only strings and booleans without coercing hostile scenario objects", () => {
    const hostile = { toString: null, valueOf: null };
    expect(() => parse([hostile, null, 3, { id: hostile }])).not.toThrow();
    const fields = ["outcome", "missing", "reason", "fromState", "toState", "fromScene", "toScene", "saveId", "loadedSaveId", "savedStateHash", "loadedStateHash"];
    expect(() => parse([{ ...reached[1], ...Object.fromEntries(fields.map((field) => [field, hostile])) }])).not.toThrow();
    for (const value of [hostile, 123, false, "   "]) {
      const row = parse([{ ...reached[1], ...Object.fromEntries(fields.map((field) => [field, value])) }])[1];
      expect(row?.status).toBe("not-reached");
      for (const field of fields) expect(row?.evidence).not.toHaveProperty(field);
    }
    for (const field of ["startAccepted", "reached", "reachedOutcome"]) {
      expect(parse([{ ...reached[1], [field]: "true" }])[1]?.status).toBe("not-reached");
    }
  });

  it("duplicate scenario ids cannot cherry-pick a success", () => {
    expect(parse([reached[1], reached[1]])[1]?.status).toBe("not-reached");
    expect(parse([reached[1], { id: "win", startAccepted: false }])[1]?.status).toBe("refused");
  });

  it("maps only supported whole requirements and rejects unrelated scenario success", () => {
    expect(contract).toHaveProperty("scenariosForRequirement");
    expect(contract).toHaveProperty("isRequirementShownByPlaythrough");
    const cases: [string, string[]][] = [
      ["Menu → game", ["menu-to-game"]], ["The player must win the game.", ["win"]],
      ["Lose", ["lose"]], ["Save and load progress", ["save-load"]],
      ["Transition between scenes", ["scene-transition"]], ["Win; lose", ["win", "lose"]],
      ["All tests pass", []], ["Window layout", []], ["Win with 500 coins", []],
      ["Win; cloud leaderboards", []], ["", []],
    ];
    for (const [requirement, ids] of cases) expect(contract.scenariosForRequirement(requirement)).toEqual(ids);
    const won = { found: true, ok: true, scenarios: parse([reached[1]]) };
    expect(contract.isRequirementShownByPlaythrough("Win", won)).toBe(true);
    for (const requirement of ["Lose", "Save and load progress", "Menu → game", "Scene transition", "Win; lose", "Win with 500 coins", "All tests pass"]) {
      expect(contract.isRequirementShownByPlaythrough(requirement, won)).toBe(false);
    }
    expect(contract.isRequirementShownByPlaythrough("Win; lose", { ...won, scenarios: parse(reached) })).toBe(true);
    for (const verdict of [undefined, { found: false }, { ...won, ok: false }, { ...won, found: false }, { ...won, stale: true }, { ...won, unreadable: true }, { found: true, ok: true }, { ...won, scenarios: parse([{ ...reached[1], startAccepted: false }]) }]) {
      expect(contract.isRequirementShownByPlaythrough("Win", verdict)).toBe(false);
    }
  });
});
