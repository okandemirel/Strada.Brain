import { inflateSync, inflateRawSync } from "node:zlib";
import { readZipEntry, listZipEntries, looksLikeZip, docxToText } from "./docx-text.js";

/**
 * Readable text out of the formats people actually hand over.
 *
 * A design document arrives as whatever the person who wrote it used — Word,
 * PDF, slides, a spreadsheet of tuning values. Decoding those as UTF-8 produces
 * noise, and a run that reads noise plans from nothing. Measured: the agent was
 * handed a .docx and answered "no local tool can parse it", then asked the user
 * to convert the file by hand.
 *
 * Everything here is written against the container formats directly rather than
 * pulled in as dependencies: each is a ZIP of XML, or a stream format simple
 * enough to read. What this cannot do is stated plainly by returning null, which
 * is a better answer than a screenful of binary.
 */

/** Text this extractor produced, or null when the bytes are not readable text. */
export type ExtractedText = string | null;

/** Strip XML markup, turning the tags that mean "new line" into new lines. */
function xmlToText(xml: string, lineBreakTags: readonly string[]): string {
  let text = xml;
  for (const tag of lineBreakTags) {
    text = text.replace(new RegExp(`</${tag}>`, "gu"), "\n");
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/>`, "gu"), "\n");
  }
  return text
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** One entry of a package, read without letting a corrupt part abort the rest. */
function readPart(buffer: Buffer, entryName: string): string | null {
  try {
    return readZipEntry(buffer, entryName)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
}

/** The number in a part name like `ppt/slides/slide12.xml`, for a fallback sort. */
function partNumber(name: string): number {
  return Number(/(\d+)\.xml$/u.exec(name)?.[1] ?? 0);
}

/**
 * The parts of an OOXML package in the order the document lists them.
 *
 * Audited 2026-09-02: pptxToText probed `slide1.xml, slide2.xml, ...` and
 * stopped at the first miss. Part names are opaque under OPC — deleting a slide
 * leaves a hole, rearranging renames nothing — so a deck saved as slide1, 2, 4,
 * 5 came back as two slides and file_read reported that as the whole document.
 * Membership and order live in the list part (`presentation.xml` sldIdLst,
 * `workbook.xml` sheets), resolved through its rels. When the list is missing,
 * every part in the directory is read in numeric order rather than stopping at
 * the first gap.
 */
function partsInDocumentOrder(
  buffer: Buffer,
  spec: {
    readonly listPart: string;
    readonly relsPart: string;
    readonly itemTag: string;
    readonly relationshipType: string;
    readonly partPattern: RegExp;
    readonly base: string;
  },
): Array<{ readonly part: string; readonly name: string | null }> {
  let onDisk: string[];
  try {
    onDisk = listZipEntries(buffer).filter((entry) => spec.partPattern.test(entry));
  } catch {
    onDisk = [];
  }

  const list = readPart(buffer, spec.listPart);
  const rels = readPart(buffer, spec.relsPart);
  if (list && rels) {
    const targetById = new Map<string, string>();
    for (const match of rels.matchAll(/<Relationship\b[^>]*>/gu)) {
      const tag = match[0];
      const id = /\bId="([^"]+)"/u.exec(tag)?.[1];
      const type = /\bType="([^"]+)"/u.exec(tag)?.[1];
      const target = /\bTarget="([^"]+)"/u.exec(tag)?.[1];
      if (!id || !target || !type?.endsWith(spec.relationshipType)) continue;
      targetById.set(id, target.startsWith("/") ? target.slice(1) : `${spec.base}${target}`);
    }

    const ordered: Array<{ part: string; name: string | null }> = [];
    for (const match of list.matchAll(new RegExp(`<${spec.itemTag}\\b[^>]*>`, "gu"))) {
      const tag = match[0];
      const relId = /\br:id="([^"]+)"/u.exec(tag)?.[1];
      const part = relId ? targetById.get(relId) : undefined;
      if (part) ordered.push({ part, name: /\bname="([^"]+)"/u.exec(tag)?.[1] ?? null });
    }
    if (ordered.length > 0) return ordered;
  }

  return onDisk
    .sort((a, b) => partNumber(a) - partNumber(b))
    .map((part) => ({ part, name: null }));
}

/** PowerPoint: one XML per slide, in the order the presentation lists them. */
function pptxToText(buffer: Buffer): ExtractedText {
  const slides: string[] = [];
  const parts = partsInDocumentOrder(buffer, {
    listPart: "ppt/presentation.xml",
    relsPart: "ppt/_rels/presentation.xml.rels",
    itemTag: "p:sldId",
    relationshipType: "/slide",
    partPattern: /^ppt\/slides\/slide\d+\.xml$/u,
    base: "ppt/",
  });
  parts.forEach(({ part }, index) => {
    const xml = readPart(buffer, part);
    if (!xml) return;
    const text = xmlToText(xml, ["a:p"]);
    if (text) slides.push(`--- Slide ${index + 1} ---\n${text}`);
  });
  return slides.length > 0 ? slides.join("\n\n") : null;
}

/** One cell's text: shared-string index, inline string, boolean, or the literal value. */
function xlsxCellText(attrs: string, inner: string, shared: readonly string[]): string {
  const type = /\bt="([^"]+)"/u.exec(attrs)?.[1];
  const value = /<v>([\s\S]*?)<\/v>/u.exec(inner)?.[1] ?? "";
  if (type === "s") return shared[Number(value)] ?? "";
  if (type === "inlineStr") return xmlToText(/<is>([\s\S]*?)<\/is>/u.exec(inner)?.[1] ?? "", []);
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  // n (the default), str, e, d: the literal is the value.
  return xmlToText(value, []);
}

/**
 * Excel: every worksheet's cell grid, rows as lines and cells tab-separated.
 *
 * Audited 2026-09-02: this read only `xl/sharedStrings.xml`, which holds the
 * deduplicated STRING cells and nothing else. A tuning sheet decoded to its
 * header words with every number gone and no row association, and a
 * numbers-only workbook (Excel writes no shared-strings part then) returned
 * null — "not a text document this tool can read". Numbers live inline in the
 * worksheet parts as `<v>`; strings are `t="s"` pointers into the table.
 */
function xlsxToText(buffer: Buffer): ExtractedText {
  const sharedXml = readPart(buffer, "xl/sharedStrings.xml");
  const shared: string[] = sharedXml
    ? [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map((m) => xmlToText(m[1] ?? "", []))
    : [];

  const sheets = partsInDocumentOrder(buffer, {
    listPart: "xl/workbook.xml",
    relsPart: "xl/_rels/workbook.xml.rels",
    itemTag: "sheet",
    relationshipType: "/worksheet",
    partPattern: /^xl\/worksheets\/sheet\d+\.xml$/u,
    base: "xl/",
  });

  const out: string[] = [];
  sheets.forEach(({ part, name }, index) => {
    const xml = readPart(buffer, part);
    if (!xml) return;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
        cells.push(xlsxCellText(cell[1] ?? "", cell[2] ?? "", shared));
      }
      const line = cells.join("\t").replace(/\t+$/u, "");
      if (line.trim()) rows.push(line);
    }
    if (rows.length > 0) {
      out.push(`--- Sheet ${index + 1}${name ? `: ${name}` : ""} ---\n${rows.join("\n")}`);
    }
  });
  return out.length > 0 ? out.join("\n\n") : null;
}

/** OpenDocument: one content.xml, same idea as Word. */
function odtToText(buffer: Buffer): ExtractedText {
  const content = readZipEntry(buffer, "content.xml");
  if (!content) return null;
  return xmlToText(content.toString("utf8"), ["text:p", "text:h"]) || null;
}

/**
 * RTF: control words out, escaped characters back in.
 *
 * The font and colour tables are destinations, not body text — left in, they
 * leak "Helvetica-Light;;;" into the document the model reads. They nest, so
 * they are removed by matching braces rather than by a pattern.
 */
function stripRtfDestinations(raw: string): string {
  const destinations = ["fonttbl", "colortbl", "stylesheet", "info", "pict", "*"];
  let out = "";
  let i = 0;

  while (i < raw.length) {
    if (raw[i] === "{") {
      const head = raw.slice(i + 1, i + 24);
      const named = destinations.find((d) => head.startsWith(`\\${d}`));
      if (named) {
        // Skip the whole group, counting nested braces.
        let depth = 0;
        while (i < raw.length) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") {
            depth--;
            if (depth === 0) { i++; break; }
          }
          i++;
        }
        continue;
      }
    }
    out += raw[i];
    i++;
  }
  return out;
}

export function rtfToText(raw: string): ExtractedText {
  // Escaped braces are body text; unescaped ones are group syntax. Park the
  // escaped pair before the syntax is stripped, or the unescape runs first and
  // the strip then removes what it just produced.
  const OPEN = "\u0001";
  const CLOSE = "\u0002";

  const text = stripRtfDestinations(raw)
    .replace(/\\\{/gu, OPEN)
    .replace(/\\\}/gu, CLOSE)
    // A backslash at end of line is RTF's line continuation, not an escape.
    .replace(/\\\n/gu, "\n")
    // Line-breaking control words take the space that delimits them with them,
    // otherwise every line after the first starts with a stray space.
    // The lookahead matters: \par is a prefix of \pardirnatural, and without it
    // the control word is half-eaten and its tail is left in as body text.
    .replace(/\\par(?![a-z])[ ]?/giu, "\n")
    .replace(/\\line(?![a-z])[ ]?/giu, "\n")
    .replace(/\\tab(?![a-z])[ ]?/giu, "\t")
    // \'hh is a byte in the document's code page.
    .replace(/\\'([0-9a-f]{2})/giu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\/gu, "\u0003")
    .replace(/\\[a-z]+-?\d*[ ]?/giu, "")
    .replace(/[{}]/gu, "")
    .replace(new RegExp(OPEN, "gu"), "{")
    .replace(new RegExp(CLOSE, "gu"), "}")
    .replace(/\u0003/gu, "\\")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return text || null;
}

/**
 * PDF: the text-showing operators inside the content streams.
 *
 * Handles the ordinary case — a PDF produced by exporting a document — by
 * inflating each stream and reading the `(text) Tj` and `[...] TJ` operators.
 * It does not do OCR, so a scanned page yields nothing, and it does not decrypt.
 * Both of those return null rather than a plausible-looking fragment.
 */
export function pdfToText(buffer: Buffer): ExtractedText {
  const pieces: string[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf("stream", cursor);
    if (start === -1) break;
    const end = buffer.indexOf("endstream", start);
    if (end === -1) break;

    // Skip the EOL that follows the `stream` keyword.
    let dataStart = start + "stream".length;
    if (buffer[dataStart] === 0x0d) dataStart++;
    if (buffer[dataStart] === 0x0a) dataStart++;

    const chunk = buffer.subarray(dataStart, end);
    let decoded: string | null = null;
    for (const inflate of [inflateSync, inflateRawSync]) {
      try {
        decoded = inflate(chunk).toString("latin1");
        break;
      } catch {
        // Not this encoding; try the next, then fall back to the raw bytes.
      }
    }
    if (decoded === null) decoded = chunk.toString("latin1");

    pieces.push(decoded);
    cursor = end + "endstream".length;
  }

  const shown: string[] = [];
  for (const content of pieces) {
    // Only content streams hold shown text. A font or image stream can contain
    // byte sequences that look like PDF string literals, and reading those
    // appends binary noise to the end of a perfectly good extraction.
    if (!/\bBT\b/u.test(content) || !/\bT[jJ]\b/u.test(content)) continue;
    // (literal) Tj  and  [(a) -250 (b)] TJ
    for (const match of content.matchAll(/\((?:\\.|[^\\()])*\)/gu)) {
      const literal = match[0].slice(1, -1);
      const text = literal
        .replace(/\\([()\\])/gu, "$1")
        .replace(/\\n/gu, "\n")
        .replace(/\\t/gu, "\t")
        .replace(/\\r/gu, "")
        .replace(/\\[0-7]{1,3}/gu, (o) => String.fromCharCode(parseInt(o.slice(1), 8)));
      if (text.trim()) shown.push(text);
    }
  }

  const joined = shown
    .join("")
    // Layout positioning produces long runs of spaces; they carry no meaning
    // once the text is out of its page geometry.
    .replace(/[ \t]{3,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return joined || null;
}

/** Extensions this reads as something other than plain UTF-8. */
export const RICH_DOCUMENT_EXTENSIONS = [
  ".docx", ".pdf", ".pptx", ".xlsx", ".odt", ".rtf",
] as const;

/**
 * The readable text of a document, whichever container it arrived in.
 *
 * Returns null when the bytes hold no text this can reach — an encrypted or
 * scanned PDF, an archive missing its body — so the caller can say so instead of
 * presenting noise as content.
 */
export function extractDocumentText(path: string, raw: Buffer): ExtractedText {
  const lower = path.toLowerCase();

  if (lower.endsWith(".docx")) return looksLikeZip(raw) ? docxToText(raw) : null;
  if (lower.endsWith(".pptx")) return looksLikeZip(raw) ? pptxToText(raw) : null;
  if (lower.endsWith(".xlsx")) return looksLikeZip(raw) ? xlsxToText(raw) : null;
  if (lower.endsWith(".odt")) return looksLikeZip(raw) ? odtToText(raw) : null;
  if (lower.endsWith(".rtf")) return rtfToText(raw.toString("latin1"));
  if (lower.endsWith(".pdf")) return pdfToText(raw);

  return raw.toString("utf-8");
}
