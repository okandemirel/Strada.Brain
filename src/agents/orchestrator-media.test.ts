import { describe, it, expect } from "vitest";
import { buildUserContent } from "./orchestrator.js";
import type { Attachment } from "../channels/channel-messages.interface.js";

describe("buildUserContent", () => {
  it("returns plain string when no attachments", () => {
    const result = buildUserContent("hello", undefined, true);
    expect(result).toBe("hello");
  });

  it("returns plain string when attachments is empty", () => {
    const result = buildUserContent("hello", [], true);
    expect(result).toBe("hello");
  });

  it("returns text with notes when vision not supported", () => {
    const attachments: Attachment[] = [
      { type: "image", name: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from("test"), size: 4 },
    ];
    const result = buildUserContent("hello", attachments, false);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("hello");
    expect(result as string).toContain("[Attached: photo.jpg (image/jpeg)]");
  });

  it("returns MessageContent[] with image blocks when vision supported", () => {
    const imageData = Buffer.from("fake-image");
    const attachments: Attachment[] = [
      { type: "image", name: "photo.jpg", mimeType: "image/jpeg", data: imageData, size: imageData.length },
    ];
    const result = buildUserContent("describe this", attachments, true);
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "describe this" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: imageData.toString("base64"),
      },
    });
  });

  it("uses URL source when data is missing but url is present", () => {
    const attachments: Attachment[] = [
      { type: "image", name: "photo.jpg", mimeType: "image/jpeg", url: "https://example.com/img.jpg", size: 1024 },
    ];
    const result = buildUserContent("look", attachments, true);
    const blocks = result as any[];
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/img.jpg" },
    });
  });

  it("skips non-image attachments in vision mode, adds text note", () => {
    const attachments: Attachment[] = [
      { type: "document", name: "readme.pdf", mimeType: "application/pdf", size: 1024 },
      { type: "image", name: "photo.png", mimeType: "image/png", data: Buffer.from("x"), size: 1 },
    ];
    const result = buildUserContent("check these", attachments, true);
    const blocks = result as any[];
    // text (with note about pdf) + image block
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("check these");
    expect(blocks[0].text).toContain("[Attached: readme.pdf");
    expect(blocks[1].type).toBe("image");
  });

  it("handles image with no text", () => {
    const attachments: Attachment[] = [
      { type: "image", name: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from("img"), size: 3 },
    ];
    const result = buildUserContent("", attachments, true);
    const blocks = result as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(blocks[1].type).toBe("image");
  });

  it("returns text with notes for non-vision attachments only", () => {
    const attachments: Attachment[] = [
      { type: "document", name: "report.pdf", mimeType: "application/pdf", size: 1024 },
    ];
    const result = buildUserContent("here", attachments, true);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("[Attached: report.pdf");
  });
});
