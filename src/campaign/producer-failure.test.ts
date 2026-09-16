/**
 * A failure that still carries its evidence (Codex 2026-09-13 AI#11).
 *
 * The producer measured a deadline kill and said so in a receipt; the adapter
 * threw and the receipt was dropped, so the ledger recorded "no receipt came
 * back" about a run that had explained itself precisely.
 */
import { describe, expect, it } from "vitest";
import { ProducerFailure, receiptOfFailure } from "./producer-failure.js";

describe("receiptOfFailure", () => {
  it("returns the receipt a failure carried, and the failure is still a failure", () => {
    const failure = new ProducerFailure("the player was killed at its deadline", '{"schemaVersion":1}');
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("the player was killed at its deadline");
    expect(receiptOfFailure(failure)).toBe('{"schemaVersion":1}');
  });

  it("reads a failure that crossed a boundary which lost its prototype", () => {
    // Two copies of this module (the vendored producer, a different realm)
    // make `instanceof` false while the field is still there.
    expect(receiptOfFailure({ message: "killed", receipt: '{"schemaVersion":1}' })).toBe('{"schemaVersion":1}');
  });

  it("invents nothing: no receipt, a blank one, or a receipt that is not text", () => {
    expect(receiptOfFailure(new ProducerFailure("no evidence"))).toBeUndefined();
    expect(receiptOfFailure(new Error("an ordinary failure"))).toBeUndefined();
    expect(receiptOfFailure({ receipt: "   " })).toBeUndefined();
    expect(receiptOfFailure({ receipt: { schemaVersion: 1 } })).toBeUndefined();
    expect(receiptOfFailure("a string, not a failure")).toBeUndefined();
    expect(receiptOfFailure(null)).toBeUndefined();
    expect(receiptOfFailure(undefined)).toBeUndefined();
  });
});
