/**
 * The clock-taint analysis behind docs/contracts/wall-clock-assertions.md,
 * rule no-new-wall-clock-bound. Its detector is
 * src/tests/wall-clock-assertions.test.ts.
 *
 * A value is clock-tainted when it comes from a real clock read: `Date.now()`,
 * `performance.now()`, `process.hrtime()` / `process.hrtime.bigint()` (also
 * `hrtime` imported from node:process), `process.uptime()` / `os.uptime()`, or
 * an argument-less `new Date()` (so `new Date().getTime()` and `+new Date()`
 * too). The taint follows what the test file itself spells: names (also when
 * they are assigned again later, destructured, or the variable of a `for … of`
 * / `for … in` loop), arithmetic and any other expression built from a tainted
 * part, the arguments of a call and the object a method is called on, the
 * parameter of a callback handed to a method of a tainted object, what a
 * function the file declares returns, the properties of an object literal,
 * what is written into a property after the declaration (`stats.ms = …`), and
 * what is pushed, set or added onto a name (`times.push(performance.now() - s)`).
 *
 * An ordering matcher (`toBeLessThan`, `toBeLessThanOrEqual`, `toBeGreaterThan`,
 * `toBeGreaterThanOrEqual`, with or without `.not`, `.resolves`, `.rejects`) on
 * `expect(x)` or `expect.soft(x)` counts when `x` or the bound it is compared
 * with is tainted. Which side, which direction and how the inequality is
 * arranged do not matter: every arrangement of "a later clock read minus an
 * earlier one is below K" holds a tainted side. Nothing is left out by
 * inference: not an order of two clock values, not an assertion under a fake
 * clock. Whether a fake clock holds still for the clock a line reads depends
 * on which object the read reaches at run time (a `performance` imported from
 * node:perf_hooks is not the global one fake timers replace), which a reading
 * of the source cannot prove. The one way out is a mark the reviewer reads: a
 * line comment `// wall-clock-frozen: <why>` on the line right above the
 * assertion (MARK below). A marked assertion is reported as marked, not
 * counted; a mark above no counted assertion, or with no reason, is reported
 * as stray.
 *
 * When in doubt it counts: this is a ratchet, and counting too much only makes
 * the baseline larger, while counting too little lets a new bound through.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** A clock-tainted ordering assertion: where it is, how it reads, and which side holds the taint. */
export interface Bound {
  file: string;
  line: number;
  text: string;
  form: "target" | "bound" | "both";
}

const ORDERING = new Set(["toBeLessThan", "toBeLessThanOrEqual", "toBeGreaterThan", "toBeGreaterThanOrEqual"]);
/** Links between `expect(x)` and the matcher that compare the same value (`.resolves` its settled value). */
const CHAIN = new Set(["not", "resolves", "rejects"]);

/** The clocks a value can come from, as bits; any bit makes a value tainted. */
const DATE = 1;
const PERF = 2;
const HRTIME = 4;
const UPTIME = 8;

const MODULES = {
  performance: new Set(["perf_hooks", "node:perf_hooks"]),
  process: new Set(["process", "node:process"]),
  os: new Set(["os", "node:os"]),
} as const;
const GLOBALS = new Set(["Date", "performance", "process"]);
/** Methods that put their arguments into the object they are called on. */
const FILLS = new Set(["push", "unshift", "set", "add", "splice"]);
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);
/** A file that spells none of these holds no clock read the analysis could follow. */
const SPELLS_CLOCK = /\bnow\b|\bhrtime\b|\buptime\b|new\s+Date\s*\(\s*\)/;
const SPELLS_ORDERING = /\b(?:toBeLessThan|toBeGreaterThan)/;

/**
 * The mark that leaves one assertion out: `// wall-clock-frozen: <why>` on the
 * line right above it. The reason must say something (8 characters or more).
 */
const MARK = /^\s*\/\/\s*wall-clock-frozen:(.*)$/;
const MIN_REASON = 8;

/** Parens, `as`, `!` and `satisfies` change nothing about the value. */
function strip(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** One program over every file, so a name resolves to its declaration in its own scope. */
function program(root: string, files: Map<string, string>): ts.TypeChecker & { sourceOf(file: string): ts.SourceFile } {
  const sources = new Map<string, ts.SourceFile>();
  for (const [file, text] of files) {
    sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name) => sources.get(path.resolve(name)),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => sources.has(path.resolve(name)),
    readFile: () => undefined,
  };
  const checker = ts.createProgram([...sources.keys()], { noLib: true, noResolve: true, types: [] }, host).getTypeChecker();
  return Object.assign(checker, { sourceOf: (file: string) => sources.get(file)! });
}

/** `expect(x, msg?)` or `expect.soft(x, msg?)` at the root of a matcher chain, and whether `.not` is on it. */
function expectTarget(call: ts.CallExpression): { target: ts.Expression; matcher: string; negated: boolean } | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const matcher = call.expression.name.text;
  let negated = false;
  let obj = call.expression.expression;
  while (ts.isPropertyAccessExpression(obj)) {
    if (!CHAIN.has(obj.name.text)) return undefined;
    if (obj.name.text === "not") negated = !negated;
    obj = obj.expression;
  }
  if (!ts.isCallExpression(obj) || obj.arguments.length === 0) return undefined;
  const head = obj.expression;
  const isExpect =
    (ts.isIdentifier(head) && head.text === "expect") ||
    (ts.isPropertyAccessExpression(head) && head.name.text === "soft" && ts.isIdentifier(head.expression) && head.expression.text === "expect");
  return isExpect ? { target: obj.arguments[0]!, matcher, negated } : undefined;
}

/** Taint reading for one program; every answer is kept per node or symbol. */
function analysis(checker: ts.TypeChecker) {
  const nodes = new Map<ts.Node, number>();
  const symbols = new Map<ts.Symbol, number>();
  /** What is written to a name itself after its declaration: assignments, push/set/add/… on it. */
  const writes = new Map<ts.Symbol, ts.Expression[]>();
  /** What is written into a property of a name (`x.p = …`, `x.p.push(…)`); key "" for a computed one. */
  const keyed = new Map<ts.Symbol, Map<string, ts.Expression[]>>();

  const declarationOf = (id: ts.Identifier): ts.Declaration | undefined => checker.getSymbolAtLocation(id)?.declarations?.[0];
  const moduleOf = (decl: ts.Declaration): string | undefined => {
    const clause = ts.isImportSpecifier(decl)
      ? decl.parent.parent
      : ts.isNamespaceImport(decl)
        ? decl.parent
        : ts.isImportClause(decl)
          ? decl
          : undefined;
    const from = clause?.parent.moduleSpecifier;
    return from && ts.isStringLiteral(from) ? from.text : undefined;
  };

  /** A global by that name, or the same object imported from its node module (`os` only as an import). */
  function isClockObject(node: ts.Expression, name: "Date" | "performance" | "process" | "os"): boolean {
    const n = strip(node);
    const modules = name === "Date" ? undefined : MODULES[name];
    if (ts.isIdentifier(n)) {
      const decl = declarationOf(n);
      if (!decl) return GLOBALS.has(name) && n.text === name;
      if (!modules) return false;
      const from = moduleOf(decl);
      if (!from || !modules.has(from)) return false;
      if (ts.isImportSpecifier(decl)) return (decl.propertyName ?? decl.name).text === name;
      return name !== "performance"; // `import process from "node:process"`, `import * as os from "node:os"`
    }
    if (modules && ts.isPropertyAccessExpression(n) && n.name.text === name && ts.isIdentifier(n.expression)) {
      const decl = declarationOf(n.expression);
      const from = decl && moduleOf(decl);
      return from !== undefined && modules.has(from) && !ts.isImportSpecifier(decl!);
    }
    return false;
  }

  /** A function imported by name from a node module: `import { hrtime } from "node:process"`. */
  function importedFrom(id: ts.Identifier, module: keyof typeof MODULES, exported: string): boolean {
    const decl = declarationOf(id);
    if (!decl || !ts.isImportSpecifier(decl)) return false;
    const from = moduleOf(decl);
    return from !== undefined && MODULES[module].has(from) && (decl.propertyName ?? decl.name).text === exported;
  }

  /** Which clock `n` reads, as a bit, or 0 when it reads none. */
  function clockRead(n: ts.Node): number {
    if (ts.isNewExpression(n)) return (n.arguments?.length ?? 0) === 0 && isClockObject(n.expression, "Date") ? DATE : 0;
    if (!ts.isCallExpression(n)) return 0;
    const callee = strip(n.expression);
    if (ts.isIdentifier(callee)) {
      if (importedFrom(callee, "process", "hrtime")) return HRTIME;
      return importedFrom(callee, "process", "uptime") || importedFrom(callee, "os", "uptime") ? UPTIME : 0;
    }
    if (!ts.isPropertyAccessExpression(callee)) return 0;
    const { expression: obj, name } = callee;
    if (name.text === "now") return isClockObject(obj, "Date") ? DATE : isClockObject(obj, "performance") ? PERF : 0;
    if (name.text === "hrtime") return isClockObject(obj, "process") ? HRTIME : 0;
    if (name.text === "uptime") return isClockObject(obj, "process") || isClockObject(obj, "os") ? UPTIME : 0;
    if (name.text === "bigint") {
      const o = strip(obj);
      if (ts.isPropertyAccessExpression(o) && o.name.text === "hrtime") return isClockObject(o.expression, "process") ? HRTIME : 0;
      return ts.isIdentifier(o) && importedFrom(o, "process", "hrtime") ? HRTIME : 0;
    }
    return 0;
  }

  const literalKey = (e: ts.ElementAccessExpression): string =>
    ts.isStringLiteralLike(e.argumentExpression) || ts.isNumericLiteral(e.argumentExpression) ? e.argumentExpression.text : "";

  /** The name at the root of `x`, `x.p.q` or `x[k]`, and the first key after it (undefined for the bare name). */
  function rootOf(e: ts.Expression): { sym: ts.Symbol; id: ts.Identifier; key: string | undefined } | undefined {
    let n = strip(e);
    let key: string | undefined;
    while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      key = ts.isPropertyAccessExpression(n) ? n.name.text : literalKey(n);
      n = strip(n.expression);
    }
    if (!ts.isIdentifier(n)) return undefined;
    const sym = checker.getSymbolAtLocation(n);
    return sym ? { sym, id: n, key } : undefined;
  }

  const push = <K>(map: Map<K, ts.Expression[]>, key: K, values: readonly ts.Expression[]): void => {
    const list = map.get(key) ?? [];
    list.push(...values);
    map.set(key, list);
  };

  /**
   * Records a write. Rebinding a bare name (`x = v`) touches that name only;
   * a mutation (`x.p = v`, `x.push(v)`) also reaches the object an alias
   * (`const x = stats.times`) was declared from.
   */
  function record(target: ts.Expression, values: readonly ts.Expression[], mutation: boolean, seen = new Set<ts.Symbol>()): void {
    const r = rootOf(target);
    if (!r || seen.has(r.sym)) return;
    seen.add(r.sym);
    if (r.key === undefined && !mutation) return push(writes, r.sym, values);
    if (r.key === undefined) push(writes, r.sym, values);
    else {
      const byKey = keyed.get(r.sym) ?? new Map<string, ts.Expression[]>();
      keyed.set(r.sym, byKey);
      push(byKey, r.key, values);
    }
    const decl = r.sym.declarations?.[0];
    const init = decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.initializer : undefined;
    if (!init) return;
    const origin = strip(init);
    if (!ts.isIdentifier(origin) && !ts.isPropertyAccessExpression(origin) && !ts.isElementAccessExpression(origin)) return;
    const o = rootOf(origin);
    if (!o) return;
    // `const t = stats.times; t.push(v)` writes into stats.times; `const s = stats; s.ms = v` into stats.ms.
    const key = o.key ?? r.key;
    if (key === undefined) record(o.id, values, true, seen);
    else {
      const byKey = keyed.get(o.sym) ?? new Map<string, ts.Expression[]>();
      keyed.set(o.sym, byKey);
      push(byKey, key, values);
    }
  }

  const indexed = new Set<ts.SourceFile>();
  function index(sf: ts.SourceFile): void {
    if (indexed.has(sf)) return;
    indexed.add(sf);
    const visit = (m: ts.Node): void => {
      if (ts.isBinaryExpression(m) && ASSIGNMENTS.has(m.operatorToken.kind)) {
        const left = strip(m.left);
        record(left, [m.right], !ts.isIdentifier(left));
      }
      if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && FILLS.has(m.expression.name.text)) {
        record(m.expression.expression, m.arguments.map((a) => (ts.isSpreadElement(a) ? a.expression : a)), true);
      }
      ts.forEachChild(m, visit);
    };
    visit(sf);
  }
  const writesOf = (sym: ts.Symbol, at: ts.Node): ts.Expression[] => {
    index(at.getSourceFile());
    return writes.get(sym) ?? [];
  };
  const keyedOf = (sym: ts.Symbol, at: ts.Node, key?: string): ts.Expression[] => {
    index(at.getSourceFile());
    const byKey = keyed.get(sym);
    if (!byKey) return [];
    return key === undefined ? [...byKey.values()].flat() : [...(byKey.get(key) ?? []), ...(byKey.get("") ?? [])];
  };

  const any = (list: readonly ts.Node[] | undefined): number => (list ?? []).reduce((m, n) => m | tainted(n), 0);

  /** The `return`s (or expression body) of a function the file declares, called by this name. */
  function declaredFunction(callee: ts.Expression): ts.FunctionLikeDeclaration | undefined {
    const c = strip(callee);
    if (!ts.isIdentifier(c)) return undefined;
    const decl = declarationOf(c);
    if (decl && ts.isFunctionDeclaration(decl)) return decl;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = strip(decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
    return undefined;
  }
  function returnsOf(callee: ts.Expression): ts.Expression[] | undefined {
    const fn = declaredFunction(callee);
    if (!fn?.body) return undefined;
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) return; // a nested function's return is not this one's
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  }

  /**
   * Property `key` of the object literal(s) `holder` stands for, through
   * names, `await` and functions the file declares: `{ ms }` or `{ ms: … }`,
   * plus what is written into that property of a name later. Undefined when
   * any of them is not an object literal holding the key, or the name is
   * rebound later, so the caller falls back to the whole holder.
   */
  function propertyOf(holder: ts.Expression, key: string, seen = new Set<ts.Node>()): ts.Expression[] | undefined {
    const h = strip(holder);
    if (seen.has(h)) return undefined;
    seen.add(h);
    if (ts.isAwaitExpression(h)) return propertyOf(h.expression, key, seen);
    if (ts.isIdentifier(h)) {
      const sym = checker.getSymbolAtLocation(h);
      const decl = sym?.declarations?.[0];
      if (!sym || !decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
      if (writesOf(sym, h).length > 0) return undefined;
      const inner = propertyOf(decl.initializer, key, seen);
      return inner && [...inner, ...keyedOf(sym, h, key)];
    }
    if (ts.isCallExpression(h)) {
      const returned = returnsOf(h.expression);
      if (!returned || returned.length === 0) return undefined;
      const all: ts.Expression[] = [];
      for (const r of returned) {
        const values = propertyOf(r, key, seen);
        if (!values) return undefined;
        all.push(...values);
      }
      return all;
    }
    if (!ts.isObjectLiteralExpression(h)) return undefined;
    for (const p of h.properties) {
      if (!p.name || !ts.isIdentifier(p.name) || p.name.text !== key) continue;
      if (ts.isPropertyAssignment(p)) return [p.initializer];
      if (ts.isShorthandPropertyAssignment(p)) return [p.name];
    }
    return undefined;
  }

  /** The variable of `for (const x of xs)` / `for (const k in o)` takes the taint of what it walks. */
  function loopSource(decl: ts.VariableDeclaration): number {
    const list = decl.parent;
    const st = list?.parent;
    return ts.isVariableDeclarationList(list) && st && (ts.isForOfStatement(st) || ts.isForInStatement(st)) ? tainted(st.expression) : 0;
  }

  /** A callback's parameter takes the taint of the object whose method it is handed to, and of the other arguments. */
  function parameterMask(p: ts.ParameterDeclaration): number {
    const fn = p.parent;
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return 0;
    const call = fn.parent;
    if (!ts.isCallExpression(call) || !call.arguments.some((a) => a === fn)) return 0;
    const receiver = ts.isPropertyAccessExpression(call.expression) ? tainted(call.expression.expression) : 0;
    return receiver | any(call.arguments.filter((a) => a !== fn));
  }

  function declarationMask(decl: ts.Declaration): number {
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      return decl.initializer ? tainted(decl.initializer) : loopSource(decl);
    }
    if (ts.isParameter(decl)) return parameterMask(decl);
    if (!ts.isBindingElement(decl)) return 0;
    let root: ts.Node = decl;
    while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent;
    if (ts.isParameter(root)) return parameterMask(root);
    if (!ts.isVariableDeclaration(root)) return 0;
    const init = root.initializer;
    if (!init) return loopSource(root);
    const key = decl.propertyName ?? decl.name;
    const direct = ts.isObjectBindingPattern(decl.parent) && decl.parent.parent === root && ts.isIdentifier(key);
    const precise = direct ? propertyOf(init, key.text) : undefined;
    return precise ? any(precise) : tainted(init);
  }

  /** A name as declared and rebound, without what is written into its properties. */
  function nameMask(symbol: ts.Symbol, at: ts.Node): number {
    const known = symbols.get(symbol);
    if (known !== undefined) return known;
    symbols.set(symbol, 0);
    const decl = symbol.declarations?.[0];
    const m = decl ? declarationMask(decl) | any(writesOf(symbol, at)) : 0;
    symbols.set(symbol, m);
    return m;
  }

  function symbolOf(id: ts.Identifier): ts.Symbol | undefined {
    return ts.isShorthandPropertyAssignment(id.parent)
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);
  }

  function memberMask(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, key: string): number {
    const holder = strip(node.expression);
    if (ts.isIdentifier(holder)) {
      const sym = symbolOf(holder);
      if (sym) {
        const precise = propertyOf(holder, key);
        return precise ? any(precise) : nameMask(sym, holder) | any(keyedOf(sym, holder, key));
      }
    }
    const precise = propertyOf(holder, key);
    return precise ? any(precise) : tainted(holder);
  }

  /** Which clocks any part of `node` comes from, as bits; 0 when none. */
  function tainted(node: ts.Node): number {
    const known = nodes.get(node);
    if (known !== undefined) return known;
    nodes.set(node, 0);
    let m = clockRead(node);
    if (m) {
      // a clock read
    } else if (ts.isIdentifier(node)) {
      const sym = symbolOf(node);
      m = sym ? nameMask(sym, node) | any(keyedOf(sym, node)) : 0;
    } else if (ts.isPropertyAccessExpression(node)) m = memberMask(node, node.name.text);
    else if (ts.isElementAccessExpression(node) && literalKey(node) !== "") m = memberMask(node, literalKey(node));
    else if (ts.isCallExpression(node)) {
      m =
        any(returnsOf(node.expression)) |
        any(node.arguments) |
        (ts.isPropertyAccessExpression(node.expression) ? tainted(node.expression.expression) : 0);
    } else if (ts.isPropertyAssignment(node)) m = tainted(node.initializer);
    else if (!ts.isTypeNode(node)) ts.forEachChild(node, (c) => void (m |= tainted(c)));
    nodes.set(node, m);
    return m;
  }

  return { tainted };
}

/** A `// wall-clock-frozen: <why>` mark, where it is and the reason it gives. */
export interface Mark {
  file: string;
  line: number;
  reason: string;
}

/**
 * Every clock-tainted ordering assertion in the test files of `root`
 * (repo-relative names), split into the counted ones and the ones under a
 * mark, and every mark that sits above no counted assertion or gives no
 * reason. A file that spells no clock read or no ordering matcher holds
 * nothing the analysis could count, so only the others are parsed; marks are
 * read in every file.
 */
export function measureWallClock(root: string, rels: readonly string[]): { bounds: Bound[]; marked: (Bound & { reason: string })[]; stray: Mark[] } {
  const texts = new Map<string, string>();
  const relOf = new Map<string, string>();
  const marks = new Map<string, Mark>(); // by `file:line` of the line it marks
  for (const rel of rels) {
    const file = path.resolve(root, rel);
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      const m = MARK.exec(line);
      if (m) marks.set(`${rel}:${i + 2}`, { file: rel, line: i + 1, reason: m[1]!.trim() });
    });
    if (!SPELLS_CLOCK.test(text) || !SPELLS_ORDERING.test(text)) continue;
    texts.set(file, text);
    relOf.set(file, rel);
  }
  const checker = program(root, texts);
  const { tainted } = analysis(checker);
  const bounds: Bound[] = [];
  const marked: (Bound & { reason: string })[] = [];
  const used = new Set<string>();
  for (const file of texts.keys()) {
    const sf = checker.sourceOf(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const e = expectTarget(node);
        const bound = node.arguments[0];
        if (e && ORDERING.has(e.matcher)) {
          const inTarget = tainted(e.target);
          const inBound = bound !== undefined ? tainted(bound) : 0;
          if (inTarget || inBound) {
            const b: Bound = {
              file: relOf.get(file)!,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              text: node.getText(sf).replace(/\s+/g, " "),
              form: inTarget && inBound ? "both" : inTarget ? "target" : "bound",
            };
            const key = `${b.file}:${b.line}`;
            const mark = marks.get(key);
            if (mark && mark.reason.length >= MIN_REASON) {
              used.add(key);
              marked.push({ ...b, reason: mark.reason });
            } else bounds.push(b);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const stray = [...marks].filter(([key]) => !used.has(key)).map(([, m]) => m);
  return { bounds, marked, stray };
}

/** The counted bounds alone. */
export function wallClockBounds(root: string, rels: readonly string[]): Bound[] {
  return measureWallClock(root, rels).bounds;
}

export function countByFile(bounds: readonly Bound[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of bounds) counts[b.file] = (counts[b.file] ?? 0) + 1;
  return counts;
}

/** What the ratchet says about a measurement: bounds over the baseline, and baseline lines left too high. */
export function judgeBounds(
  bounds: readonly Bound[],
  baseline: Readonly<Record<string, number>>,
): { added: string[]; stale: string[] } {
  const counts = countByFile(bounds);
  const added: string[] = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (n <= allowed) continue;
    const here = bounds.filter((b) => b.file === file).map((b) => `  ${b.file}:${b.line}  ${b.text}`);
    added.push(`${file}: ${n} wall-clock bound(s), baseline ${allowed}\n${here.join("\n")}`);
  }
  const stale = Object.entries(baseline)
    .filter(([file, n]) => (counts[file] ?? 0) < n)
    .map(([file, n]) => `${file}: baseline ${n}, now ${counts[file] ?? 0}`);
  return { added, stale };
}
