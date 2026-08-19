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
