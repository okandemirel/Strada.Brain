import { describe, expect, it } from "vitest";
import {
  isAllowedByAnyOfPolicy,
  isAllowedByDualAllowlistPolicy,
  isAllowedBySingleIdPolicy,
} from "./access-policy.js";

describe("access policy helpers", () => {
  it("opens single-id access when the allowlist is empty and mode is open", () => {
    expect(isAllowedBySingleIdPolicy("user-1", [], "open")).toBe(true);
  });

  it("closes single-id access when the allowlist is empty and mode is closed", () => {
    expect(isAllowedBySingleIdPolicy("user-1", [], "closed")).toBe(false);
  });

  it("treats an empty secondary allowlist as unrestricted when the primary allowlist is configured", () => {
    expect(
      isAllowedByDualAllowlistPolicy({
        primaryId: "user-1",
        primaryAllowlist: ["user-1"],
        secondaryId: "room-9",
        secondaryAllowlist: [],
        emptyAllowlistMode: "closed",
      }),
    ).toBe(true);
  });

  it("requires both configured sides to match in the dual allowlist policy", () => {
    expect(
      isAllowedByDualAllowlistPolicy({
        primaryId: "user-1",
        primaryAllowlist: ["user-1"],
        secondaryId: "room-9",
        secondaryAllowlist: ["room-1"],
        emptyAllowlistMode: "open",
      }),
    ).toBe(false);
  });

  it("allows any-of matches by attribute", () => {
    expect(
      isAllowedByAnyOfPolicy({
        subjectId: "user-1",
        subjectAllowlist: [],
        attributes: ["admin", "developer"],
        attributeAllowlist: ["admin"],
        emptyAllowlistMode: "closed",
      }),
    ).toBe(true);
  });

  it("denies any-of access when no subject or attribute allowlists are configured", () => {
    expect(
      isAllowedByAnyOfPolicy({
        subjectId: "user-1",
        subjectAllowlist: [],
        attributes: [],
        attributeAllowlist: [],
        emptyAllowlistMode: "closed",
      }),
    ).toBe(false);
  });
});
