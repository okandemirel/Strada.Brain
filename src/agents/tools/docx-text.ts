import { inflateRawSync } from "node:zlib";

/**
 * The text of a .docx, without a dependency.
 *
 * Design documents arrive as Word files — that is what the product's central
 * case looks like in practice. file_read decodes as UTF-8, so a .docx came back
 * as binary noise and the run planned from nothing.
 *
 * A .docx is a ZIP whose `word/document.xml` holds the body. This reads the ZIP
 * central directory and inflates that one entry, the same shape as the tar
 * reader that reads .unitypackage contents, and for the same reason: the format
 * is simple enough that a dependency would cost more than it saves.
 */

const SIGNATURE_CENTRAL_END = 0x06054b50;
const SIGNATURE_CENTRAL_FILE = 0x02014b50;
const SIGNATURE_LOCAL_FILE = 0x04034b50;

/** Is this buffer a ZIP container, which is what a .docx is? */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === SIGNATURE_LOCAL_FILE;
}

/**
 * Every entry name in the archive's central directory, in directory order.
 *
 * Audited 2026-09-02: readers that probed `slide1, slide2, ...` and stopped at
 * the first miss silently truncated any package whose part numbers had a gap.
 * The directory is the only honest list of what the package holds.
 */
export function listZipEntries(buffer: Buffer): string[] {
  let end = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65_535; i--) {
    if (buffer.readUInt32LE(i) === SIGNATURE_CENTRAL_END) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];

  const names: string[] = [];
  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== SIGNATURE_CENTRAL_FILE) break;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** The raw bytes of one entry, or null when the archive does not hold it. */
export function readZipEntry(buffer: Buffer, entryName: string): Buffer | null {
  // Find the end-of-central-directory record, scanning back over the comment.
  let end = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65_535; i--) {
    if (buffer.readUInt32LE(i) === SIGNATURE_CENTRAL_END) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(offset) !== SIGNATURE_CENTRAL_FILE) return null;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (name === entryName) {
      // The local header repeats the name and extra fields with its own lengths.
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      // 0 = stored, 8 = deflate. A .docx uses one of the two.
      return method === 0 ? data : inflateRawSync(data);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * Readable text from Word's document body.
 *
 * Paragraphs become lines and tabs become spaces, so the structure a person
 * wrote survives into what the model reads. Everything else in the markup —
 * fonts, revision ids, styling — is dropped.
 */
export function docxToText(buffer: Buffer): string | null {
  let xml: Buffer | null;
  try {
    xml = readZipEntry(buffer, "word/document.xml");
  } catch {
    return null;
  }
  if (!xml) return null;

  return xml
    .toString("utf8")
    // A paragraph or line break ends a line.
    .replace(/<w:p\b[^>]*\/>/gu, "\n")
    .replace(/<\/w:p>/gu, "\n")
    .replace(/<w:br\b[^>]*\/?>/gu, "\n")
    .replace(/<w:tab\b[^>]*\/?>/gu, "\t")
    // Everything else is markup.
    .replace(/<[^>]+>/gu, "")
    // XML entities, ampersand last so it cannot re-form the others.
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
