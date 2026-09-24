/**
 * CHN-7: confirmation payloads carry a short id and an option index, and the
 * visible text is fitted to each platform's limits.
 */
import { describe, expect, it } from "vitest";
import {
  confirmationOptionAt,
  decodeConfirmationChoice,
  encodeConfirmationChoice,
  fitText,
  shortConfirmationId,
} from "./confirmation-payload.js";
import { createConfirmationBlocks } from "./slack/blocks.js";

const LONG_OPTIONS = Array.from({ length: 5 }, (_, i) => `${i}: ${"Reuse the existing EnemySystem ".repeat(4)}`.slice(0, 100));
const LONG_QUESTION = "Plan step. ".repeat(600); // 6600 chars

describe("confirmation payload encoding", () => {
  it("fits Telegram's 64-byte callback_data and Discord's 100-char customId for any option", () => {
    const id = shortConfirmationId("0f8fad5b-d9cb-469f-a165-70867728950e");
    for (let index = 0; index < 25; index++) {
      const data = encodeConfirmationChoice(id, index);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(decodeConfirmationChoice(data)).toEqual({ confirmId: id, index });
    }
  });

  it("maps an index back to its option and refuses anything else", () => {
    expect(confirmationOptionAt(["Yes", "No"], 1)).toBe("No");
    expect(confirmationOptionAt(["Yes", "No"], 2)).toBeUndefined();
    expect(confirmationOptionAt(["Yes", "No"], -1)).toBeUndefined();
    expect(decodeConfirmationChoice("confirm_abc:Yes")).toBeUndefined();
    expect(decodeConfirmationChoice("confirm_abc:1.5")).toBeUndefined();
    expect(decodeConfirmationChoice(":1")).toBeUndefined();
  });

  it("fitText never exceeds the limit or splits a surrogate pair", () => {
    expect(fitText("short", 10)).toBe("short");
    const fitted = fitText("a".repeat(3) + "😀".repeat(10), 6);
    expect(fitted.length).toBeLessThanOrEqual(6);
    expect(fitted.endsWith("…")).toBe(true);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
});

describe("Slack confirmation blocks respect the 3000-character section limit", () => {
  it("fits a 6600-character question and an entity-heavy details text", () => {
    const blocks = createConfirmationBlocks(LONG_QUESTION, "&<>".repeat(2000), "confirm_abc", LONG_OPTIONS);
    const sections = blocks.filter((b) => b.type === "section") as Array<{ text: { text: string } }>;
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
      // No half-escaped entity at the cut.
      expect(section.text.text).not.toMatch(/&[a-z]*…/);
    }
    const actions = blocks[blocks.length - 1] as { elements: Array<{ action_id: string; text: { text: string } }> };
    expect(actions.elements).toHaveLength(5);
    for (const button of actions.elements) {
      expect(button.text.text.length).toBeLessThanOrEqual(75);
      expect(button.action_id.length).toBeLessThanOrEqual(255);
    }
  });
});
