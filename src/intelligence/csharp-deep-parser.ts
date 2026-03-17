/**
 * Deep C# parser using a tokenizer + recursive descent approach.
 *
 * Replaces the regex-based parser (csharp-parser.ts) with a proper lexer/parser
 * that handles nested generics, scope tracking, nested types, and produces
 * a richer AST for code intelligence.
 */

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// ═══════════════════════════════════════════
// Token types
// ═══════════════════════════════════════════

type TokenKind =
  | "keyword"
  | "identifier"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "lt"
  | "gt"
  | "semicolon"
  | "colon"
  | "comma"
  | "dot"
  | "equals"
  | "arrow"    // =>
  | "question"
  | "string"
  | "number"
  | "operator"
  | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
}

// ═══════════════════════════════════════════
// AST node types
// ═══════════════════════════════════════════

export interface ASTNode {
  kind: string;
  line: number;
}

export interface UsingDirective extends ASTNode {
  kind: "using";
  namespace: string;
  alias?: string;
  isStatic: boolean;
}

export interface NamespaceDecl extends ASTNode {
  kind: "namespace";
  name: string;
  isFileScoped: boolean;
  members: TypeDecl[];
}

export type TypeDecl = ClassDecl | StructDecl | InterfaceDecl | EnumDecl;

export interface ClassDecl extends ASTNode {
  kind: "class";
  name: string;
  modifiers: string[];
  genericParams: string[];
  baseTypes: string[];
  members: MemberDecl[];
  nestedTypes: TypeDecl[];
  attributes: AttributeDecl[];
}

export interface StructDecl extends ASTNode {
  kind: "struct";
  name: string;
  modifiers: string[];
  genericParams: string[];
  baseTypes: string[];
  members: MemberDecl[];
  nestedTypes: TypeDecl[];
  attributes: AttributeDecl[];
}

export interface InterfaceDecl extends ASTNode {
  kind: "interface";
  name: string;
  modifiers: string[];
  genericParams: string[];
  baseTypes: string[];
  members: MemberDecl[];
  attributes: AttributeDecl[];
}

export interface EnumDecl extends ASTNode {
  kind: "enum";
  name: string;
  modifiers: string[];
  values: string[];
  attributes: AttributeDecl[];
}

export type MemberDecl = MethodDecl | PropertyDecl | FieldDecl | ConstructorDecl | EventDecl;

export interface MethodDecl extends ASTNode {
  kind: "method";
  name: string;
  returnType: string;
  modifiers: string[];
  parameters: ParameterInfo[];
  bodyLineCount: number;
  attributes: AttributeDecl[];
}

export interface PropertyDecl extends ASTNode {
  kind: "property";
  name: string;
  type: string;
  modifiers: string[];
  hasGetter: boolean;
  hasSetter: boolean;
  attributes: AttributeDecl[];
}

export interface FieldDecl extends ASTNode {
  kind: "field";
  name: string;
  type: string;
  modifiers: string[];
  attributes: AttributeDecl[];
}

export interface ConstructorDecl extends ASTNode {
  kind: "constructor";
  className: string;
  modifiers: string[];
  parameters: ParameterInfo[];
  bodyLineCount: number;
  attributes: AttributeDecl[];
}

export interface EventDecl extends ASTNode {
  kind: "event";
  name: string;
  type: string;
  modifiers: string[];
}

export interface ParameterInfo {
  name: string;
  type: string;
  hasDefault: boolean;
}

export interface AttributeDecl extends ASTNode {
  kind: "attribute";
  name: string;
  arguments: string;
}

export interface CSharpAST {
  filePath: string;
  usings: UsingDirective[];
  namespaces: NamespaceDecl[];
  /** Top-level types (outside any namespace). */
  types: TypeDecl[];
}

// ═══════════════════════════════════════════
// C# keywords for classification
// ═══════════════════════════════════════════

const CS_KEYWORDS = new Set([
  "abstract", "as", "base", "bool", "break", "byte", "case", "catch",
  "char", "checked", "class", "const", "continue", "decimal", "default",
  "delegate", "do", "double", "else", "enum", "event", "explicit",
  "extern", "false", "finally", "fixed", "float", "for", "foreach",
  "goto", "if", "implicit", "in", "int", "interface", "internal", "is",
  "lock", "long", "namespace", "new", "null", "object", "operator",
  "out", "override", "params", "partial", "private", "protected",
  "public", "readonly", "ref", "return", "sbyte", "sealed", "short",
  "sizeof", "stackalloc", "static", "string", "struct", "switch",
  "this", "throw", "true", "try", "typeof", "uint", "ulong",
  "unchecked", "unsafe", "ushort", "using", "var", "virtual", "void",
  "volatile", "where", "while", "yield", "async", "await", "record",
]);

const BUILTIN_TYPES = new Set([
  "void", "int", "string", "bool", "float", "double", "byte", "char",
  "long", "short", "decimal", "object", "uint", "ulong", "ushort", "sbyte", "var",
]);

const MODIFIER_KEYWORDS = new Set([
  "public", "private", "protected", "internal", "static", "abstract",
  "sealed", "virtual", "override", "readonly", "const", "volatile",
  "extern", "async", "partial", "new", "unsafe",
]);

// ═══════════════════════════════════════════
// Tokenizer
// ═══════════════════════════════════════════

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  while (i < source.length) {
    const ch = source[i]!;

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      col++;
      continue;
    }
    if (ch === "\n") {
      i++;
      line++;
      col = 1;
      continue;
    }

    // Single-line comment
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      col += 2;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          col += 2;
          break;
        }
        if (source[i] === "\n") { line++; col = 1; } else { col++; }
        i++;
      }
      continue;
    }

    // String literals (basic: skip to avoid false keywords inside strings)
    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      // Handle verbatim string @""
      const isVerbatim = i >= 2 && source[i - 2] === "@";

      let str = '"';
      while (i < source.length) {
        const sc = source[i]!;
        if (sc === "\\") {
          // Escape: skip next char (unless verbatim)
          if (!isVerbatim) {
            str += sc + (source[i + 1] ?? "");
            i += 2;
            col += 2;
            continue;
          }
        }
        if (sc === '"') {
          if (isVerbatim && source[i + 1] === '"') {
            // Verbatim escaped quote
            str += '""';
            i += 2;
            col += 2;
            continue;
          }
          str += '"';
          i++;
          col++;
          break;
        }
        if (sc === "\n") { line++; col = 1; } else { col++; }
        str += sc;
        i++;
      }
      tokens.push({ kind: "string", value: str, line: startLine, col: startCol });
      continue;
    }

    // Character literal
    if (ch === "'") {
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      let str = "'";
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\") {
          str += source[i]! + (source[i + 1] ?? "");
          i += 2;
          col += 2;
          continue;
        }
        str += source[i];
        i++;
        col++;
      }
      if (i < source.length) { str += "'"; i++; col++; }
      tokens.push({ kind: "string", value: str, line: startLine, col: startCol });
      continue;
    }

    // Preprocessor directives: skip entire line
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    // Identifiers and keywords
    if (isIdentStart(ch)) {
      const startCol = col;
      let word = "";
      while (i < source.length && isIdentPart(source[i]!)) {
        word += source[i];
        i++;
        col++;
      }
      const kind = CS_KEYWORDS.has(word) ? "keyword" : "identifier";
      tokens.push({ kind, value: word, line, col: startCol });
      continue;
    }

    // Numbers
    if (isDigit(ch) || (ch === "." && i + 1 < source.length && isDigit(source[i + 1]!))) {
      const startCol = col;
      let num = "";
      while (i < source.length && (isDigit(source[i]!) || source[i] === "." || source[i] === "_" || /[xXbBoOuUlLfFdDmM]/.test(source[i]!))) {
        num += source[i];
        i++;
        col++;
      }
      tokens.push({ kind: "number", value: num, line, col: startCol });
      continue;
    }

    // Special characters
    const startCol = col;
    switch (ch) {
      case "{": tokens.push({ kind: "lbrace", value: ch, line, col: startCol }); i++; col++; continue;
      case "}": tokens.push({ kind: "rbrace", value: ch, line, col: startCol }); i++; col++; continue;
      case "(": tokens.push({ kind: "lparen", value: ch, line, col: startCol }); i++; col++; continue;
      case ")": tokens.push({ kind: "rparen", value: ch, line, col: startCol }); i++; col++; continue;
      case "[": tokens.push({ kind: "lbracket", value: ch, line, col: startCol }); i++; col++; continue;
      case "]": tokens.push({ kind: "rbracket", value: ch, line, col: startCol }); i++; col++; continue;
      case "<": tokens.push({ kind: "lt", value: ch, line, col: startCol }); i++; col++; continue;
      case ">": tokens.push({ kind: "gt", value: ch, line, col: startCol }); i++; col++; continue;
      case ";": tokens.push({ kind: "semicolon", value: ch, line, col: startCol }); i++; col++; continue;
      case ":": tokens.push({ kind: "colon", value: ch, line, col: startCol }); i++; col++; continue;
      case ",": tokens.push({ kind: "comma", value: ch, line, col: startCol }); i++; col++; continue;
      case ".": tokens.push({ kind: "dot", value: ch, line, col: startCol }); i++; col++; continue;
      case "?": tokens.push({ kind: "question", value: ch, line, col: startCol }); i++; col++; continue;
      case "=":
        if (source[i + 1] === ">") {
          tokens.push({ kind: "arrow", value: "=>", line, col: startCol });
          i += 2; col += 2;
        } else {
          tokens.push({ kind: "equals", value: ch, line, col: startCol });
          i++; col++;
        }
        continue;
    }

    // Skip other operators (+, -, *, /, etc.)
    tokens.push({ kind: "operator", value: ch, line, col: startCol });
    i++;
    col++;
  }

  tokens.push({ kind: "eof", value: "", line, col });
  return tokens;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "@";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

// ═══════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: "eof", value: "", line: 0, col: 0 };
  }

  private advance(): Token {
    const tok = this.peek();
    if (tok.kind !== "eof") this.pos++;
    return tok;
  }

  private match(kind: TokenKind, value?: string): boolean {
    const tok = this.peek();
    if (tok.kind === kind && (value === undefined || tok.value === value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private check(kind: TokenKind, value?: string): boolean {
    const tok = this.peek();
    return tok.kind === kind && (value === undefined || tok.value === value);
  }

  // ---- Top-level parsing ----

  parseFile(filePath: string): CSharpAST {
    const ast: CSharpAST = {
      filePath,
      usings: [],
      namespaces: [],
      types: [],
    };

    while (!this.check("eof")) {
      const attrs = this.tryParseAttributes();

      if (this.check("keyword", "using")) {
        const u = this.parseUsing();
        if (u) ast.usings.push(u);
        continue;
      }

      if (this.check("keyword", "namespace")) {
        const ns = this.parseNamespace();
        if (ns) ast.namespaces.push(ns);
        continue;
      }

      // Modifiers before type declaration
      const modifiers = this.parseModifiers();

      if (this.check("keyword", "class") || this.check("keyword", "record")) {
        const cls = this.parseClassDecl(modifiers, attrs);
        if (cls) ast.types.push(cls);
        continue;
      }

      if (this.check("keyword", "struct")) {
        const st = this.parseStructDecl(modifiers, attrs);
        if (st) ast.types.push(st);
        continue;
      }

      if (this.check("keyword", "interface")) {
        const iface = this.parseInterfaceDecl(modifiers, attrs);
        if (iface) ast.types.push(iface);
        continue;
      }

      if (this.check("keyword", "enum")) {
        const en = this.parseEnumDecl(modifiers, attrs);
        if (en) ast.types.push(en);
        continue;
      }

      // Skip unrecognized tokens
      this.advance();
    }

    return ast;
  }

  // ---- Using directive ----

  private parseUsing(): UsingDirective | null {
    const tok = this.advance(); // consume 'using'
    const line = tok.line;

    let isStatic = false;
    let alias: string | undefined;

    if (this.check("keyword", "static")) {
      isStatic = true;
      this.advance();
    }

    // Check for alias: using Alias = Namespace;
    if (this.check("identifier") && this.lookAhead(1)?.kind === "equals") {
      alias = this.advance().value;
      this.advance(); // skip =
    }

    const ns = this.parseQualifiedName();
    this.match("semicolon");

    return { kind: "using", namespace: ns, alias, isStatic, line };
  }

  // ---- Namespace ----

  private parseNamespace(): NamespaceDecl | null {
    const tok = this.advance(); // consume 'namespace'
    const line = tok.line;
    const name = this.parseQualifiedName();

    // File-scoped namespace: namespace X.Y;
    if (this.match("semicolon")) {
      const members: TypeDecl[] = [];
      this.parseNamespaceBody(members);
      return { kind: "namespace", name, isFileScoped: true, members, line };
    }

    // Block namespace: namespace X.Y { ... }
    if (this.match("lbrace")) {
      const members: TypeDecl[] = [];
      this.parseNamespaceBodyBlock(members);
      this.match("rbrace");
      return { kind: "namespace", name, isFileScoped: false, members, line };
    }

    return { kind: "namespace", name, isFileScoped: false, members: [], line };
  }

  private parseNamespaceBodyBlock(members: TypeDecl[]): void {
    while (!this.check("rbrace") && !this.check("eof")) {
      const attrs = this.tryParseAttributes();
      const modifiers = this.parseModifiers();

      if (this.check("keyword", "class") || this.check("keyword", "record")) {
        const cls = this.parseClassDecl(modifiers, attrs);
        if (cls) members.push(cls);
      } else if (this.check("keyword", "struct")) {
        const st = this.parseStructDecl(modifiers, attrs);
        if (st) members.push(st);
      } else if (this.check("keyword", "interface")) {
        const iface = this.parseInterfaceDecl(modifiers, attrs);
        if (iface) members.push(iface);
      } else if (this.check("keyword", "enum")) {
        const en = this.parseEnumDecl(modifiers, attrs);
        if (en) members.push(en);
      } else if (this.check("keyword", "namespace")) {
        // Nested namespace — flatten members
        const ns = this.parseNamespace();
        if (ns) members.push(...ns.members);
      } else {
        this.advance();
      }
    }
  }

  private parseNamespaceBody(members: TypeDecl[]): void {
    // File-scoped namespace: parse until EOF
    while (!this.check("eof")) {
      const attrs = this.tryParseAttributes();
      const modifiers = this.parseModifiers();

      if (this.check("keyword", "class") || this.check("keyword", "record")) {
        const cls = this.parseClassDecl(modifiers, attrs);
        if (cls) members.push(cls);
      } else if (this.check("keyword", "struct")) {
        const st = this.parseStructDecl(modifiers, attrs);
        if (st) members.push(st);
      } else if (this.check("keyword", "interface")) {
        const iface = this.parseInterfaceDecl(modifiers, attrs);
        if (iface) members.push(iface);
      } else if (this.check("keyword", "enum")) {
        const en = this.parseEnumDecl(modifiers, attrs);
        if (en) members.push(en);
      } else {
        this.advance();
      }
    }
  }

  // ---- Class ----

  private parseClassDecl(modifiers: string[], attributes: AttributeDecl[]): ClassDecl | null {
    const tok = this.advance(); // consume 'class' or 'record'
    const line = tok.line;

    if (!this.check("identifier")) return null;
    const name = this.advance().value;
    const genericParams = this.tryParseGenericParams();
    const baseTypes = this.tryParseBaseList();

    // Skip where constraints
    this.skipWhereConstraints();

    const members: MemberDecl[] = [];
    const nestedTypes: TypeDecl[] = [];

    if (this.match("lbrace")) {
      this.parseTypeBody(name, members, nestedTypes);
      this.match("rbrace");
    }
    this.match("semicolon"); // optional trailing semicolon (record)

    return {
      kind: "class",
      name,
      modifiers,
      genericParams,
      baseTypes,
      members,
      nestedTypes,
      attributes,
      line,
    };
  }

  // ---- Struct ----

  private parseStructDecl(modifiers: string[], attributes: AttributeDecl[]): StructDecl | null {
    this.advance(); // consume 'struct'
    const line = this.tokens[this.pos - 1]!.line;

    if (!this.check("identifier")) return null;
    const name = this.advance().value;
    const genericParams = this.tryParseGenericParams();
    const baseTypes = this.tryParseBaseList();

    this.skipWhereConstraints();

    const members: MemberDecl[] = [];
    const nestedTypes: TypeDecl[] = [];

    if (this.match("lbrace")) {
      this.parseTypeBody(name, members, nestedTypes);
      this.match("rbrace");
    }
    this.match("semicolon");

    return {
      kind: "struct",
      name,
      modifiers,
      genericParams,
      baseTypes,
      members,
      nestedTypes,
      attributes,
      line,
    };
  }

  // ---- Interface ----

  private parseInterfaceDecl(modifiers: string[], attributes: AttributeDecl[]): InterfaceDecl | null {
    this.advance(); // consume 'interface'
    const line = this.tokens[this.pos - 1]!.line;

    if (!this.check("identifier")) return null;
    const name = this.advance().value;
    const genericParams = this.tryParseGenericParams();
    const baseTypes = this.tryParseBaseList();

    this.skipWhereConstraints();

    const members: MemberDecl[] = [];

    if (this.match("lbrace")) {
      // Parse interface members (methods, properties)
      while (!this.check("rbrace") && !this.check("eof")) {
        const attrs = this.tryParseAttributes();
        const mods = this.parseModifiers();

        if (this.check("keyword", "event")) {
          this.advance();
          const type = this.parseTypeReference();
          const eName = this.check("identifier") ? this.advance().value : "unknown";
          this.match("semicolon");
          members.push({ kind: "event", name: eName, type, modifiers: mods, line: this.peek().line });
          continue;
        }

        // Method or property signature
        const member = this.tryParseMemberInType("", mods, attrs);
        if (member) {
          members.push(member);
        } else {
          this.advance();
        }
      }
      this.match("rbrace");
    }

    return {
      kind: "interface",
      name,
      modifiers,
      genericParams,
      baseTypes,
      members,
      attributes,
      line,
    };
  }

  // ---- Enum ----

  private parseEnumDecl(modifiers: string[], attributes: AttributeDecl[]): EnumDecl | null {
    this.advance(); // consume 'enum'
    const line = this.tokens[this.pos - 1]!.line;

    if (!this.check("identifier")) return null;
    const name = this.advance().value;

    // Optional base type (: int, : byte, etc.)
    if (this.match("colon")) {
      this.parseTypeReference();
    }

    const values: string[] = [];
    if (this.match("lbrace")) {
      while (!this.check("rbrace") && !this.check("eof")) {
        // Skip attributes on enum members
        this.tryParseAttributes();

        if (this.check("identifier")) {
          values.push(this.advance().value);
          // Skip = value
          if (this.match("equals")) {
            this.skipExpression();
          }
          this.match("comma");
        } else {
          this.advance();
        }
      }
      this.match("rbrace");
    }

    return { kind: "enum", name, modifiers, values, attributes, line };
  }

  // ---- Type body (class/struct members) ----

  private parseTypeBody(
    typeName: string,
    members: MemberDecl[],
    nestedTypes: TypeDecl[]
  ): void {
    while (!this.check("rbrace") && !this.check("eof")) {
      const attrs = this.tryParseAttributes();
      const modifiers = this.parseModifiers();

      // Nested types
      if (this.check("keyword", "class") || this.check("keyword", "record")) {
        const cls = this.parseClassDecl(modifiers, attrs);
        if (cls) nestedTypes.push(cls);
        continue;
      }
      if (this.check("keyword", "struct")) {
        const st = this.parseStructDecl(modifiers, attrs);
        if (st) nestedTypes.push(st);
        continue;
      }
      if (this.check("keyword", "interface")) {
        const iface = this.parseInterfaceDecl(modifiers, attrs);
        if (iface) nestedTypes.push(iface);
        continue;
      }
      if (this.check("keyword", "enum")) {
        const en = this.parseEnumDecl(modifiers, attrs);
        if (en) nestedTypes.push(en);
        continue;
      }

      // Event declaration
      if (this.check("keyword", "event")) {
        this.advance();
        const type = this.parseTypeReference();
        const name = this.check("identifier") ? this.advance().value : "unknown";
        this.skipToSemicolonOrBrace();
        members.push({ kind: "event", name, type, modifiers, line: this.peek().line });
        continue;
      }

      // Constructor: same name as type, followed by (
      if (this.check("identifier") && this.peek().value === typeName) {
        const nextTok = this.lookAhead(1);
        if (nextTok?.kind === "lparen") {
          const ctor = this.parseConstructor(typeName, modifiers, attrs);
          if (ctor) members.push(ctor);
          continue;
        }
      }

      // Method, property, or field
      const member = this.tryParseMemberInType(typeName, modifiers, attrs);
      if (member) {
        members.push(member);
      } else {
        this.advance();
      }
    }
  }

  // ---- Constructor ----

  private parseConstructor(
    typeName: string,
    modifiers: string[],
    attributes: AttributeDecl[]
  ): ConstructorDecl | null {
    const line = this.peek().line;
    this.advance(); // consume typeName identifier
    const parameters = this.parseParameterList();

    // Optional base/this call
    if (this.match("colon")) {
      // base(...) or this(...)
      if (this.check("keyword", "base") || this.check("keyword", "this")) {
        this.advance();
        this.skipParenGroup();
      }
    }

    const bodyLineCount = this.skipBody();

    return {
      kind: "constructor",
      className: typeName,
      modifiers,
      parameters,
      bodyLineCount,
      attributes,
      line,
    };
  }

  // ---- Member parsing (method, property, field) ----

  private tryParseMemberInType(
    _typeName: string,
    modifiers: string[],
    attributes: AttributeDecl[]
  ): MemberDecl | null {
    const startPos = this.pos;
    const line = this.peek().line;

    // Destructor: ~ClassName()
    if (this.check("operator") && this.peek().value === "~") {
      this.advance();
      if (this.check("identifier")) {
        this.advance();
        this.parseParameterList();
        this.skipBody();
        return {
          kind: "method",
          name: "Finalize",
          returnType: "void",
          modifiers: [...modifiers],
          parameters: [],
          bodyLineCount: 0,
          attributes,
          line,
        };
      }
      this.pos = startPos;
      return null;
    }

    // Try to parse: Type Name
    const type = this.tryParseTypeReference();
    if (!type) return null;

    // Check if this is a property or field or method
    if (!this.check("identifier") && !this.check("keyword", "this")) {
      this.pos = startPos;
      return null;
    }

    const name = this.advance().value;

    // Method: Type Name(...)
    if (this.check("lparen")) {
      const parameters = this.parseParameterList();
      this.skipWhereConstraints();
      const bodyLineCount = this.skipBody();

      return {
        kind: "method",
        name,
        returnType: type,
        modifiers,
        parameters,
        bodyLineCount,
        attributes,
        line,
      };
    }

    // Property: Type Name { get; set; }  or  Type Name => expr;
    if (this.check("lbrace")) {
      const { hasGetter, hasSetter } = this.parsePropertyAccessors();
      return {
        kind: "property",
        name,
        type,
        modifiers,
        hasGetter,
        hasSetter,
        attributes,
        line,
      };
    }

    // Expression-bodied property: Type Name => expr;
    if (this.check("arrow")) {
      this.advance();
      this.skipToSemicolonOrBrace();
      return {
        kind: "property",
        name,
        type,
        modifiers,
        hasGetter: true,
        hasSetter: false,
        attributes,
        line,
      };
    }

    // Field: Type Name = value;  or  Type Name;
    if (this.match("equals")) {
      this.skipExpression();
    }
    this.match("semicolon");

    return {
      kind: "field",
      name,
      type,
      modifiers,
      attributes,
      line,
    };
  }

  // ---- Attributes ----

  private tryParseAttributes(): AttributeDecl[] {
    const attrs: AttributeDecl[] = [];
    while (this.check("lbracket")) {
      this.advance(); // [
      const line = this.tokens[this.pos - 1]!.line;

      // Skip attribute targets (assembly:, return:, etc.)
      if (this.check("identifier") && this.lookAhead(1)?.kind === "colon") {
        this.advance();
        this.advance();
      }

      while (!this.check("rbracket") && !this.check("eof")) {
        if (this.check("identifier") || this.check("keyword")) {
          const name = this.advance().value;
          let args = "";
          if (this.check("lparen")) {
            args = this.captureParenContent();
          }
          attrs.push({ kind: "attribute", name, arguments: args, line });
        }
        if (!this.match("comma")) break;
      }
      this.match("rbracket");
    }
    return attrs;
  }

  // ---- Modifiers ----

  private parseModifiers(): string[] {
    const mods: string[] = [];
    while (MODIFIER_KEYWORDS.has(this.peek().value) && this.peek().kind === "keyword") {
      mods.push(this.advance().value);
    }
    return mods;
  }

  // ---- Type references ----

  private parseTypeReference(): string {
    return this.tryParseTypeReference() ?? "unknown";
  }

  private tryParseTypeReference(): string | null {
    const startPos = this.pos;

    // Handle ref/out/in modifiers
    if (this.check("keyword", "ref") || this.check("keyword", "out") || this.check("keyword", "in")) {
      const mod = this.advance().value;
      const inner = this.tryParseTypeReference();
      if (inner) return `${mod} ${inner}`;
      this.pos = startPos;
      return null;
    }

    // Base type name (possibly qualified: A.B.C)
    if (!this.check("identifier") && !this.check("keyword")) {
      return null;
    }

    const tok = this.peek();
    if (tok.kind !== "identifier" && !BUILTIN_TYPES.has(tok.value)) {
      return null;
    }

    let name = this.advance().value;

    // Qualified name: A.B.C
    while (this.check("dot")) {
      const nextNext = this.lookAhead(1);
      if (nextNext?.kind === "identifier") {
        this.advance(); // .
        name += "." + this.advance().value;
      } else {
        break;
      }
    }

    // Generic arguments: A<B, C<D>>
    if (this.check("lt")) {
      const generic = this.tryParseGenericArgs();
      if (generic) {
        name += generic;
      }
    }

    // Array: []
    while (this.check("lbracket") && this.lookAhead(1)?.kind === "rbracket") {
      this.advance();
      this.advance();
      name += "[]";
    }

    // Nullable: ?
    if (this.match("question")) {
      name += "?";
    }

    return name;
  }

  private tryParseGenericArgs(): string | null {
    if (!this.check("lt")) return null;
    const startPos = this.pos;
    this.advance(); // <

    let depth = 1;
    let result = "<";

    while (depth > 0 && !this.check("eof")) {
      const tok = this.peek();
      if (tok.kind === "lt") {
        depth++;
        result += "<";
        this.advance();
      } else if (tok.kind === "gt") {
        depth--;
        result += ">";
        this.advance();
      } else if (tok.kind === "comma" && depth === 1) {
        result += ", ";
        this.advance();
      } else {
        // Heuristic: if we hit ; or { it's not a generic (it's a comparison)
        if (tok.kind === "semicolon" || tok.kind === "lbrace") {
          this.pos = startPos;
          return null;
        }
        result += tok.value;
        this.advance();
      }
    }

    return result;
  }

  // ---- Generic parameters (<T, U>) ----

  private tryParseGenericParams(): string[] {
    if (!this.check("lt")) return [];
    this.advance(); // <

    const params: string[] = [];
    while (!this.check("gt") && !this.check("eof")) {
      if (this.check("identifier")) {
        params.push(this.advance().value);
      }
      if (!this.match("comma")) break;
    }
    this.match("gt");
    return params;
  }

  // ---- Base type list (: BaseClass, IFoo, IBar) ----

  private tryParseBaseList(): string[] {
    if (!this.check("colon")) return [];
    this.advance(); // :

    const types: string[] = [];
    while (true) {
      const type = this.tryParseTypeReference();
      if (!type) break;
      types.push(type);
      if (!this.match("comma")) break;
    }
    return types;
  }

  // ---- Parameter list ----

  private parseParameterList(): ParameterInfo[] {
    if (!this.match("lparen")) return [];

    const params: ParameterInfo[] = [];
    while (!this.check("rparen") && !this.check("eof")) {
      // Skip attributes on parameters
      this.tryParseAttributes();

      // Skip params/out/ref/in keywords
      if (this.check("keyword", "params") || this.check("keyword", "out") ||
          this.check("keyword", "ref") || this.check("keyword", "in") ||
          this.check("keyword", "this")) {
        this.advance();
      }

      const type = this.tryParseTypeReference();
      if (!type) break;

      const name = this.check("identifier") ? this.advance().value : "arg";
      let hasDefault = false;
      if (this.match("equals")) {
        hasDefault = true;
        this.skipExpression();
      }

      params.push({ name, type, hasDefault });
      if (!this.match("comma")) break;
    }
    this.match("rparen");
    return params;
  }

  // ---- Property accessors ----

  private parsePropertyAccessors(): { hasGetter: boolean; hasSetter: boolean } {
    let hasGetter = false;
    let hasSetter = false;

    this.advance(); // {

    while (!this.check("rbrace") && !this.check("eof")) {
      // skip access modifiers (private set, etc.)
      this.parseModifiers();

      if (this.check("keyword", "get") || (this.check("identifier") && this.peek().value === "get")) {
        hasGetter = true;
        this.advance();
        if (this.check("lbrace")) this.skipBraceGroup();
        else if (this.check("arrow")) { this.advance(); this.skipToSemicolonOrBrace(); }
        else this.match("semicolon");
      } else if (this.check("keyword", "set") || (this.check("identifier") && this.peek().value === "set") ||
                 (this.check("identifier") && this.peek().value === "init")) {
        hasSetter = true;
        this.advance();
        if (this.check("lbrace")) this.skipBraceGroup();
        else if (this.check("arrow")) { this.advance(); this.skipToSemicolonOrBrace(); }
        else this.match("semicolon");
      } else {
        this.advance();
      }
    }
    this.match("rbrace");

    // auto-property with initializer: } = value;
    if (this.match("equals")) {
      this.skipExpression();
    }
    this.match("semicolon");

    return { hasGetter, hasSetter };
  }

  // ---- Skip helpers ----

  private skipWhereConstraints(): void {
    while (this.check("keyword", "where")) {
      this.advance();
      // Skip until { or ;
      while (!this.check("lbrace") && !this.check("semicolon") && !this.check("eof") &&
             !this.check("keyword", "where")) {
        this.advance();
      }
    }
  }

  private skipBody(): number {
    // Expression body: => expr;
    if (this.match("arrow")) {
      this.skipToSemicolonOrBrace();
      return 1;
    }

    // Block body: { ... }
    if (this.check("lbrace")) {
      const startLine = this.peek().line;
      this.skipBraceGroup();
      const endLine = this.tokens[this.pos - 1]?.line ?? startLine;
      return Math.max(endLine - startLine, 1);
    }

    // Abstract/interface member with semicolon
    this.match("semicolon");
    return 0;
  }

  private skipBraceGroup(): void {
    if (!this.match("lbrace")) return;
    let depth = 1;
    while (depth > 0 && !this.check("eof")) {
      if (this.check("lbrace")) depth++;
      else if (this.check("rbrace")) depth--;
      if (depth > 0) this.advance();
    }
    this.match("rbrace");
  }

  private skipParenGroup(): void {
    if (!this.match("lparen")) return;
    let depth = 1;
    while (depth > 0 && !this.check("eof")) {
      if (this.check("lparen")) depth++;
      else if (this.check("rparen")) depth--;
      if (depth > 0) this.advance();
    }
    this.match("rparen");
  }

  private skipExpression(): void {
    // Skip tokens until , or ; or ) — handling nested parens/braces
    let parenDepth = 0;
    let braceDepth = 0;

    while (!this.check("eof")) {
      if (this.check("lparen")) parenDepth++;
      else if (this.check("rparen")) {
        if (parenDepth === 0) return;
        parenDepth--;
      }
      else if (this.check("lbrace")) braceDepth++;
      else if (this.check("rbrace")) {
        if (braceDepth === 0) return;
        braceDepth--;
      }
      else if ((this.check("comma") || this.check("semicolon")) && parenDepth === 0 && braceDepth === 0) {
        return;
      }
      this.advance();
    }
  }

  private skipToSemicolonOrBrace(): void {
    let depth = 0;
    while (!this.check("eof")) {
      if (this.check("lbrace")) depth++;
      if (this.check("rbrace")) {
        if (depth === 0) return;
        depth--;
      }
      if (this.check("semicolon") && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private captureParenContent(): string {
    if (!this.match("lparen")) return "";
    let content = "";
    let depth = 1;
    while (depth > 0 && !this.check("eof")) {
      if (this.check("lparen")) depth++;
      if (this.check("rparen")) {
        depth--;
        if (depth === 0) { this.advance(); break; }
      }
      content += this.advance().value + " ";
    }
    return content.trim();
  }

  // ---- Utility ----

  private parseQualifiedName(): string {
    let name = this.peek().value;
    this.advance();
    while (this.check("dot")) {
      this.advance();
      name += "." + this.advance().value;
    }
    return name;
  }

  private lookAhead(offset: number): Token | undefined {
    return this.tokens[this.pos + offset];
  }
}

// ═══════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════

/**
 * Parse a C# file into a rich AST.
 * Handles nested generics, scope tracking, nested types, comments, and strings.
 */
export function parseDeep(content: string, filePath: string): CSharpAST {
  if (content.length > MAX_FILE_SIZE) {
    return { filePath, usings: [], namespaces: [], types: [] };
  }

  const tokens = tokenize(content);
  const parser = new Parser(tokens);
  return parser.parseFile(filePath);
}

// ═══════════════════════════════════════════
// Query utilities
// ═══════════════════════════════════════════

/** Flatten all types from an AST (including nested types and namespace-scoped). */
export function flattenTypes(ast: CSharpAST): TypeDecl[] {
  const result: TypeDecl[] = [];

  const collectNested = (types: readonly TypeDecl[]) => {
    for (const t of types) {
      result.push(t);
      if (t.kind === "class" || t.kind === "struct") {
        collectNested(t.nestedTypes);
      }
    }
  };

  collectNested(ast.types);
  for (const ns of ast.namespaces) {
    collectNested(ns.members);
  }

  return result;
}

/** Get all classes from an AST. */
export function getClasses(ast: CSharpAST): ClassDecl[] {
  return flattenTypes(ast).filter((t): t is ClassDecl => t.kind === "class");
}

/** Get all structs from an AST. */
export function getStructs(ast: CSharpAST): StructDecl[] {
  return flattenTypes(ast).filter((t): t is StructDecl => t.kind === "struct");
}

/** Get all interfaces from an AST. */
export function getInterfaces(ast: CSharpAST): InterfaceDecl[] {
  return flattenTypes(ast).filter((t): t is InterfaceDecl => t.kind === "interface");
}

/** Get all enums from an AST. */
export function getEnums(ast: CSharpAST): EnumDecl[] {
  return flattenTypes(ast).filter((t): t is EnumDecl => t.kind === "enum");
}

/** Get methods of a class or struct. */
export function getMethods(type: ClassDecl | StructDecl | InterfaceDecl): MethodDecl[] {
  return type.members.filter((m): m is MethodDecl => m.kind === "method");
}

/** Get constructors of a class or struct. */
export function getConstructors(type: ClassDecl | StructDecl): ConstructorDecl[] {
  return type.members.filter((m): m is ConstructorDecl => m.kind === "constructor");
}

/** Get fields of a class or struct. */
export function getFields(type: ClassDecl | StructDecl): FieldDecl[] {
  return type.members.filter((m): m is FieldDecl => m.kind === "field");
}

/** Get properties of a class or struct. */
export function getProperties(type: ClassDecl | StructDecl | InterfaceDecl): PropertyDecl[] {
  return type.members.filter((m): m is PropertyDecl => m.kind === "property");
}

/** Get DI dependencies from constructors (interface-typed parameters). */
export function getDependencies(type: ClassDecl | StructDecl): string[] {
  const deps: string[] = [];
  for (const ctor of getConstructors(type)) {
    for (const param of ctor.parameters) {
      const baseName = param.type.replace(/<[^>]+>/g, "").replace("?", "");
      if (baseName.startsWith("I") && baseName.length > 1 && baseName[1] === baseName[1]!.toUpperCase()) {
        deps.push(param.type);
      }
    }
  }
  return deps;
}

/** Check if a type inherits from a specific base (supports generics). */
export function deepInheritsFrom(type: ClassDecl | StructDecl, baseName: string): boolean {
  return type.baseTypes.some((bt) => {
    const clean = bt.replace(/<[^>]+>/g, "");
    return clean === baseName;
  });
}

/** Check if a type implements a specific interface (supports generics). */
export function deepImplements(type: ClassDecl | StructDecl | InterfaceDecl, ifaceName: string): boolean {
  return type.baseTypes.some((bt) => {
    const clean = bt.replace(/<[^>]+>/g, "");
    return clean === ifaceName;
  });
}

/** Get field types with [Inject] attribute from a class or struct. */
export function getInjectedDependencies(type: ClassDecl | StructDecl): string[] {
  const deps: string[] = [];
  for (const field of getFields(type)) {
    if (field.attributes.some((a) => a.name === "Inject")) {
      const baseName = field.type.replace(/<[^>]+>/g, "").replace("?", "");
      deps.push(baseName);
    }
  }
  return deps;
}

/** Strip generic type arguments from a type name. */
export function stripGenericArgs(typeName: string): string {
  return typeName.replace(/<[^>]+>/g, "");
}
