/**
 * X-1 — the attachment-link HMAC separator is written as an escape, not as a
 * raw NUL byte in the source. A raw control byte makes grep/diff tooling treat
 * channel.ts as binary (and hides its lines from review); the escape is the
 * same byte at runtime, so every link minted before the change still verifies.
 */

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebChannel } from "./channel.js";

describe("WebChannel attachment-link signature (X-1)", () => {
  it("keeps channel.ts free of raw control bytes", () => {
    const source = readFileSync(fileURLToPath(new URL("./channel.ts", import.meta.url)), "utf8");
    // Tab, LF and CR are the only control characters source text needs.
    const offending = [...source].filter((ch) => {
      const code = ch.codePointAt(0)!;
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    });
    expect(offending).toEqual([]);
  });

  it("signs token NUL profileId — the bytes links were always minted with", () => {
    const channel = new WebChannel(3000, 3100);
    const internal = channel as unknown as {
      attachmentStore: { linkScopeKey: () => Buffer };
      attachmentLinkSignature: (token: string, profileId: string) => string;
    };
    const key = internal.attachmentStore.linkScopeKey();
    const expected = createHmac("sha256", key)
      .update(Buffer.concat([Buffer.from("tok-123", "utf8"), Buffer.from([0]), Buffer.from("profile-abc", "utf8")]))
      .digest("base64url");

    expect(internal.attachmentLinkSignature("tok-123", "profile-abc")).toBe(expected);
  });
});
