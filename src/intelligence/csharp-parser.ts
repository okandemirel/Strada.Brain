/**
 * Regex-based C# code parser.
 * Extracts structural information from C# files without requiring a full AST parser.
 * This is the MVP approach - Phase 3 will add tree-sitter for deeper analysis.
 */

const MAX_PARSE_FILE_SIZE = 1024 * 1024; // 1MB max per file

/** Maps an offset to its 1-based line number. */
type LineNumberAt = (offset: number) => number;

/**
 * Line lookup for one file: the line-start offsets are found once, and each
 * lookup is a binary search. Counting newlines from offset 0 for every match
 * made a large generated file quadratic (tens of seconds under the size cap).
 */
function lineIndex(content: string): LineNumberAt {
  const starts = [0];
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Parse space-separated modifiers from a regex capture group. */
function parseModifiers(raw: string | undefined): string[] {
  const trimmed = (raw ?? "").trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

/** Strip generic type arguments, e.g. "List<int>" → "List". */
export function stripGenericArgs(typeName: string): string {
  return typeName.replace(/<[^>]+>/g, "");
}

export interface ParsedClass {
  name: string;
  namespace: string;
  baseClass?: string;
  interfaces: string[];
  genericArgs: string[];
  isAbstract: boolean;
  isPartial: boolean;
  isStatic: boolean;
  modifiers: string[];
  filePath: string;
  lineNumber: number;
}

export interface ParsedStruct {
  name: string;
  namespace: string;
  interfaces: string[];
  isReadonly: boolean;
  filePath: string;
  lineNumber: number;
}

export interface ParsedMethod {
  name: string;
  returnType: string;
  parameters: string[];
  modifiers: string[];
  lineNumber: number;
}

export interface ParsedField {
  name: string;
  type: string;
  modifiers: string[];
  isProperty: boolean;
  hasGetter: boolean;
  hasSetter: boolean;
  lineNumber: number;
}

export interface ParsedAttribute {
  name: string;
  arguments: string;
  lineNumber: number;
}

export interface ParsedConstructor {
  className: string;
  parameters: string[];
  dependencies: string[];
  lineNumber: number;
}

export interface ParsedUsing {
  namespace: string;
}

export interface CSharpFileInfo {
  filePath: string;
  namespace: string;
  usings: ParsedUsing[];
  classes: ParsedClass[];
  structs: ParsedStruct[];
  methods: ParsedMethod[];
  fields: ParsedField[];
  attributes: ParsedAttribute[];
  constructors: ParsedConstructor[];
}

/**
 * Parse a C# file and extract structural information.
 * Rejects files over 1MB to prevent ReDoS on large inputs.
 */
export function parseCSharpFile(
  content: string,
  filePath: string
): CSharpFileInfo {
  if (content.length > MAX_PARSE_FILE_SIZE) {
    return {
      filePath,
      namespace: "",
      usings: [],
      classes: [],
      structs: [],
      methods: [],
      fields: [],
      attributes: [],
      constructors: [],
    };
  }

  const lineAt = lineIndex(content);
  const usings = extractUsings(content);
  const namespace = extractNamespace(content);
  const classes = extractClasses(content, filePath, namespace, lineAt);
  const structs = extractStructs(content, filePath, namespace, lineAt);
  const methods = extractMethods(content, lineAt);
  const fields = extractFields(content, lineAt);
  const attributes = extractAttributes(content, lineAt);
  const constructors = extractConstructors(content, classes, lineAt);

  return {
    filePath,
    namespace,
    usings,
    classes,
    structs,
    methods,
    fields,
    attributes,
    constructors,
  };
}

function extractUsings(content: string): ParsedUsing[] {
  const results: ParsedUsing[] = [];
  const regex = /^[ \t]*using\s+([\w.]+)\s*;/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    results.push({ namespace: match[1]! });
  }
  return results;
}

function extractNamespace(content: string): string {
  // Match both block and file-scoped namespace
  const blockMatch = content.match(/^[ \t]*namespace\s+([\w.]+)\s*\{/m);
  if (blockMatch) return blockMatch[1]!;

  const fileScopedMatch = content.match(/^[ \t]*namespace\s+([\w.]+)\s*;/m);
  if (fileScopedMatch) return fileScopedMatch[1]!;

  return "";
}

function extractClasses(
  content: string,
  filePath: string,
  namespace: string,
  lineAt: LineNumberAt,
): ParsedClass[] {
  const results: ParsedClass[] = [];

  // Match class declarations with various modifiers
  const classRegex =
    /^([ \t]*)((?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*class\s+(\w+)(?:<([^>]{1,200})>)?(?:\s*:\s*(.+?))?(?:\s*where\b|\s*\{)/gm;

  let match;
  while ((match = classRegex.exec(content)) !== null) {
    const modifiers = parseModifiers(match[2]);
    const name = match[3]!;
    const genericArgs = match[4] ? match[4].split(",").map((s) => s.trim()) : [];
    const inheritance = match[5] ? match[5].split(",").map((s) => s.trim()) : [];

    // First item is usually base class (if not an interface starting with I)
    let baseClass: string | undefined;
    const interfaces: string[] = [];

    for (const item of inheritance) {
      const cleanItem = stripGenericArgs(item).trim();
      if (!baseClass && !cleanItem.startsWith("I") && cleanItem[0] === cleanItem[0]!.toUpperCase()) {
        baseClass = item;
      } else {
        interfaces.push(item);
      }
    }

    const lineNumber = lineAt(match.index);

    results.push({
      name,
      namespace,
      baseClass,
      interfaces,
      genericArgs,
      isAbstract: modifiers.includes("abstract"),
      isPartial: modifiers.includes("partial"),
      isStatic: modifiers.includes("static"),
      modifiers,
      filePath,
      lineNumber,
    });
  }

  return results;
}

function extractStructs(
  content: string,
  filePath: string,
  namespace: string,
  lineAt: LineNumberAt,
): ParsedStruct[] {
  const results: ParsedStruct[] = [];

  const structRegex =
    /^([ \t]*)((?:public|private|protected|internal|readonly)\s+)*struct\s+(\w+)(?:\s*:\s*(.+?))?(?:\s*where\b|\s*\{)/gm;

  let match;
  while ((match = structRegex.exec(content)) !== null) {
    const modifierStr = (match[2] ?? "").trim();
    const name = match[3]!;
    const interfaces = match[4]
      ? match[4].split(",").map((s) => s.trim())
      : [];

    const lineNumber = lineAt(match.index);

    results.push({
      name,
      namespace,
      interfaces,
      isReadonly: modifierStr.includes("readonly"),
      filePath,
      lineNumber,
    });
  }

  return results;
}

// Bracketed spans below ([^>], [^)], [^}]) may cross lines, so each is capped:
// an unclosed bracket used to be scanned to the end of the file from every
// line that opened one, which made malformed input quadratic.

function extractMethods(content: string, lineAt: LineNumberAt): ParsedMethod[] {
  const results: ParsedMethod[] = [];

  // Match method declarations (simplified)
  const methodRegex =
    /^[ \t]*((?:public|private|protected|internal|static|virtual|override|abstract|async|sealed)\s+)*(\w+(?:<[^>]{1,200}>)?)\s+(\w+)\s*\(([^)]{0,1000})\)/gm;

  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    const modifiers = parseModifiers(match[1]);
    const returnType = match[2]!;
    const name = match[3]!;
    const paramStr = match[4]!.trim();
    const parameters = paramStr ? paramStr.split(",").map((s) => s.trim()) : [];

    // Skip constructors and known keywords
    if (["if", "while", "for", "foreach", "switch", "catch", "using", "lock"].includes(name)) {
      continue;
    }

    const lineNumber = lineAt(match.index);

    results.push({
      name,
      returnType,
      parameters,
      modifiers,
      lineNumber,
    });
  }

  return results;
}

function extractFields(content: string, lineAt: LineNumberAt): ParsedField[] {
  const results: ParsedField[] = [];

  // Match fields: modifiers type name, then "=" or ";". The initializer is not
  // consumed: scanning it to the next ";" crossed lines, and a line with no
  // ";" after it was scanned to the end of the file from every line start.
  const fieldRegex =
    /^[ \t]*((?:public|private|protected|internal|static|readonly|const|volatile)\s+)+(\w+(?:<[^>]{1,200}>)?(?:\[\])?(?:\??)?)\s+(\w+)\s*(?=[=;])/gm;

  let match;
  while ((match = fieldRegex.exec(content)) !== null) {
    const modifiers = parseModifiers(match[1]);
    const type = match[2]!;
    const name = match[3]!;

    // Skip known non-field patterns
    if (["return", "throw", "yield", "var", "new"].includes(type)) continue;

    const lineNumber = lineAt(match.index);

    results.push({
      name,
      type,
      modifiers,
      isProperty: false,
      hasGetter: false,
      hasSetter: false,
      lineNumber,
    });
  }

  // Match properties: modifiers type Name { get; set; }
  const propRegex =
    /^[ \t]*((?:public|private|protected|internal|static|virtual|override|abstract)\s+)+(\w+(?:<[^>]{1,200}>)?(?:\[\])?(?:\??)?)\s+(\w+)\s*\{([^}]{0,1000})\}/gm;

  while ((match = propRegex.exec(content)) !== null) {
    const modifiers = parseModifiers(match[1]);
    const type = match[2]!;
    const name = match[3]!;
    const body = match[4] ?? "";

    // Skip known non-property patterns
    if (["if", "while", "for", "foreach", "switch"].includes(name)) continue;
    if (name[0] !== name[0]!.toUpperCase()) continue; // Properties are PascalCase

    const lineNumber = lineAt(match.index);

    results.push({
      name,
      type,
      modifiers,
      isProperty: true,
      hasGetter: /get\s*[;{]/.test(body),
      hasSetter: /set\s*[;{]/.test(body) || /init\s*[;{]/.test(body),
      lineNumber,
    });
  }

  return results;
}

function extractAttributes(content: string, lineAt: LineNumberAt): ParsedAttribute[] {
  const results: ParsedAttribute[] = [];

  const attrRegex = /^[ \t]*\[(\w+)(?:\(([^)]{0,1000})\))?\]/gm;

  let match;
  while ((match = attrRegex.exec(content)) !== null) {
    const name = match[1]!;
    const args = match[2] ?? "";

    // Skip well-known non-attribute brackets like array indices
    if (["0", "1", "2", "i", "j", "k", "index"].includes(name)) continue;

    const lineNumber = lineAt(match.index);

    results.push({ name, arguments: args, lineNumber });
  }

  return results;
}

function extractConstructors(
  content: string,
  classes: ParsedClass[],
  lineAt: LineNumberAt,
): ParsedConstructor[] {
  const results: ParsedConstructor[] = [];
  const classNames = new Set(classes.map((c) => c.name));

  // Match constructors: modifiers ClassName(params)
  const ctorRegex =
    /^[ \t]*(?:public|private|protected|internal)\s+(\w+)\s*\(([^)]{0,1000})\)/gm;

  let match;
  while ((match = ctorRegex.exec(content)) !== null) {
    const name = match[1]!;
    const paramStr = match[2]!.trim();

    // Only match known class names (to avoid false positives with methods)
    if (!classNames.has(name)) continue;

    const parameters = paramStr ? paramStr.split(",").map((s) => s.trim()) : [];

    // Extract dependency types (interface-prefixed parameters = DI dependencies)
    const dependencies: string[] = [];
    for (const param of parameters) {
      const parts = param.split(/\s+/);
      if (parts.length >= 2) {
        const typeName = parts[0]!;
        if (typeName.startsWith("I") && typeName[1] === typeName[1]!.toUpperCase()) {
          dependencies.push(typeName);
        }
      }
    }

    const lineNumber = lineAt(match.index);

    results.push({
      className: name,
      parameters,
      dependencies,
      lineNumber,
    });
  }

  return results;
}

/**
 * Check if a class inherits from a specific base class (by name).
 */
export function inheritsFrom(cls: ParsedClass, baseName: string): boolean {
  if (!cls.baseClass) return false;
  return stripGenericArgs(cls.baseClass) === baseName;
}

/**
 * Check if a struct/class implements a specific interface.
 */
export function implementsInterface(
  item: { interfaces: string[] },
  interfaceName: string
): boolean {
  return item.interfaces.some((iface) => stripGenericArgs(iface) === interfaceName);
}
