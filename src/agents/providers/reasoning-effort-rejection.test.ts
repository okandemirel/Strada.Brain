/**
 * The endpoint gets to correct us about its own model.
 *
 * `reasoningEffort` is declared once per provider class but belongs to the
 * model. OpencodeProvider declares "low" and its comment recommends "minimal",
 * measured against deepseek-v4-flash. Measured 2026-08-23 against the same
 * provider pointed at ox-alpha-free, "minimal" is HTTP 400 on every request:
 *
 *   [1210] This model always engages in thinking and cannot be disabled;
 *          please use low, high, or max
 *
 * So one env var turns a working provider into one that cannot answer at all,
 * and the advice that leads you there is written in our own source. Rather than
 * keep a table of which model tolerates what, take the correction the endpoint
 * already puts in the error.
 */

import { describe, expect, it } from "vitest";
import {
  isReasoningEffortRejection,
  recoverReasoningEffort,
} from "./reasoning-effort-rejection.js";

const OX_ALPHA_400 =
  'OpenCode (Zen/Go) API error 400: {"error":{"type":"server_error","message":' +
  '"Error from provider (Console Go): Upstream request failed: [1210] This model ' +
  'always engages in thinking and cannot be disabled; please use low, high, or max"}}';

describe("recognising the refusal", () => {
  it("recognises the live ox-alpha-free 400", () => {
    expect(isReasoningEffortRejection(OX_ALPHA_400)).toBe(true);
  });

  it("recognises a 400 that names the parameter outright", () => {
    expect(
      isReasoningEffortRejection(
        "API error 400: Unsupported value: 'reasoning_effort' does not support 'minimal'",
      ),
    ).toBe(true);
  });

  it("leaves other 400s alone — retrying them buries the real error", () => {
    for (const other of [
      "API error 400: model 'ox-alpha' is not supported",
      "API error 400: max_tokens is too large",
      "API error 400: messages: at least one message is required",
    ]) {
      expect(isReasoningEffortRejection(other)).toBe(false);
    }
  });

  // The status gate is the whole difference between "the endpoint told us the
  // value is wrong" and "the endpoint is overloaded". Both can carry identical
  // prose, so these strings would match every inner pattern if the gate went.
  it("does not fire on a 429 that names the parameter", () => {
    expect(
      isReasoningEffortRejection(
        "API error 429: reasoning_effort must be one of low, high — rate limited, retry later",
      ),
    ).toBe(false);
  });

  it("does not fire on a 500 carrying the same refusal text", () => {
    expect(
      isReasoningEffortRejection(
        "API error 500: This model always engages in thinking and cannot be disabled",
      ),
    ).toBe(false);
  });
});

describe("taking the endpoint's correction", () => {
  it("takes the cheapest value the endpoint named", () => {
    // "low, high, or max" — max is not a value we can express, so low wins.
    expect(recoverReasoningEffort(OX_ALPHA_400, "minimal")).toBe("low");
  });

  it("never re-sends the value that was just rejected", () => {
    const said = "API error 400: reasoning_effort must be one of low, medium, high";

    expect(recoverReasoningEffort(said, "low")).toBe("medium");
  });

  it("reads a supported-values list as readily as a please-use list", () => {
    const said = "API error 400: reasoning_effort invalid. Supported values are: high, medium.";

    expect(recoverReasoningEffort(said, "minimal")).toBe("medium");
  });

  it("omits the field when the endpoint named nothing to use instead", () => {
    const said = "API error 400: 'reasoning_effort' is not supported by this model";

    expect(recoverReasoningEffort(said, "low")).toBeNull();
  });

  it("omits the field when the only value named is one we cannot express", () => {
    const said = "API error 400: reasoning_effort must be one of max";

    expect(recoverReasoningEffort(said, "low")).toBeNull();
  });
});
