import { describe, it, expect } from "vitest";
import { describeChannelSpec, formatChannelSpec, isValidChannelSpec, parseChannelSpec } from "./channel-spec.js";

describe("channel spec", () => {
  it("parses one type or several, in order, deduplicated, case-insensitive", () => {
    expect(parseChannelSpec("web")).toEqual(["web"]);
    expect(parseChannelSpec("web,telegram")).toEqual(["web", "telegram"]);
    expect(parseChannelSpec(" Telegram + web , web ")).toEqual(["telegram", "web"]);
    expect(formatChannelSpec(parseChannelSpec("web , telegram"))).toBe("web,telegram");
  });

  it("rejects the whole spec when any member is unknown, and empty specs", () => {
    expect(parseChannelSpec("web,whatsapp")).toEqual([]);
    expect(parseChannelSpec("")).toEqual([]);
    expect(parseChannelSpec(undefined)).toEqual([]);
    expect(isValidChannelSpec("web,telegram")).toBe(true);
    expect(isValidChannelSpec("web,whatsapp")).toBe(false);
    expect(isValidChannelSpec(",")).toBe(false);
  });

  it("describes a spec with the members' labels", () => {
    expect(describeChannelSpec("web,telegram")).toBe("Web dashboard + Telegram bot");
    expect(describeChannelSpec("nope")).toBe("nope");
  });
});
