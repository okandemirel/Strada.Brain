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

/** Combined set of all allowed MIME types (hoisted to avoid per-call allocation). */
const ALL_ALLOWED_TYPES = new Set([
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_VIDEO_TYPES,
  ...ALLOWED_AUDIO_TYPES,
  ...ALLOWED_DOCUMENT_TYPES,
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

  if (!ALL_ALLOWED_TYPES.has(mimeType)) {
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
export async function downloadMedia(
  url: string,
  options?: { headers?: Record<string, string> },
): Promise<DownloadedMedia | null> {
  const logger = getLogger();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: options?.headers,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn("Media download failed", { url, status: response.status });
      return null;
    }

    // Check content-length before downloading (only when header is present)
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const contentLength = parseInt(rawLength, 10);
      if (!isNaN(contentLength) && contentLength > DOWNLOAD_MAX_BYTES) {
        logger.warn("Media too large", { url, contentLength });
        return null;
      }
    }

    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    // Post-download size check for responses without content-length
    if (data.length > DOWNLOAD_MAX_BYTES) {
      logger.warn("Downloaded media exceeds size limit", { url, size: data.length });
      return null;
    }

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

/**
 * Classify a MIME type into an Attachment type category.
 */
export function mimeToAttachmentType(
  mimeType: string | undefined | null,
): "image" | "video" | "audio" | "document" {
  if (!mimeType) return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}
