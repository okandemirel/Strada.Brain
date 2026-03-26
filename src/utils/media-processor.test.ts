import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateMediaAttachment,
  toBase64ImageSource,
  validateMagicBytes,
  downloadMedia,
  isVisionCompatible,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_AUDIO_TYPES,
  MAX_IMAGE_SIZE,
  MAX_VIDEO_SIZE,
  MAX_AUDIO_SIZE,
} from "./media-processor.js";

vi.mock("./logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("MediaProcessor", () => {
  describe("validateMediaAttachment", () => {
    it("accepts valid JPEG image under size limit", () => {
      const result = validateMediaAttachment({
        mimeType: "image/jpeg",
        size: 1024 * 1024,
        type: "image",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid PNG image", () => {
      const result = validateMediaAttachment({
        mimeType: "image/png",
        size: 5 * 1024 * 1024,
        type: "image",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid WebP image", () => {
      const result = validateMediaAttachment({
        mimeType: "image/webp",
        size: 1024,
        type: "image",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid GIF image", () => {
      const result = validateMediaAttachment({
        mimeType: "image/gif",
        size: 2 * 1024 * 1024,
        type: "image",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects image exceeding 20MB limit", () => {
      const result = validateMediaAttachment({
        mimeType: "image/jpeg",
        size: 25 * 1024 * 1024,
        type: "image",
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("size");
    });

    it("rejects video exceeding 50MB limit", () => {
      const result = validateMediaAttachment({
        mimeType: "video/mp4",
        size: 60 * 1024 * 1024,
        type: "video",
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("size");
    });

    it("rejects unknown MIME type", () => {
      const result = validateMediaAttachment({
        mimeType: "application/x-executable",
        size: 1024,
        type: "file",
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("type");
    });

    it("rejects when mimeType is missing", () => {
      const result = validateMediaAttachment({
        size: 1024,
        type: "image",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects when size is missing", () => {
      const result = validateMediaAttachment({
        mimeType: "image/jpeg",
        type: "image",
      });
      expect(result.valid).toBe(false);
    });

    it("accepts valid audio types", () => {
      for (const mime of ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4"]) {
        const result = validateMediaAttachment({
          mimeType: mime,
          size: 1024 * 1024,
          type: "audio",
        });
        expect(result.valid).toBe(true);
      }
    });

    it("accepts codec-qualified audio MIME types by normalizing them", () => {
      const result = validateMediaAttachment({
        mimeType: "audio/webm;codecs=opus",
        size: 1024 * 1024,
        type: "audio",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid document types", () => {
      for (const mime of ["application/pdf", "text/plain", "text/csv"]) {
        const result = validateMediaAttachment({
          mimeType: mime,
          size: 1024,
          type: "document",
        });
        expect(result.valid).toBe(true);
      }
    });

    it("accepts video at exactly 50MB", () => {
      const result = validateMediaAttachment({
        mimeType: "video/mp4",
        size: MAX_VIDEO_SIZE,
        type: "video",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("toBase64ImageSource", () => {
    it("converts Buffer to base64 ImageSource", () => {
      const data = Buffer.from("fake-image-data");
      const result = toBase64ImageSource(data, "image/jpeg");
      expect(result).toEqual({
        type: "base64",
        media_type: "image/jpeg",
        data: data.toString("base64"),
      });
    });

    it("handles PNG media type", () => {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const result = toBase64ImageSource(data, "image/png");
      expect(result.type).toBe("base64");
      expect(result.media_type).toBe("image/png");
    });
  });

  describe("validateMagicBytes", () => {
    it("validates JPEG magic bytes", () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
      expect(validateMagicBytes(jpeg, "image/jpeg")).toBe(true);
    });

    it("validates PNG magic bytes", () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(validateMagicBytes(png, "image/png")).toBe(true);
    });

    it("validates GIF magic bytes", () => {
      const gif = Buffer.from([0x47, 0x49, 0x46, 0x38]);
      expect(validateMagicBytes(gif, "image/gif")).toBe(true);
    });

    it("validates WebP magic bytes", () => {
      const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
      expect(validateMagicBytes(webp, "image/webp")).toBe(true);
    });

    it("validates MP4 magic bytes", () => {
      const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
      expect(validateMagicBytes(mp4, "video/mp4")).toBe(true);
    });

    it("validates PDF magic bytes", () => {
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
      expect(validateMagicBytes(pdf, "application/pdf")).toBe(true);
    });

    it("rejects mismatched magic bytes", () => {
      const notJpeg = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG bytes
      expect(validateMagicBytes(notJpeg, "image/jpeg")).toBe(false);
    });

    it("returns true for unknown MIME types (no magic bytes to check)", () => {
      const data = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(validateMagicBytes(data, "audio/mpeg")).toBe(true);
    });

    it("returns false for empty buffer", () => {
      expect(validateMagicBytes(Buffer.alloc(0), "image/jpeg")).toBe(false);
    });
  });

  describe("downloadMedia", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("downloads and returns buffer with metadata", async () => {
      const fakeData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "image/jpeg",
          "content-length": "5",
        }),
        arrayBuffer: vi.fn().mockResolvedValue(
          fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength),
        ),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await downloadMedia("https://example.com/photo.jpg");
      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe("image/jpeg");
      expect(result!.size).toBe(5);
      expect(Buffer.isBuffer(result!.data)).toBe(true);
    });

    it("returns null for non-OK response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const result = await downloadMedia("https://example.com/missing.jpg");
      expect(result).toBeNull();
    });

    it("returns null when content-length exceeds 50MB cap", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "image/jpeg",
          "content-length": String(60 * 1024 * 1024),
        }),
        arrayBuffer: vi.fn(),
      } as unknown as Response);

      const result = await downloadMedia("https://example.com/huge.jpg");
      expect(result).toBeNull();
    });

    it("returns null on fetch error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
      const result = await downloadMedia("https://example.com/photo.jpg");
      expect(result).toBeNull();
    });
  });

  describe("isVisionCompatible", () => {
    it("returns true for image MIME types", () => {
      expect(isVisionCompatible("image/jpeg")).toBe(true);
      expect(isVisionCompatible("image/png")).toBe(true);
      expect(isVisionCompatible("image/gif")).toBe(true);
      expect(isVisionCompatible("image/webp")).toBe(true);
    });

    it("returns false for non-image MIME types", () => {
      expect(isVisionCompatible("video/mp4")).toBe(false);
      expect(isVisionCompatible("audio/mpeg")).toBe(false);
      expect(isVisionCompatible("application/pdf")).toBe(false);
    });
  });
});
