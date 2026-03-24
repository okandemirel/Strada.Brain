/**
 * Documentation Chunker
 *
 * Chunks framework documentation (markdown, XML doc comments, C# examples)
 * into FrameworkDocChunk objects for embedding and retrieval.
 */

import { createHash } from "node:crypto";
import type { FilePath, TimestampMs } from "../../types/index.js";
import type { DocChunkKind } from "../rag.interface.js";
import type { FrameworkDocChunk, DocSourceType, PackageRoot } from "./doc-rag.interface.js";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

function chunkId(pkg: string, version: string, filePath: string, index: number): string {
  return createHash("sha256")
    .update(`${pkg}:${version}:${filePath}:${index}`)
    .digest("hex")
    .substring(0, 16);
}

function docSourceToChunkKind(docSource: DocSourceType): DocChunkKind {
  switch (docSource) {
    case "framework_readme":
    case "project_readme":
      return "readme";
    case "framework_changelog":
      return "changelog";
    default:
      return "markdown";
  }
}

/**
 * Chunk a markdown file by heading boundaries.
 * Each heading-delimited section becomes one chunk.
 */
export function chunkMarkdown(
  content: string,
  filePath: string,
  pkg: PackageRoot,
  docSource: DocSourceType,
  maxChunkChars: number = 2000,
): FrameworkDocChunk[] {
  const chunks: FrameworkDocChunk[] = [];
  const lines = content.split("\n");
  const now = Date.now() as TimestampMs;

  let currentTitle = "";
  let currentHierarchy: string[] = [];
  let currentContent: string[] = [];
  let sectionIndex = 0;

  const pushChunk = (text: string): void => {
    chunks.push({
      id: chunkId(pkg.name, pkg.version, filePath, sectionIndex),
      content: text,
      contentHash: hashContent(text),
      filePath: filePath as FilePath,
      indexedAt: now,
      kind: docSourceToChunkKind(docSource),
      title: currentTitle || undefined,
      section: currentHierarchy.length > 1 ? currentHierarchy[currentHierarchy.length - 2] : undefined,
      hierarchy: currentHierarchy.length > 0 ? [...currentHierarchy] : undefined,
      packageName: pkg.name,
      packageVersion: pkg.version,
      docSource,
    });
    sectionIndex++;
  };

  const flush = (): void => {
    const text = currentContent.join("\n").trim();
    if (text.length === 0) return;

    // Split large sections by paragraph boundaries
    if (text.length > maxChunkChars) {
      const paragraphs = text.split(/\n\n+/);
      let buffer = "";
      for (const para of paragraphs) {
        if (buffer.length + para.length > maxChunkChars && buffer.length > 0) {
          pushChunk(buffer.trim());
          buffer = para;
        } else {
          buffer += (buffer ? "\n\n" : "") + para;
        }
      }
      if (buffer.trim()) pushChunk(buffer.trim());
    } else {
      pushChunk(text);
    }
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,4})\s+(.+)/.exec(line);
    if (headingMatch) {
      flush();
      currentContent = [];
      currentTitle = headingMatch[2]!.trim();
      const level = headingMatch[1]!.length;
      currentHierarchy = currentHierarchy.slice(0, level - 1);
      currentHierarchy.push(currentTitle);
    } else {
      currentContent.push(line);
    }
  }
  flush();

  return chunks;
}

/**
 * Extract XML documentation comments from a C# file.
 * Returns chunks for each `/// <summary>...</summary>` block.
 */
export function chunkXmlDocs(
  content: string,
  filePath: string,
  pkg: PackageRoot,
): FrameworkDocChunk[] {
  const chunks: FrameworkDocChunk[] = [];
  const now = Date.now() as TimestampMs;
  const lines = content.split("\n");

  let docLines: string[] = [];
  let sectionIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.startsWith("///")) {
      docLines.push(line.replace(/^\/\/\/\s?/, ""));
    } else if (docLines.length > 0) {
      // Find the declaration following the doc comment
      const declMatch = /(?:public|protected|internal)\s+(?:abstract\s+|static\s+|virtual\s+|override\s+|async\s+)*(?:class|struct|interface|enum|void|[\w<>\[\],\s]+)\s+(\w+)/.exec(line);
      const symbolName = declMatch?.[1] ?? "unknown";

      const docText = docLines
        .join("\n")
        .replace(/<\/?summary>/g, "")
        .replace(/<param name="(\w+)">/g, "- **$1**: ")
        .replace(/<\/param>/g, "")
        .replace(/<returns>/g, "**Returns**: ")
        .replace(/<\/returns>/g, "")
        .replace(/<\/?remarks>/g, "")
        .replace(/<see cref="([^"]+)"[^/]*\/>/g, "`$1`")
        .trim();

      if (docText.length > 10) {
        chunks.push({
          id: chunkId(pkg.name, pkg.version, filePath, sectionIndex),
          content: `${symbolName}: ${docText}`,
          contentHash: hashContent(docText),
          filePath: filePath as FilePath,
          indexedAt: now,
          kind: "xml_doc",
          title: symbolName,
          hierarchy: [symbolName],
          packageName: pkg.name,
          packageVersion: pkg.version,
          docSource: "xml_doc_comment",
        });
        sectionIndex++;
      }
      docLines = [];
    }
  }

  return chunks;
}

/**
 * Chunk C# test/example files as usage patterns.
 * Small files become a single chunk; larger files split per test method.
 */
export function chunkCSharpExample(
  content: string,
  filePath: string,
  pkg: PackageRoot,
  maxChunkChars: number = 2000,
): FrameworkDocChunk[] {
  const now = Date.now() as TimestampMs;
  const fileName = filePath.split("/").pop()?.replace(".cs", "") ?? "example";

  if (content.length <= maxChunkChars) {
    return [{
      id: chunkId(pkg.name, pkg.version, filePath, 0),
      content,
      contentHash: hashContent(content),
      filePath: filePath as FilePath,
      indexedAt: now,
      kind: "api_doc",
      title: fileName,
      packageName: pkg.name,
      packageVersion: pkg.version,
      docSource: "framework_example",
    }];
  }

  // Split by test methods
  const chunks: FrameworkDocChunk[] = [];
  const testMethodRe = /\[(Test|TestCase|UnityTest)[^\]]*\]\s*\n\s*public\s+/g;
  const lines = content.split("\n");
  let index = 0;

  const starts: number[] = [];
  let match;
  while ((match = testMethodRe.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split("\n").length - 1;
    starts.push(lineNum);
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : lines.length;
    const text = lines.slice(start, end).join("\n").trim();

    if (text.length > 0) {
      const methodMatch = /(?:void|async\s+\w+)\s+(\w+)\s*\(/.exec(text);
      chunks.push({
        id: chunkId(pkg.name, pkg.version, filePath, index),
        content: text,
        contentHash: hashContent(text),
        filePath: filePath as FilePath,
        indexedAt: now,
        kind: "api_doc",
        title: methodMatch?.[1] ?? `test_${index}`,
        packageName: pkg.name,
        packageVersion: pkg.version,
        docSource: "framework_example",
      });
      index++;
    }
  }

  // If no test methods found, use full content as single chunk
  if (chunks.length === 0) {
    chunks.push({
      id: chunkId(pkg.name, pkg.version, filePath, 0),
      content: content.substring(0, maxChunkChars),
      contentHash: hashContent(content),
      filePath: filePath as FilePath,
      indexedAt: now,
      kind: "api_doc",
      title: fileName,
      packageName: pkg.name,
      packageVersion: pkg.version,
      docSource: "framework_example",
    });
  }

  return chunks;
}
