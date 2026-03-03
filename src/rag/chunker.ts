/**
 * C# source file chunker for RAG indexing.
 * Splits C# files into semantically meaningful chunks using the structural
 * metadata produced by the regex-based csharp-parser.
 */

import { parseCSharpFile, type CSharpFileInfo, type ParsedClass } from "../intelligence/csharp-parser.js";
import { createHash } from "node:crypto";
import type { CodeChunk } from "./rag.interface.js";

export const MAX_CHUNK_CHARS = 1500;
export const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Compute a 16-char hex SHA-256 digest of arbitrary content. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

/** Compute the canonical chunk ID from file path + line range. */
function computeChunkId(filePath: string, startLine: number, endLine: number): string {
  return createHash("sha256")
    .update(`${filePath}:${startLine}:${endLine}`)
    .digest("hex")
    .substring(0, 16);
}

// ---------------------------------------------------------------------------
// Brace-range finder
// ---------------------------------------------------------------------------

/**
 * Given the full file content and a 1-based declaration line number, scan
 * forward to find the matching closing brace of the block body.
 *
 * Returns `{ startLine, endLine }` (both 1-based, inclusive) or `null` when:
 *  - No opening `{` is found before the next top-level declaration / EOF
 *  - The declaration is semicolon-terminated (e.g. an abstract method or
 *    auto-property: `public abstract void Foo();`)
 */
export function findBraceRange(
  content: string,
  declarationLine: number
): { startLine: number; endLine: number } | null {
  const lines = content.split("\n");

  // Convert to 0-based for array access
  const startIdx = declarationLine - 1;

  // Walk character-by-character through the content starting at the
  // declaration line, respecting string / comment context so that braces
  // inside literals are not counted.
  let charPos = 0;
  for (let l = 0; l < startIdx; l++) {
    charPos += (lines[l]?.length ?? 0) + 1; // +1 for the '\n'
  }

  let depth = 0;
  let openBraceFound = false;
  let openBraceLine = -1;

  // State machine
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let inChar = false;
  let inVerbatimString = false;

  const len = content.length;
  let i = charPos;
  let currentLine = declarationLine;

  while (i < len) {
    const ch = content[i]!;
    const next = i + 1 < len ? content[i + 1]! : "";

    // Track line numbers
    if (ch === "\n") {
      currentLine++;
      inLineComment = false;
      i++;
      continue;
    }

    // --- Comment entry / exit ---
    if (!inString && !inChar && !inVerbatimString && !inBlockComment && !inLineComment) {
      if (ch === "/" && next === "/") {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inLineComment) {
      i++;
      continue;
    }

    // --- Verbatim string (@"...") ---
    if (!inString && !inChar && !inVerbatimString && ch === "@" && next === '"') {
      inVerbatimString = true;
      i += 2;
      continue;
    }

    if (inVerbatimString) {
      if (ch === '"') {
        if (next === '"') {
          // Escaped quote inside verbatim string
          i += 2;
          continue;
        }
        inVerbatimString = false;
      }
      i++;
      continue;
    }

    // --- Regular string ---
    if (!inChar && !inString && ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        i += 2; // skip escape sequence
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    // --- Char literal ---
    if (!inChar && !inString && ch === "'") {
      inChar = true;
      i++;
      continue;
    }

    if (inChar) {
      if (ch === "\\") {
        i += 2; // skip escape
        continue;
      }
      if (ch === "'") {
        inChar = false;
      }
      i++;
      continue;
    }

    // --- Brace counting ---
    if (ch === "{") {
      if (!openBraceFound) {
        openBraceFound = true;
        openBraceLine = currentLine;
      }
      depth++;
      i++;
      continue;
    }

    if (ch === "}") {
      if (!openBraceFound) {
        // Hit a closing brace before ever seeing an opening brace –
        // this declaration has no body (e.g. we walked into the parent's close).
        return null;
      }
      depth--;
      if (depth === 0) {
        return { startLine: openBraceLine, endLine: currentLine };
      }
      i++;
      continue;
    }

    // --- Semicolon before first brace → abstract / extern / auto-prop stub ---
    if (ch === ";" && !openBraceFound) {
      return null;
    }

    i++;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Line utilities
// ---------------------------------------------------------------------------

/** Return the text of lines [startLine, endLine] (both 1-based, inclusive). */
function extractLines(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

// ---------------------------------------------------------------------------
// Context header
// ---------------------------------------------------------------------------

function buildContextHeader(filePath: string, cls: ParsedClass): string {
  const inheritance = cls.baseClass
    ? ` : ${cls.baseClass}`
    : cls.interfaces.length > 0
    ? ` : ${cls.interfaces.join(", ")}`
    : "";
  return `// File: ${filePath}\n// Class: ${cls.name}${inheritance}\n`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Split a C# source file into semantically meaningful chunks for RAG
 * embedding. Returns an empty array for files larger than MAX_FILE_SIZE.
 */
export function chunkCSharpFile(filePath: string, content: string): CodeChunk[] {
  if (content.length > MAX_FILE_SIZE) {
    return [];
  }

  if (content.trim().length === 0) {
    return [];
  }

  const fileInfo: CSharpFileInfo = parseCSharpFile(content, filePath);
  const lines = content.split("\n");
  const now = Date.now();
  const chunks: CodeChunk[] = [];

  // Collect the earliest line at which a class or struct body begins so we
  // know where the "file header" ends.
  const typeDeclarationLines: number[] = [
    ...fileInfo.classes.map((c) => c.lineNumber),
    ...fileInfo.structs.map((s) => s.lineNumber),
  ];
  const firstTypeDeclarationLine =
    typeDeclarationLines.length > 0 ? Math.min(...typeDeclarationLines) : lines.length + 1;

  // -------------------------------------------------------------------------
  // 1. File header chunk
  // -------------------------------------------------------------------------
  const headerEndLine = Math.max(firstTypeDeclarationLine - 1, 1);
  const headerContent = extractLines(lines, 1, headerEndLine).trimEnd();

  if (headerContent.trim().length > 0) {
    chunks.push({
      id: computeChunkId(filePath, 1, headerEndLine),
      filePath,
      content: headerContent,
      startLine: 1,
      endLine: headerEndLine,
      kind: "file_header",
      namespace: fileInfo.namespace || undefined,
      contentHash: computeContentHash(headerContent),
      indexedAt: now,
      language: "csharp",
    });
  }

  // -------------------------------------------------------------------------
  // 2. Struct chunks (always a single chunk per struct – ECS structs are small)
  // -------------------------------------------------------------------------
  for (const struct of fileInfo.structs) {
    const range = findBraceRange(content, struct.lineNumber);
    if (!range) continue;

    const structContent = extractLines(lines, struct.lineNumber, range.endLine);

    chunks.push({
      id: computeChunkId(filePath, struct.lineNumber, range.endLine),
      filePath,
      content: structContent,
      startLine: struct.lineNumber,
      endLine: range.endLine,
      kind: "struct",
      symbol: struct.name,
      namespace: struct.namespace || undefined,
      contentHash: computeContentHash(structContent),
      indexedAt: now,
      language: "csharp",
    });
  }

  // -------------------------------------------------------------------------
  // 3. Class chunks
  // -------------------------------------------------------------------------
  for (const cls of fileInfo.classes) {
    const classRange = findBraceRange(content, cls.lineNumber);
    if (!classRange) continue;

    const classContent = extractLines(lines, cls.lineNumber, classRange.endLine);

    // If the entire class body fits within the limit, emit a single class chunk.
    if (classContent.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        id: computeChunkId(filePath, cls.lineNumber, classRange.endLine),
        filePath,
        content: classContent,
        startLine: cls.lineNumber,
        endLine: classRange.endLine,
        kind: "class",
        symbol: cls.name,
        namespace: cls.namespace || undefined,
        contentHash: computeContentHash(classContent),
        indexedAt: now,
        language: "csharp",
      });
      continue;
    }

    // Large class → emit individual method / constructor chunks.
    const contextHeader = buildContextHeader(filePath, cls);

    // Gather methods and constructors that belong to this class.
    // "Belong" means: their lineNumber falls within [cls.lineNumber, classRange.endLine].
    const classMethods = fileInfo.methods.filter(
      (m) => m.lineNumber >= cls.lineNumber && m.lineNumber <= classRange.endLine
    );
    const classConstructors = fileInfo.constructors.filter(
      (c) =>
        c.className === cls.name &&
        c.lineNumber >= cls.lineNumber &&
        c.lineNumber <= classRange.endLine
    );

    // Build method chunks
    for (const method of classMethods) {
      const methodRange = findBraceRange(content, method.lineNumber);
      if (!methodRange) continue;

      const methodBody = extractLines(lines, method.lineNumber, methodRange.endLine);
      const methodContent = contextHeader + methodBody;

      chunks.push({
        id: computeChunkId(filePath, method.lineNumber, methodRange.endLine),
        filePath,
        content: methodContent,
        startLine: method.lineNumber,
        endLine: methodRange.endLine,
        kind: "method",
        parentSymbol: cls.name,
        symbol: method.name,
        namespace: cls.namespace || undefined,
        contentHash: computeContentHash(methodContent),
        indexedAt: now,
        language: "csharp",
      });
    }

    // Build constructor chunks
    for (const ctor of classConstructors) {
      const ctorRange = findBraceRange(content, ctor.lineNumber);
      if (!ctorRange) continue;

      const ctorBody = extractLines(lines, ctor.lineNumber, ctorRange.endLine);
      const ctorContent = contextHeader + ctorBody;

      chunks.push({
        id: computeChunkId(filePath, ctor.lineNumber, ctorRange.endLine),
        filePath,
        content: ctorContent,
        startLine: ctor.lineNumber,
        endLine: ctorRange.endLine,
        kind: "constructor",
        parentSymbol: cls.name,
        symbol: ctor.className,
        namespace: cls.namespace || undefined,
        contentHash: computeContentHash(ctorContent),
        indexedAt: now,
        language: "csharp",
      });
    }
  }

  return chunks;
}
