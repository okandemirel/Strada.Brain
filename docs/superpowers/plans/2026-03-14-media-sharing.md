# Media Sharing Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable all channels to receive image/video/audio/document attachments, validate them securely, and forward vision-capable content to LLM providers as image blocks.

**Architecture:** A shared `MediaProcessor` utility handles download, validation (size, MIME, magic bytes), and base64 conversion. Each channel extracts attachments from platform-specific message formats. The orchestrator converts validated `Attachment[]` into `MessageContent[]` image blocks when the active provider supports vision. Providers that already handle image blocks (OpenAI, Gemini, Kimi) work as-is; Claude gets a fix to enable vision support.

**Tech Stack:** Node.js built-in `fetch` for downloads, `Buffer` for base64, existing `Attachment`/`MessageContent`/`ImageSource` types. Zero new npm dependencies.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/utils/media-processor.ts` | Download, validate, convert media to base64 |
| Create | `src/utils/media-processor.test.ts` | Tests for media processor |
| Modify | `src/agents/providers/claude.ts:20-25,121-173` | Enable vision + handle image blocks |
| Create | `src/agents/providers/claude-vision.test.ts` | Tests for Claude vision support |
| Modify | `src/agents/orchestrator.ts:648-649` | Convert attachments to MessageContent[] |
| Create | `src/agents/orchestrator-media.test.ts` | Tests for orchestrator media handling |
| Modify | `src/channels/telegram/bot.ts:393-460` | Add photo/document/video/voice handlers |
| Modify | `src/channels/telegram/bot.test.ts` | Add media handler tests |
| Modify | `src/channels/discord/bot.ts:604-618,766-797` | Extract message.attachments |
| Modify | `src/channels/discord/bot.test.ts` | Add attachment extraction tests |
| Modify | `src/channels/whatsapp/client.ts:170-262` | Download media data via baileys |
| Modify | `src/channels/whatsapp/client.test.ts` | Add media download tests |
| Modify | `src/channels/web/channel.ts:388-410` | Handle base64 media in WebSocket JSON |
| Modify | `src/channels/slack/app.ts:692-751` | Extract message.files via Slack API |
| Modify | `src/channels/slack/__tests__/app.test.ts` | Add file extraction tests |

---

## Chunk 1: Media Processor Utility

### Task 1: MediaProcessor — Validation & Conversion

**Files:**
- Create: `src/utils/media-processor.ts`
- Create: `src/utils/media-processor.test.ts`

- [ ] **Step 1: Write failing tests for media validation**

```typescript
// src/utils/media-processor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateMediaAttachment,
  toBase64ImageSource,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_AUDIO_TYPES,
  MAX_IMAGE_SIZE,
  MAX_VIDEO_SIZE,
  MAX_AUDIO_SIZE,
  type MediaValidationResult,
} from "./media-processor.js";

describe("MediaProcessor", () => {
  describe("validateMediaAttachment", () => {
    it("accepts valid JPEG image under size limit", () => {
      const result = validateMediaAttachment({
        mimeType: "image/jpeg",
        size: 1024 * 1024, // 1MB
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
    // Import after defining
    let validateMagicBytes: typeof import("./media-processor.js").validateMagicBytes;

    beforeEach(async () => {
      const mod = await import("./media-processor.js");
      validateMagicBytes = mod.validateMagicBytes;
    });

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
      // RIFF....WEBP
      const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
      expect(validateMagicBytes(webp, "image/webp")).toBe(true);
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
    let downloadMedia: typeof import("./media-processor.js").downloadMedia;

    beforeEach(async () => {
      const mod = await import("./media-processor.js");
      downloadMedia = mod.downloadMedia;
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
        arrayBuffer: vi.fn().mockResolvedValue(fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength)),
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

    it("returns null when content-length exceeds DOWNLOAD_MAX_BYTES (50MB)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "image/jpeg",
          "content-length": String(60 * 1024 * 1024), // 60MB > 50MB cap
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/media-processor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MediaProcessor**

```typescript
// src/utils/media-processor.ts
/**
 * Media Processing Utilities
 *
 * Download, validate, and convert media attachments for LLM vision.
 * Security: size limits, MIME validation, magic bytes checking.
 */

import { getLogger } from "./logger.js";
import type { ImageSource } from "../agents/providers/provider-core.interface.js";

// ── Size Limits ──────────────────────────────────────────────────────────────

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
export const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50 MB
export const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024; // 10 MB

// ── Allowed MIME Types ───────────────────────────────────────────────────────

export const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export const ALLOWED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/mp4",
]);

export const ALLOWED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
]);

// ── Magic Bytes ──────────────────────────────────────────────────────────────

const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }[]> = {
  "image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  "image/png": [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
  "image/gif": [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
  "image/webp": [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // WEBP
  ],
  "video/mp4": [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }], // ftyp
  "application/pdf": [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface MediaValidationResult {
  valid: boolean;
  reason?: string;
}

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
  size: number;
}

interface ValidationInput {
  mimeType?: string;
  size?: number;
  type: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a media attachment's MIME type and size.
 */
export function validateMediaAttachment(input: ValidationInput): MediaValidationResult {
  const { mimeType, size, type } = input;

  if (!mimeType) {
    return { valid: false, reason: "Missing MIME type" };
  }

  if (size === undefined || size === null) {
    return { valid: false, reason: "Missing file size" };
  }

  // Check MIME type is allowed
  const allAllowed = new Set([
    ...ALLOWED_IMAGE_TYPES,
    ...ALLOWED_VIDEO_TYPES,
    ...ALLOWED_AUDIO_TYPES,
    ...ALLOWED_DOCUMENT_TYPES,
  ]);

  if (!allAllowed.has(mimeType)) {
    return { valid: false, reason: `Unsupported media type: ${mimeType}` };
  }

  // Check size limits based on attachment type
  const maxSize = getMaxSize(type, mimeType);
  if (size > maxSize) {
    const maxMB = Math.round(maxSize / (1024 * 1024));
    return { valid: false, reason: `File size ${Math.round(size / (1024 * 1024))}MB exceeds ${maxMB}MB limit` };
  }

  return { valid: true };
}

function getMaxSize(type: string, mimeType: string): number {
  if (type === "video" || ALLOWED_VIDEO_TYPES.has(mimeType)) return MAX_VIDEO_SIZE;
  if (type === "audio" || ALLOWED_AUDIO_TYPES.has(mimeType)) return MAX_AUDIO_SIZE;
  if (type === "document" || ALLOWED_DOCUMENT_TYPES.has(mimeType)) return MAX_DOCUMENT_SIZE;
  return MAX_IMAGE_SIZE; // Default to image limit
}

/**
 * Validate magic bytes match the claimed MIME type.
 * Returns true if no magic bytes are defined for the MIME type.
 */
export function validateMagicBytes(data: Buffer, mimeType: string): boolean {
  if (data.length === 0) return false;

  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return true; // No signature to check

  return signatures.every(({ offset, bytes }) => {
    if (data.length < offset + bytes.length) return false;
    return bytes.every((b, i) => data[offset + i] === b);
  });
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a Buffer to a base64 ImageSource for LLM vision APIs.
 */
export function toBase64ImageSource(
  data: Buffer,
  mimeType: string,
): Extract<ImageSource, { type: "base64" }> {
  return {
    type: "base64",
    media_type: mimeType,
    data: data.toString("base64"),
  };
}

// ── Download ─────────────────────────────────────────────────────────────────

/** Max overall download size — abort early if content-length signals too large. */
const DOWNLOAD_MAX_BYTES = MAX_VIDEO_SIZE; // 50 MB absolute cap
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Download media from a URL. Returns null on failure.
 * Validates content-length before downloading body.
 */
export async function downloadMedia(url: string): Promise<DownloadedMedia | null> {
  const logger = getLogger();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn("Media download failed", { url, status: response.status });
      return null;
    }

    // Check content-length before downloading
    const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
    if (contentLength > DOWNLOAD_MAX_BYTES) {
      logger.warn("Media too large", { url, contentLength });
      return null;
    }

    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    return {
      data,
      mimeType,
      size: data.length,
    };
  } catch (error) {
    logger.warn("Media download error", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check if a MIME type is a vision-compatible image type
 * (types that can be sent to LLM vision APIs).
 */
export function isVisionCompatible(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(mimeType);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/media-processor.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/media-processor.ts src/utils/media-processor.test.ts
git commit -m "feat: add media processor utility for download, validation, and base64 conversion"
```

---

## Chunk 2: Claude Provider Vision Fix + Orchestrator Media Pipeline

### Task 2: Fix Claude Provider Vision Support

**Files:**
- Modify: `src/agents/providers/claude.ts:20-25,121-173`
- Create: `src/agents/providers/claude-vision.test.ts`

- [ ] **Step 1: Write failing test for Claude image block handling**

```typescript
// src/agents/providers/claude-vision.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeProvider } from "./claude.js";
import type { ConversationMessage, MessageContent } from "./provider-core.interface.js";

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "I can see the image." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      },
    })),
  };
});

describe("ClaudeProvider vision support", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider("test-key"); // positional arg, not object
  });

  it("declares vision capability", () => {
    expect(provider.capabilities.vision).toBe(true);
  });

  it("converts base64 image blocks in buildMessages", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "dGVzdA==",
            },
          },
        ] as MessageContent[],
      },
    ];

    // Access private method via any
    const built = (provider as any).buildMessages(messages);
    expect(built).toHaveLength(1);
    expect(built[0].role).toBe("user");

    const content = built[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "dGVzdA==",
      },
    });
  });

  it("converts URL image blocks", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          {
            type: "image",
            source: { type: "url", url: "https://example.com/img.png" },
          },
        ] as MessageContent[],
      },
    ];

    const built = (provider as any).buildMessages(messages);
    const content = built[0].content;
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/providers/claude-vision.test.ts`
Expected: FAIL — vision is false, image blocks not handled

- [ ] **Step 3: Fix Claude provider — enable vision + handle image blocks**

In `src/agents/providers/claude.ts`:

**Change 1** — Set `vision: true` (line ~25):
```
old: vision: false,
new: vision: true,
```

**Change 2** — Add image block handling in `buildMessages` (inside the `Array.isArray` branch, after the text block handler, before the tool_result handler):
```typescript
// Add after: if (block.type === "text") { ... }
} else if (block.type === "image") {
  content.push({
    type: "image",
    source: block.source.type === "base64"
      ? {
          type: "base64" as const,
          media_type: block.source.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: block.source.data,
        }
      : {
          type: "url" as const,
          url: block.source.url,
        },
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/providers/claude-vision.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/providers/claude.ts src/agents/providers/claude-vision.test.ts
git commit -m "fix: enable Claude vision support and handle image blocks in buildMessages"
```

### Task 3: Orchestrator — Convert Attachments to MessageContent[]

**Files:**
- Modify: `src/agents/orchestrator.ts:648-649`
- Create: `src/agents/orchestrator-media.test.ts`

- [ ] **Step 1: Write failing test for attachment-to-content conversion**

```typescript
// src/agents/orchestrator-media.test.ts
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

  it("returns plain string when vision not supported", () => {
    const attachments: Attachment[] = [
      { type: "image", name: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from("test"), size: 4 },
    ];
    const result = buildUserContent("hello", attachments, false);
    expect(result).toBe("hello\n\n[Attached: photo.jpg (image/jpeg)]");
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
    // text + note about pdf + image block
    expect(blocks).toHaveLength(3);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/orchestrator-media.test.ts`
Expected: FAIL — buildUserContent not exported

- [ ] **Step 3: Add buildUserContent function and wire into processMessage**

**Add exported function** at the end of orchestrator.ts (before any private methods), and update `processMessage` to use it:

```typescript
// Export this function from orchestrator.ts
import { isVisionCompatible, toBase64ImageSource } from "../utils/media-processor.js";
import type { Attachment } from "../channels/channel-messages.interface.js";
import type { MessageContent } from "./providers/provider-core.interface.js";

/**
 * Build user message content, converting image attachments to vision blocks
 * when the provider supports it.
 */
export function buildUserContent(
  text: string,
  attachments: Attachment[] | undefined,
  supportsVision: boolean,
): string | MessageContent[] {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  const imageAttachments = attachments.filter(
    (a) => a.mimeType && isVisionCompatible(a.mimeType) && (a.data || a.url),
  );
  const nonImageAttachments = attachments.filter(
    (a) => !a.mimeType || !isVisionCompatible(a.mimeType) || (!a.data && !a.url),
  );

  // If no vision support or no image attachments, append text notes
  if (!supportsVision || imageAttachments.length === 0) {
    const notes = attachments
      .map((a) => `[Attached: ${a.name} (${a.mimeType ?? "unknown"})]`)
      .join("\n");
    return text ? `${text}\n\n${notes}` : notes;
  }

  // Build MessageContent[] with image blocks
  const content: MessageContent[] = [];

  // Text block (with non-image notes appended)
  let textPart = text;
  if (nonImageAttachments.length > 0) {
    const notes = nonImageAttachments
      .map((a) => `[Attached: ${a.name} (${a.mimeType ?? "unknown"})]`)
      .join("\n");
    textPart = textPart ? `${textPart}\n\n${notes}` : notes;
  }
  content.push({ type: "text", text: textPart || "What is in this image?" });

  // Image blocks
  for (const att of imageAttachments) {
    if (att.data) {
      content.push({
        type: "image",
        source: toBase64ImageSource(att.data, att.mimeType!),
      });
    } else if (att.url) {
      content.push({
        type: "image",
        source: { type: "url", url: att.url },
      });
    }
  }

  return content;
}
```

**Update processMessage** (line 648-649):

```
old: session.messages.push({ role: "user", content: text });
new:
    const provider = this.providerManager.getProvider(chatId);
    const supportsVision = provider.capabilities.vision;
    const userContent = buildUserContent(text, msg.attachments, supportsVision);
    session.messages.push({ role: "user", content: userContent });
```

Note: `const provider` declaration in `runAgentLoop` (line 704) will need to be removed or reused since we now get it earlier. The simplest approach is to let `runAgentLoop` re-fetch it (it's a cheap Map lookup).

Also update the `trimSession` memory persistence block (lines 654-670) to extract text from `MessageContent[]`:

```
old: .map(
       (m) => `[${m.role}] ${typeof m.content === "string" ? m.content : "[complex content]"}`,
     )
new: .map((m) => {
       if (typeof m.content === "string") return `[${m.role}] ${m.content}`;
       if (Array.isArray(m.content)) {
         const textParts = (m.content as MessageContent[])
           .filter((b): b is { type: "text"; text: string } => b.type === "text")
           .map((b) => b.text);
         return `[${m.role}] ${textParts.join(" ") || "[media message]"}`;
       }
       return `[${m.role}] [complex content]`;
     })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/orchestrator-media.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing orchestrator tests to verify no regressions**

Run: `npx vitest run src/agents/orchestrator.test.ts`
Expected: PASS (existing tests still pass)

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts src/agents/orchestrator-media.test.ts
git commit -m "feat: convert image attachments to vision blocks in orchestrator"
```

---

## Chunk 3: Channel Media Extraction — Telegram & Discord

### Task 4: Telegram — Photo, Document, Video, Voice Handlers

**Files:**
- Modify: `src/channels/telegram/bot.ts:393-460`
- Modify: `src/channels/telegram/bot.test.ts`

- [ ] **Step 1: Write failing test for photo message handling**

Add to `src/channels/telegram/bot.test.ts`:

```typescript
describe("media message handling", () => {
  it("routes photo messages with attachment", async () => {
    let captured: IncomingMessage | null = null;
    channel.onMessage(async (msg) => { captured = msg; });

    const photoHandler = mockHandlers.get("message:photo");
    expect(photoHandler).toBeDefined();

    const ctx = {
      from: { id: 123 },
      chat: { id: 789 },
      message: {
        photo: [
          { file_id: "small", width: 90, height: 90, file_size: 1000 },
          { file_id: "large", width: 800, height: 600, file_size: 50000 },
        ],
        caption: "Check this image",
        date: Math.floor(Date.now() / 1000),
      },
      api: {
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({
          file_path: "photos/file_123.jpg",
        }),
      },
    };

    await photoHandler!(ctx);

    expect(captured).not.toBeNull();
    expect(captured!.text).toBe("Check this image");
    expect(captured!.attachments).toHaveLength(1);
    expect(captured!.attachments![0].type).toBe("image");
    expect(captured!.attachments![0].mimeType).toBe("image/jpeg");
  });

  it("routes document messages", async () => {
    let captured: IncomingMessage | null = null;
    channel.onMessage(async (msg) => { captured = msg; });

    const docHandler = mockHandlers.get("message:document");
    expect(docHandler).toBeDefined();

    const ctx = {
      from: { id: 123 },
      chat: { id: 789 },
      message: {
        document: {
          file_id: "doc_123",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 5000,
        },
        caption: "Here is the report",
        date: Math.floor(Date.now() / 1000),
      },
      api: {
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({
          file_path: "documents/file_456.pdf",
        }),
      },
    };

    await docHandler!(ctx);

    expect(captured).not.toBeNull();
    expect(captured!.text).toBe("Here is the report");
    expect(captured!.attachments).toHaveLength(1);
    expect(captured!.attachments![0].type).toBe("document");
    expect(captured!.attachments![0].name).toBe("report.pdf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/telegram/bot.test.ts`
Expected: FAIL — no `message:photo` or `message:document` handlers

- [ ] **Step 3: Add media handlers to Telegram channel**

In `src/channels/telegram/bot.ts`, inside `setupHandlers()` method, add before the `message:text` handler:

```typescript
import type { Attachment } from "../channel-messages.interface.js";
import { downloadMedia, validateMediaAttachment, validateMagicBytes } from "../../utils/media-processor.js";

// Handle photo messages
this.bot.on("message:photo", async (ctx) => {
  await this.routeMediaMessage(ctx, "image");
});

// Handle document messages
this.bot.on("message:document", async (ctx) => {
  await this.routeMediaMessage(ctx, "document");
});

// Handle video messages
this.bot.on("message:video", async (ctx) => {
  await this.routeMediaMessage(ctx, "video");
});

// Handle voice/audio messages
this.bot.on("message:voice", async (ctx) => {
  await this.routeMediaMessage(ctx, "audio");
});

this.bot.on("message:audio", async (ctx) => {
  await this.routeMediaMessage(ctx, "audio");
});
```

Also add the import for `Attachment` type at the top of the file:
```typescript
import type { Attachment } from "../channel-messages.interface.js";
import { downloadMedia, validateMediaAttachment, validateMagicBytes } from "../../utils/media-processor.js";
```

Add the `routeMediaMessage` method to the class:

```typescript
private async routeMediaMessage(ctx: Context, mediaType: Attachment["type"]): Promise<void> {
  if (!this.handler) {
    await ctx.reply("Brain is not ready yet. Please try again later.");
    return;
  }

  const userId = String(ctx.from?.id ?? "");
  const rateResult = this.rateLimiter.checkMessageRate(userId);
  if (!rateResult.allowed) {
    getLogger().warn("Telegram: rate limited", { userId, reason: rateResult.reason });
    await ctx.reply("You have sent too many messages. Please wait before trying again.");
    return;
  }

  const attachments: Attachment[] = [];
  const message = ctx.message;
  if (!message) return;

  try {
    if (mediaType === "image" && message.photo && message.photo.length > 0) {
      // Get the largest photo (last in array)
      const photo = message.photo[message.photo.length - 1]!;
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const downloaded = await downloadMedia(fileUrl);
      if (downloaded) {
        const validation = validateMediaAttachment({
          mimeType: downloaded.mimeType,
          size: downloaded.size,
          type: "image",
        });
        if (validation.valid && validateMagicBytes(downloaded.data, downloaded.mimeType)) {
          attachments.push({
            type: "image",
            name: file.file_path?.split("/").pop() ?? "photo.jpg",
            mimeType: downloaded.mimeType || "image/jpeg",
            data: downloaded.data,
            size: downloaded.size,
          });
        }
      }
    } else if (mediaType === "document" && message.document) {
      const doc = message.document;
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const downloaded = await downloadMedia(fileUrl);
      if (downloaded) {
        const validation = validateMediaAttachment({
          mimeType: doc.mime_type ?? downloaded.mimeType,
          size: downloaded.size,
          type: "document",
        });
        if (validation.valid) {
          attachments.push({
            type: "document",
            name: doc.file_name ?? "document",
            mimeType: doc.mime_type ?? downloaded.mimeType,
            data: downloaded.data,
            size: downloaded.size,
          });
        }
      }
    } else if (mediaType === "video" && message.video) {
      const video = message.video;
      const file = await ctx.api.getFile(video.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const downloaded = await downloadMedia(fileUrl);
      if (downloaded) {
        const validation = validateMediaAttachment({
          mimeType: video.mime_type ?? downloaded.mimeType,
          size: downloaded.size,
          type: "video",
        });
        if (validation.valid) {
          attachments.push({
            type: "video",
            name: file.file_path?.split("/").pop() ?? "video.mp4",
            mimeType: video.mime_type ?? downloaded.mimeType,
            data: downloaded.data,
            size: downloaded.size,
          });
        }
      }
    } else if (mediaType === "audio") {
      const audio = message.voice ?? message.audio;
      if (audio) {
        const file = await ctx.api.getFile(audio.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
        const downloaded = await downloadMedia(fileUrl);
        if (downloaded) {
          const validation = validateMediaAttachment({
            mimeType: downloaded.mimeType,
            size: downloaded.size,
            type: "audio",
          });
          if (validation.valid) {
            attachments.push({
              type: "audio",
              name: file.file_path?.split("/").pop() ?? "audio.ogg",
              mimeType: downloaded.mimeType,
              data: downloaded.data,
              size: downloaded.size,
            });
          }
        }
      }
    }
  } catch (error) {
    getLogger().warn("Failed to process media", {
      type: mediaType,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const caption =
    (message as any).caption ?? "";

  const msg: IncomingMessage = {
    channelType: "telegram",
    chatId: String(ctx.chat?.id ?? ""),
    userId,
    text: caption,
    attachments: attachments.length > 0 ? attachments : undefined,
    replyTo: message.reply_to_message?.message_id?.toString(),
    timestamp: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000),
  };

  try {
    await ctx.api.sendChatAction(parseInt(msg.chatId, 10), "typing");
    await this.handler(msg);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    getLogger().error("Error handling media message", { chatId: msg.chatId, error: errMsg });
    await ctx.reply("An error occurred while processing your media. Please try again.");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/telegram/bot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram/bot.ts src/channels/telegram/bot.test.ts
git commit -m "feat: add photo, document, video, voice handlers to Telegram channel"
```

### Task 5: Discord — Extract Message Attachments

**Files:**
- Modify: `src/channels/discord/bot.ts:604-618,766-797`
- Modify: `src/channels/discord/bot.test.ts`

- [ ] **Step 1: Write failing test for attachment extraction**

Add to `src/channels/discord/bot.test.ts`:

```typescript
describe("media attachment extraction", () => {
  it("extracts image attachments from Discord message", async () => {
    let captured: IncomingMessage | null = null;
    channel.onMessage(async (msg) => { captured = msg; });

    // Simulate MessageCreate event with attachments
    const mockMessage = {
      author: { bot: false, id: "user-1" },
      content: "Check this image",
      channelId: "channel-1",
      reference: null,
      createdAt: new Date(),
      attachments: new Map([
        ["att-1", {
          id: "att-1",
          url: "https://cdn.discordapp.com/attachments/123/456/photo.jpg",
          name: "photo.jpg",
          contentType: "image/jpeg",
          size: 50000,
        }],
      ]),
      channel: { isTextBased: () => true, sendTyping: vi.fn() },
      reply: vi.fn(),
    };

    // Trigger the MessageCreate handler
    const messageCreateHandler = getEventHandler(Events.MessageCreate);
    await messageCreateHandler(mockMessage);

    expect(captured).not.toBeNull();
    expect(captured!.attachments).toHaveLength(1);
    expect(captured!.attachments![0].type).toBe("image");
    expect(captured!.attachments![0].name).toBe("photo.jpg");
    expect(captured!.attachments![0].url).toBe("https://cdn.discordapp.com/attachments/123/456/photo.jpg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/discord/bot.test.ts`
Expected: FAIL — attachments not extracted

- [ ] **Step 3: Add attachment extraction to Discord channel**

In `src/channels/discord/bot.ts`, modify `handleRegularMessage` method:

```typescript
import type { Attachment } from "../channel-messages.interface.js";

private async handleRegularMessage(message: Message): Promise<void> {
  if (!this.handler) {
    await message.reply("Brain is not ready yet. Please try again later.");
    return;
  }

  // Extract attachments
  const attachments: Attachment[] = [];
  if (message.attachments.size > 0) {
    for (const [, att] of message.attachments) {
      const type = att.contentType?.startsWith("image/") ? "image" as const
        : att.contentType?.startsWith("video/") ? "video" as const
        : att.contentType?.startsWith("audio/") ? "audio" as const
        : "document" as const;

      attachments.push({
        type,
        name: att.name ?? "attachment",
        url: att.url,
        mimeType: att.contentType ?? undefined,
        size: att.size,
      });
    }
  }

  const msg: IncomingMessage = {
    channelType: "discord",
    chatId: message.channelId,
    userId: message.author.id,
    text: message.content,
    attachments: attachments.length > 0 ? attachments : undefined,
    replyTo: message.reference?.messageId ?? undefined,
    timestamp: message.createdAt,
  };

  try {
    if (message.channel.isTextBased() && "sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }
    await this.handler(msg);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    getLogger().error("Error handling Discord message", { chatId: msg.chatId, error: errMsg });
    await message.reply("An error occurred while processing your request. Please try again.");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/discord/bot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/discord/bot.ts src/channels/discord/bot.test.ts
git commit -m "feat: extract image/video/audio/document attachments from Discord messages"
```

---

## Chunk 4: Channel Media Extraction — WhatsApp, Web, Slack

### Task 6: WhatsApp — Download Media Data

**Files:**
- Modify: `src/channels/whatsapp/client.ts:170-262`
- Modify: `src/channels/whatsapp/client.test.ts`

WhatsApp channel already detects `imageMessage` and `documentMessage`, but only stores the `url` — not the binary data. We need to add `videoMessage` and `audioMessage` detection, and download media data for vision-compatible types.

- [ ] **Step 1: Write failing test for video/audio attachment detection**

Add tests to `src/channels/whatsapp/client.test.ts`:

```typescript
describe("media attachment detection", () => {
  it("detects video messages as attachments", () => {
    // Simulate messages.upsert event handler with videoMessage
    // Verify attachments array includes type: "video"
  });

  it("detects audio messages as attachments", () => {
    // Simulate messages.upsert event handler with audioMessage
    // Verify attachments array includes type: "audio"
  });

  it("downloads image data for vision support", () => {
    // Verify downloaded.data is set on image attachments
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/whatsapp/client.test.ts`
Expected: FAIL

- [ ] **Step 3: Add video/audio detection and media download to WhatsApp**

In `src/channels/whatsapp/client.ts`, in the `messages.upsert` handler:

Add video and audio detection alongside the existing image/document. Also download image data for vision support using `downloadMedia`:

```typescript
import { downloadMedia } from "../../utils/media-processor.js";

// In the messages.upsert handler, after existing image/document detection:

// Download image data for vision (images are small enough)
if (msg.message.imageMessage) {
  const imgUrl = msg.message.imageMessage.url;
  let imgData: Buffer | undefined;
  if (imgUrl) {
    const downloaded = await downloadMedia(imgUrl);
    if (downloaded) imgData = downloaded.data;
  }
  attachments.push({
    type: "image",
    name: "image",
    mimeType: msg.message.imageMessage.mimetype ?? "image/jpeg",
    url: imgUrl ?? undefined,
    data: imgData,
  });
}

if (msg.message.videoMessage) {
  attachments.push({
    type: "video",
    name: "video.mp4",
    mimeType: msg.message.videoMessage.mimetype ?? "video/mp4",
    url: msg.message.videoMessage.url ?? undefined,
  });
}
if (msg.message.audioMessage) {
  attachments.push({
    type: "audio",
    name: "audio.ogg",
    mimeType: msg.message.audioMessage.mimetype ?? "audio/ogg",
    url: msg.message.audioMessage.url ?? undefined,
  });
}
```

Note: This replaces the existing `imageMessage` block (lines 186-193) with the version that downloads data. The `documentMessage` block (lines 194-201) stays as-is since documents aren't vision-compatible.
```

Also update the `MessagesUpsert` interface to include `videoMessage` and `audioMessage`:

```typescript
videoMessage?: {
  url?: string;
  caption?: string;
  mimetype?: string;
};
audioMessage?: {
  url?: string;
  mimetype?: string;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/whatsapp/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/whatsapp/client.ts src/channels/whatsapp/client.test.ts
git commit -m "feat: add video/audio attachment detection to WhatsApp channel"
```

### Task 7: Web Channel — Handle Media in WebSocket Messages

**Files:**
- Modify: `src/channels/web/channel.ts:388-410`

- [ ] **Step 1: Add media handling to WebSocket message handler**

In `src/channels/web/channel.ts`, add import at top:
```typescript
import { validateMediaAttachment, validateMagicBytes } from "../../utils/media-processor.js";
```

Then update `handleWsMessage` case `"message"` to accept attachments:

```typescript
case "message": {
  const text = String(data.text ?? "").trim();
  const rawAttachments = data.attachments as Array<{
    type?: string;
    name?: string;
    mimeType?: string;
    data?: string; // base64
    size?: number;
  }> | undefined;

  if (!text && (!rawAttachments || rawAttachments.length === 0)) return;
  if (!this.handler) return;

  // Convert base64 attachments to Attachment[] with validation
  const attachments: Attachment[] = [];
  if (rawAttachments && Array.isArray(rawAttachments)) {
    for (const raw of rawAttachments.slice(0, 5)) { // Max 5 attachments per message
      if (!raw.name || !raw.mimeType) continue;
      const data = raw.data ? Buffer.from(raw.data, "base64") : undefined;
      const size = data?.length ?? raw.size ?? 0;

      // Validate before accepting
      const validation = validateMediaAttachment({ mimeType: raw.mimeType, size, type: raw.type ?? "file" });
      if (!validation.valid) continue;
      if (data && !validateMagicBytes(data, raw.mimeType)) continue;

      attachments.push({
        type: (raw.type as Attachment["type"]) ?? "file",
        name: raw.name,
        mimeType: raw.mimeType,
        data,
        size,
      });
    }
  }

  const msg: IncomingMessage = {
    channelType: "web",
    chatId,
    userId: `web-${chatId}`,
    text: text || "",
    attachments: attachments.length > 0 ? attachments : undefined,
    timestamp: new Date(),
  };

  this.handler(msg).catch((err) => {
    this.sendToClient(chatId, {
      type: "text",
      text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
      messageId: randomUUID(),
    });
  });
  break;
}
```

Also update the CSP header to allow `blob:` for image previews:
```
img-src 'self' data: blob:;
```

- [ ] **Step 2: Run existing Web channel tests to verify no regressions**

Run: `npx vitest run src/channels/web/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/channels/web/channel.ts
git commit -m "feat: handle base64 media attachments in Web channel WebSocket messages"
```

### Task 8: Slack — Extract Files from Message Events

**Files:**
- Modify: `src/channels/slack/app.ts:692-751`
- Modify: `src/channels/slack/__tests__/app.test.ts`

- [ ] **Step 1: Write failing test for Slack file extraction**

Add to `src/channels/slack/__tests__/app.test.ts`:

```typescript
describe("file attachment extraction", () => {
  it("extracts files from Slack message events", async () => {
    let captured: IncomingMessage | null = null;
    channel.onMessage(async (msg) => { captured = msg; });

    // Simulate message event with files
    const message = {
      text: "Check this file",
      user: "U123",
      channel: "C123",
      ts: "1234567890.123456",
      files: [
        {
          id: "F123",
          name: "screenshot.png",
          mimetype: "image/png",
          size: 50000,
          url_private: "https://files.slack.com/files-pri/T123-F123/screenshot.png",
        },
      ],
    };

    await handleIncomingMessage(message, say);

    expect(captured).not.toBeNull();
    expect(captured!.attachments).toHaveLength(1);
    expect(captured!.attachments![0].type).toBe("image");
    expect(captured!.attachments![0].name).toBe("screenshot.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/slack/__tests__/app.test.ts`
Expected: FAIL

- [ ] **Step 3: Add file extraction to Slack message handler**

In `src/channels/slack/app.ts`, update `handleIncomingMessage`:

```typescript
// After text extraction, before creating incomingMessage:
const attachments: Attachment[] = [];

// Extract files from message
const files = (message as any).files as Array<{
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
}> | undefined;

if (files && Array.isArray(files)) {
  for (const file of files) {
    if (!file.name || !file.mimetype) continue;
    const type = file.mimetype.startsWith("image/") ? "image" as const
      : file.mimetype.startsWith("video/") ? "video" as const
      : file.mimetype.startsWith("audio/") ? "audio" as const
      : "document" as const;

    // url_private requires Bearer auth — download now while we have the token
    let data: Buffer | undefined;
    if (file.url_private && this.config.botToken) {
      try {
        const resp = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.config.botToken}` },
        });
        if (resp.ok) {
          data = Buffer.from(await resp.arrayBuffer());
        }
      } catch {
        // Non-critical — attachment will have URL but no data
      }
    }

    attachments.push({
      type,
      name: file.name,
      url: file.url_private,
      mimeType: file.mimetype,
      size: file.size ?? data?.length,
      data,
    });
  }
}
```

Then update the `incomingMessage` construction to use the populated `attachments` array (it already initializes `const attachments: Attachment[] = [];` on line 728 — just add the file extraction logic before it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/slack/__tests__/app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/slack/app.ts src/channels/slack/__tests__/app.test.ts
git commit -m "feat: extract file attachments from Slack message events"
```

---

## Chunk 5: Integration Verification & Final Commit

### Task 9: Full Test Suite Verification

- [ ] **Step 1: Run all tests to verify no regressions**

Run: `npx vitest run`
Expected: ALL PASS — all existing + new tests green

- [ ] **Step 2: Run TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Final integration commit**

```bash
git add src/utils/media-processor.ts src/utils/media-processor.test.ts \
       src/agents/providers/claude.ts src/agents/providers/claude-vision.test.ts \
       src/agents/orchestrator.ts src/agents/orchestrator-media.test.ts \
       src/channels/telegram/bot.ts src/channels/telegram/bot.test.ts \
       src/channels/discord/bot.ts src/channels/discord/bot.test.ts \
       src/channels/whatsapp/client.ts src/channels/whatsapp/client.test.ts \
       src/channels/web/channel.ts \
       src/channels/slack/app.ts src/channels/slack/__tests__/app.test.ts
git commit -m "feat: v5.0 media sharing pipeline — channels receive and forward attachments to vision LLMs

- Add MediaProcessor utility (download, validate, magic bytes, base64)
- Fix Claude provider vision support (was false, now true + image blocks)
- Orchestrator converts Attachment[] to MessageContent[] image blocks
- Telegram: photo, document, video, voice message handlers
- Discord: extract message.attachments collection
- WhatsApp: add video/audio detection alongside existing image/document
- Web: handle base64 media in WebSocket JSON messages
- Slack: extract files array from message events
- Security: size limits (20MB image, 50MB video), MIME validation, magic bytes"
```
