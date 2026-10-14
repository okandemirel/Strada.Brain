/**
 * Reading a Word document, because that is the form a design document arrives in.
 *
 * Measured: UTF-8 decoding turns a .docx into binary noise, so the run reads
 * gibberish and plans from nothing.
 */

import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { docxToText, looksLikeZip, readZipEntry } from "./docx-text.js";

/** A minimal ZIP holding one deflated entry, which is what a .docx is. */
function zipWith(entryName: string, contents: string): Buffer {
  const name = Buffer.from(entryName, "utf8");
  const data = deflateRawSync(Buffer.from(contents, "utf8"));

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const centralStart = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralStart, 16);

  return Buffer.concat([local, name, data, central, name, end]);
}

const doc = (body: string): Buffer => zipWith("word/document.xml", body);

describe("recognising the container", () => {
  it("knows a zip when it sees one", () => {
    expect(looksLikeZip(doc("<w:p><w:t>hi</w:t></w:p>"))).toBe(true);
  });

  it("does not mistake plain text for one", () => {
    expect(looksLikeZip(Buffer.from("# Just markdown"))).toBe(false);
  });
});

describe("reading the body out of a Word file", () => {
  it("returns the words a person wrote", () => {
    const text = docxToText(doc("<w:p><w:r><w:t>Lanterns light the harbour</w:t></w:r></w:p>"));

    expect(text).toBe("Lanterns light the harbour");
  });

  it("keeps paragraphs on separate lines", () => {
    const text = docxToText(
      doc("<w:p><w:t>First paragraph</w:t></w:p><w:p><w:t>Second paragraph</w:t></w:p>"),
    );

    expect(text).toBe("First paragraph\nSecond paragraph");
  });

  it("turns a tab into a tab, not into nothing", () => {
    // Columns laid out with tabs lose their shape otherwise.
    expect(docxToText(doc("<w:p><w:t>Lantern</w:t><w:tab/><w:t>Brass</w:t></w:p>"))).toBe("Lantern\tBrass");
  });

  it("decodes entities without letting an ampersand re-form one", () => {
    const text = docxToText(doc("<w:p><w:t>Rock &amp;lt;tag&amp;gt; roll</w:t></w:p>"));

    expect(text).toBe("Rock &lt;tag&gt; roll");
  });

  it("reports nothing for an archive with no document body", () => {
    expect(docxToText(zipWith("word/styles.xml", "<styles/>"))).toBeNull();
  });

  it("reports nothing rather than throwing on bytes that are not a zip", () => {
    expect(docxToText(Buffer.from("not a zip at all"))).toBeNull();
  });
});

describe("the zip reader", () => {
  it("finds the entry it was asked for", () => {
    expect(readZipEntry(zipWith("a/b.txt", "payload"), "a/b.txt")!.toString()).toBe("payload");
  });

  it("returns nothing for an entry that is not there", () => {
    expect(readZipEntry(zipWith("a/b.txt", "payload"), "word/document.xml")).toBeNull();
  });
});
