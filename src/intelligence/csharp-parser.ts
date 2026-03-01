/**
 * Regex-based C# code parser.
 * Extracts structural information from C# files without requiring a full AST parser.
 * This is the MVP approach - Phase 3 will add tree-sitter for deeper analysis.
 */

const MAX_PARSE_FILE_SIZE = 1024 * 1024; // 1MB max per file

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
    };
  }

  const usings = extractUsings(content);
  const namespace = extractNamespace(content);
  const classes = extractClasses(content, filePath, namespace);
  const structs = extractStructs(content, filePath, namespace);
  const methods = extractMethods(content);

  return {
    filePath,
    namespace,
    usings,
    classes,
    structs,
    methods,
  };
}

function extractUsings(content: string): ParsedUsing[] {
  const results: ParsedUsing[] = [];
  const regex = /^\s*using\s+([\w.]+)\s*;/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    results.push({ namespace: match[1]! });
  }
  return results;
}

function extractNamespace(content: string): string {
  // Match both block and file-scoped namespace
  const blockMatch = content.match(/^\s*namespace\s+([\w.]+)\s*\{/m);
  if (blockMatch) return blockMatch[1]!;

  const fileScopedMatch = content.match(/^\s*namespace\s+([\w.]+)\s*;/m);
  if (fileScopedMatch) return fileScopedMatch[1]!;

  return "";
}

function extractClasses(
  content: string,
  filePath: string,
  namespace: string
): ParsedClass[] {
  const results: ParsedClass[] = [];

  // Match class declarations with various modifiers
  const classRegex =
    /^(\s*)((?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*class\s+(\w+)(?:<([^>]+)>)?(?:\s*:\s*(.+?))?(?:\s*where\b|\s*\{)/gm;

  let match;
  while ((match = classRegex.exec(content)) !== null) {
    const modifierStr = (match[2] ?? "").trim();
    const modifiers = modifierStr ? modifierStr.split(/\s+/) : [];
    const name = match[3]!;
    const genericArgs = match[4] ? match[4].split(",").map((s) => s.trim()) : [];
    const inheritance = match[5] ? match[5].split(",").map((s) => s.trim()) : [];

    // First item is usually base class (if not an interface starting with I)
    let baseClass: string | undefined;
    const interfaces: string[] = [];

    for (const item of inheritance) {
      const cleanItem = item.replace(/<[^>]+>/g, "").trim();
      if (!baseClass && !cleanItem.startsWith("I") && cleanItem[0] === cleanItem[0]!.toUpperCase()) {
        baseClass = item;
      } else {
        interfaces.push(item);
      }
    }

    // Calculate line number
    const beforeMatch = content.substring(0, match.index);
    const lineNumber = beforeMatch.split("\n").length;

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
  namespace: string
): ParsedStruct[] {
  const results: ParsedStruct[] = [];

  const structRegex =
    /^(\s*)((?:public|private|protected|internal|readonly)\s+)*struct\s+(\w+)(?:\s*:\s*(.+?))?(?:\s*where\b|\s*\{)/gm;

  let match;
  while ((match = structRegex.exec(content)) !== null) {
    const modifierStr = (match[2] ?? "").trim();
    const name = match[3]!;
    const interfaces = match[4]
      ? match[4].split(",").map((s) => s.trim())
      : [];

    const beforeMatch = content.substring(0, match.index);
    const lineNumber = beforeMatch.split("\n").length;

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

function extractMethods(content: string): ParsedMethod[] {
  const results: ParsedMethod[] = [];

  // Match method declarations (simplified)
  const methodRegex =
    /^\s*((?:public|private|protected|internal|static|virtual|override|abstract|async|sealed)\s+)*(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/gm;

  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    const modifierStr = (match[1] ?? "").trim();
    const modifiers = modifierStr ? modifierStr.split(/\s+/) : [];
    const returnType = match[2]!;
    const name = match[3]!;
    const paramStr = match[4]!.trim();
    const parameters = paramStr ? paramStr.split(",").map((s) => s.trim()) : [];

    // Skip constructors and known keywords
    if (["if", "while", "for", "foreach", "switch", "catch", "using", "lock"].includes(name)) {
      continue;
    }

    const beforeMatch = content.substring(0, match.index);
    const lineNumber = beforeMatch.split("\n").length;

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

/**
 * Check if a class inherits from a specific base class (by name).
 */
export function inheritsFrom(cls: ParsedClass, baseName: string): boolean {
  if (!cls.baseClass) return false;
  // Handle generic base classes like EntityMediator<TView>
  const cleanBase = cls.baseClass.replace(/<[^>]+>/g, "");
  return cleanBase === baseName;
}

/**
 * Check if a struct/class implements a specific interface.
 */
export function implementsInterface(
  item: { interfaces: string[] },
  interfaceName: string
): boolean {
  return item.interfaces.some((iface) => {
    const clean = iface.replace(/<[^>]+>/g, "");
    return clean === interfaceName;
  });
}
