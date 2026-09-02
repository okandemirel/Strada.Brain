/**
 * The formats a design document actually arrives in.
 *
 * Measured: handed a .docx, the run answered "no local tool can parse it" and
 * asked the user to convert the file by hand. A document the run cannot read is
 * a run that plans from nothing.
 */

import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { extractDocumentText, pdfToText, rtfToText } from "./document-text.js";

/** A PDF with one deflated content stream, which is what an exported one is. */
function pdfWith(streamBody: string, compress = true): Buffer {
  const body = compress ? deflateSync(Buffer.from(streamBody, "latin1")) : Buffer.from(streamBody);
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 1 >>\nstream\n", "latin1"),
    body,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

describe("reading a PDF", () => {
  it("returns the shown text", () => {
    const pdf = pdfWith("BT /F1 12 Tf (PIXEL FLOW) Tj ET");

    expect(pdfToText(pdf)).toBe("PIXEL FLOW");
  });

  it("reads an uncompressed stream too", () => {
    expect(pdfToText(pdfWith("BT (Core Loop) Tj ET", false))).toBe("Core Loop");
  });

  it("ignores a stream that shows no text", () => {
    // A font or image stream can hold byte runs that look like PDF strings;
    // reading those appended binary noise to a good extraction.
    const pdf = pdfWith("(this is not a content stream, it has no operators)", false);

    expect(pdfToText(pdf)).toBeNull();
  });

  it("says nothing rather than guessing for a scanned page", () => {
    // Measured on a real scanned PDF: no text layer at all. Reporting nothing is
    // the honest answer; this does no OCR.
    expect(pdfToText(Buffer.from("%PDF-1.4\nno streams here\n%%EOF"))).toBeNull();
  });

  it("unescapes the literals PDF uses", () => {
    expect(pdfToText(pdfWith("BT (a\\(b\\)c) Tj ET", false))).toBe("a(b)c");
  });
});

describe("reading an RTF", () => {
  it("returns the body without the control words", () => {
    const rtf = "{\\rtf1\\ansi\\deff0 PIXEL FLOW\\par Core Loop\\par}";

    expect(rtfToText(rtf)).toBe("PIXEL FLOW\nCore Loop");
  });

  it("drops the font table, which is not body text", () => {
    // Left in, it leaks "Helvetica-Light;;;" into what the model reads.
    const rtf = "{\\rtf1{\\fonttbl{\\f0 Helvetica-Light;}}Body text\\par}";

    expect(rtfToText(rtf)).toBe("Body text");
  });

  it("does not half-eat a longer control word that starts the same way", () => {
    // Measured on a real file: \\par is a prefix of \\pardirnatural, and the naive
    // replacement left "dirnatural" in the document as if a person had typed it.
    const rtf = "{\\rtf1\\pardirnatural\\tightenfactor0 Body\\par}";

    expect(rtfToText(rtf)).toBe("Body");
  });

  it("keeps an escaped brace as a brace", () => {
    expect(rtfToText("{\\rtf1 a \\{b\\} c\\par}")).toBe("a {b} c");
  });
});

describe("choosing how to read a file", () => {
  it("leaves plain text exactly as it is", () => {
    expect(extractDocumentText("notes.md", Buffer.from("# Title\nbody"))).toBe("# Title\nbody");
  });

  it("refuses a document whose bytes are not the container its name claims", () => {
    // A .docx that is not a ZIP is not a Word file, whatever it is called.
    expect(extractDocumentText("fake.docx", Buffer.from("just text"))).toBeNull();
    expect(extractDocumentText("fake.pptx", Buffer.from("just text"))).toBeNull();
  });

  it("is case-insensitive about the extension", () => {
    expect(extractDocumentText("GDD.DOCX", Buffer.from("not a zip"))).toBeNull();
  });
});

/** A store-only ZIP holding several entries, which is what an OOXML package is. */
function zipWithEntries(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entryName, contents] of Object.entries(entries)) {
    const name = Buffer.from(entryName, "utf8");
    const data = Buffer.from(contents, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const slideXml = (text: string): string =>
  `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

/**
 * Slide membership and order live in presentation.xml, not in the part names.
 * Audited 2026-09-02: the reader probed slide1, slide2, ... and stopped at the
 * first missing number, so a deck whose third slide had been deleted
 * (slide1, slide2, slide4, slide5 on disk) came back as two slides, and
 * file_read then reported the two-slide extraction as the whole document.
 */
describe("reading a PowerPoint deck", () => {
  it("reads every slide of a deck with a gap in the part numbers", () => {
    const deck = zipWithEntries({
      "ppt/slides/slide1.xml": slideXml("PIXEL FLOW"),
      "ppt/slides/slide2.xml": slideXml("Overview"),
      "ppt/slides/slide4.xml": slideXml("Core Loop"),
      "ppt/slides/slide5.xml": slideXml("Monetisation"),
    });

    const text = extractDocumentText("GDD.pptx", deck);

    expect(text).toContain("PIXEL FLOW");
    expect(text).toContain("Overview");
    expect(text).toContain("Core Loop");
    expect(text).toContain("Monetisation");
  });

  it("orders slides the way the presentation lists them", () => {
    // Rearranging slides never renames the parts: the deck order is in
    // presentation.xml's sldIdLst, resolved through the rels.
    const deck = zipWithEntries({
      "ppt/presentation.xml":
        '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml": slideXml("Second in the deck"),
      "ppt/slides/slide2.xml": slideXml("First in the deck"),
    });

    const text = extractDocumentText("GDD.pptx", deck) ?? "";

    expect(text.indexOf("First in the deck")).toBeLessThan(text.indexOf("Second in the deck"));
    expect(text).toMatch(/--- Slide 1 ---\nFirst in the deck/);
  });

  it("does not emit a part the presentation no longer lists", () => {
    const deck = zipWithEntries({
      "ppt/presentation.xml":
        '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      "ppt/slides/slide1.xml": slideXml("Live slide"),
      "ppt/slides/slide2.xml": slideXml("Orphaned leftover"),
    });

    const text = extractDocumentText("GDD.pptx", deck) ?? "";

    expect(text).toContain("Live slide");
    expect(text).not.toContain("Orphaned leftover");
  });
});

const cell = (ref: string, v: string | number, t?: string): string =>
  `<c r="${ref}"${t ? ` t="${t}"` : ""}><v>${v}</v></c>`;

/**
 * Audited 2026-09-02: the reader returned only the shared-string table, so a
 * tuning sheet came back as its header words with every number gone, and a
 * numbers-only workbook (no shared-strings part at all) came back as null.
 */
describe("reading an Excel workbook", () => {
  it("keeps the numbers and the row they belong to", () => {
    const book = zipWithEntries({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Tuning" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        "<sst><si><t>Ability</t></si><si><t>Damage</t></si><si><t>Cooldown</t></si><si><t>Fireball</t></si><si><t>Frostbolt</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        "<worksheet><sheetData>" +
        `<row r="1">${cell("A1", 0, "s")}${cell("B1", 1, "s")}${cell("C1", 2, "s")}</row>` +
        `<row r="2">${cell("A2", 3, "s")}${cell("B2", 42)}${cell("C2", 2.5)}</row>` +
        `<row r="3">${cell("A3", 4, "s")}${cell("B3", 28)}${cell("C3", 2)}</row>` +
        "</sheetData></worksheet>",
    });

    const text = extractDocumentText("tuning.xlsx", book) ?? "";

    expect(text).toContain("--- Sheet 1: Tuning ---");
    expect(text).toContain("Ability\tDamage\tCooldown");
    expect(text).toContain("Fireball\t42\t2.5");
    expect(text).toContain("Frostbolt\t28\t2");
  });

  it("reads a workbook that has no string cells at all", () => {
    // Excel writes no xl/sharedStrings.xml when every cell is numeric.
    const book = zipWithEntries({
      "xl/worksheets/sheet1.xml":
        `<worksheet><sheetData><row r="1">${cell("A1", 7)}${cell("B1", 9)}</row></sheetData></worksheet>`,
    });

    const text = extractDocumentText("numbers.xlsx", book);

    expect(text).not.toBeNull();
    expect(text).toContain("7\t9");
  });

  it("reads inline strings, which streaming writers emit instead of the shared table", () => {
    const book = zipWithEntries({
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Heal</t></is></c>' +
        `${cell("B1", 12.75)}</row></sheetData></worksheet>`,
    });

    expect(extractDocumentText("inline.xlsx", book)).toContain("Heal\t12.75");
  });
});
