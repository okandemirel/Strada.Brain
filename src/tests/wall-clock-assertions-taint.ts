/**
 * The clock-taint analysis behind docs/contracts/wall-clock-assertions.md,
 * rule no-new-wall-clock-bound. Its detector is
 * src/tests/wall-clock-assertions.test.ts.
 *
 * A value is clock-tainted when it comes from a real clock read: `Date.now()`,
 * `performance.now()`, `process.hrtime()` / `process.hrtime.bigint()`, or an
 * argument-less `new Date()` (so `new Date().getTime()` and `+new Date()` too).
 * The taint follows what the test file itself spells: names (also when they are
 * assigned again later, or destructured), arithmetic and any other expression
 * built from a tainted part, the arguments of a call and the object a method is
 * called on, what a function the file declares returns, the properties of an
 * object literal, and what is pushed, set or added onto a name
 * (`times.push(performance.now() - s)`).
 *
 * An ordering matcher (`toBeLessThan`, `toBeLessThanOrEqual`, `toBeGreaterThan`,
 * `toBeGreaterThanOrEqual`, with or without `.not`) on `expect(x)` or
 * `expect.soft(x)` counts when `x` or the bound it is compared with is tainted.
 * Which side, which direction and how the inequality is arranged do not matter:
 * every arrangement of "a later clock read minus an earlier one is below K"
 * holds a tainted side. Two cases are left out, each on purpose:
 *
 * - an order of two bare clock values, with no constant, stamp or call on
 *   either side (`expect(b).toBeGreaterThan(a)` with both clock reads, or two
 *   elapsed times compared): it checks that the clock moved on, or which of two
 *   runs was faster, which load does not decide by itself;
 * - an assertion under a fake clock: `vi.useFakeTimers()` (unless its `toFake`
 *   leaves Date out), `vi.setSystemTime()`, or `vi.spyOn(Date | performance,
 *   "now")`, in the test case before the assertion (and not undone by
 *   `vi.useRealTimers()` in between), or in a `beforeEach`/`beforeAll` or a
 *   plain statement of an enclosing `describe` or of the file.
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
const PERF_HOOKS = new Set(["perf_hooks", "node:perf_hooks"]);
const PROCESS = new Set(["process", "node:process"]);
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
const SPELLS_CLOCK = /\bnow\b|\bhrtime\b|new\s+Date\s*\(\s*\)/;
const SPELLS_ORDERING = /\b(?:toBeLessThan|toBeGreaterThan)/;

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
    if (obj.name.text === "not") negated = !negated;
    else return undefined;
    obj = obj.expression;
  }
  if (!ts.isCallExpression(obj) || obj.arguments.length === 0) return undefined;
  const head = obj.expression;
  const isExpect =
    (ts.isIdentifier(head) && head.text === "expect") ||
    (ts.isPropertyAccessExpression(head) && head.name.text === "soft" && ts.isIdentifier(head.expression) && head.expression.text === "expect");
  return isExpect ? { target: obj.arguments[0]!, matcher, negated } : undefined;
}

/** The taint reader for one program; every answer is kept per node or symbol. */
function taintReader(checker: ts.TypeChecker) {
  const nodes = new Map<ts.Node, boolean>();
  const symbols = new Map<ts.Symbol, boolean>();
  const writes = new Map<ts.Symbol, ts.Expression[]>();

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

  /** A global by that name, or (for `performance` and `process`) the same object imported from its node module. */
  function isClockObject(node: ts.Expression, name: "Date" | "performance" | "process"): boolean {
    const n = strip(node);
    const modules = name === "performance" ? PERF_HOOKS : name === "process" ? PROCESS : undefined;
    if (ts.isIdentifier(n)) {
      const decl = declarationOf(n);
      if (!decl) return n.text === name;
      if (!modules) return false;
      const from = moduleOf(decl);
      if (!from || !modules.has(from)) return false;
      if (ts.isImportSpecifier(decl)) return (decl.propertyName ?? decl.name).text === name;
      return name === "process"; // `import process from "node:process"`, `import * as process`
    }
    if (modules && ts.isPropertyAccessExpression(n) && n.name.text === name && ts.isIdentifier(n.expression)) {
      const decl = declarationOf(n.expression);
      const from = decl && moduleOf(decl);
      return from !== undefined && modules.has(from) && !ts.isImportSpecifier(decl!);
    }
    return false;
  }

  function isClockRead(n: ts.Node): boolean {
    if (ts.isNewExpression(n)) return (n.arguments?.length ?? 0) === 0 && isClockObject(n.expression, "Date");
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return false;
    const { expression: obj, name } = n.expression;
    if (name.text === "now") return isClockObject(obj, "Date") || isClockObject(obj, "performance");
    if (name.text === "hrtime") return isClockObject(obj, "process");
    if (name.text === "bigint" && ts.isPropertyAccessExpression(obj) && obj.name.text === "hrtime") {
      return isClockObject(obj.expression, "process");
    }
    return false;
  }

  /**
   * What is written into a variable after its declaration: assignments, and
   * the arguments of push/set/add/… on it. Each file is indexed once.
   */
  const indexed = new Set<ts.SourceFile>();
  function writesTo(symbol: ts.Symbol, sf: ts.SourceFile): ts.Expression[] {
    if (!indexed.has(sf)) {
      indexed.add(sf);
      const record = (id: ts.Expression, values: ts.Expression[]): void => {
        const target = strip(id);
        const sym = ts.isIdentifier(target) ? checker.getSymbolAtLocation(target) : undefined;
        if (!sym) return;
        const list = writes.get(sym) ?? [];
        list.push(...values);
        writes.set(sym, list);
      };
      const visit = (m: ts.Node): void => {
        if (ts.isBinaryExpression(m) && ASSIGNMENTS.has(m.operatorToken.kind)) record(m.left, [m.right]);
        if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && FILLS.has(m.expression.name.text)) {
          record(m.expression.expression, m.arguments.map((a) => (ts.isSpreadElement(a) ? a.expression : a)));
        }
        ts.forEachChild(m, visit);
      };
      visit(sf);
    }
    return writes.get(symbol) ?? [];
  }

  /** The `return`s (or expression body) of a function the file declares, called by this name. */
  function returnsOf(callee: ts.Expression): ts.Expression[] | undefined {
    const c = strip(callee);
    if (!ts.isIdentifier(c)) return undefined;
    const decl = declarationOf(c);
    let fn: ts.FunctionLikeDeclaration | undefined;
    if (decl && ts.isFunctionDeclaration(decl)) fn = decl;
    else if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = strip(decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
    }
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
   * names, `await` and functions the file declares: `{ ms }` or `{ ms: … }`.
   * Undefined when any of them is not an object literal holding the key, so
   * the caller falls back to the whole holder.
   */
  function propertyOf(holder: ts.Expression, key: string, seen = new Set<ts.Node>()): ts.Expression[] | undefined {
    const h = strip(holder);
    if (seen.has(h)) return undefined;
    seen.add(h);
    if (ts.isAwaitExpression(h)) return propertyOf(h.expression, key, seen);
    if (ts.isIdentifier(h)) {
      const decl = declarationOf(h);
      return decl && ts.isVariableDeclaration(decl) && decl.initializer ? propertyOf(decl.initializer, key, seen) : undefined;
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

  function nameTainted(id: ts.Identifier): boolean {
    const symbol = ts.isShorthandPropertyAssignment(id.parent)
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);
    const decl = symbol?.declarations?.[0];
    if (!symbol || !decl) return false;
    const known = symbols.get(symbol);
    if (known !== undefined) return known;
    symbols.set(symbol, false);
    let hit = false;
    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.name)) hit = tainted(decl.initializer);
    else if (ts.isBindingElement(decl)) {
      let root: ts.Node = decl;
      while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent;
      const init = ts.isVariableDeclaration(root) ? root.initializer : undefined;
      const key = decl.propertyName ?? decl.name;
      const precise =
        init && ts.isObjectBindingPattern(decl.parent) && ts.isIdentifier(key) ? propertyOf(init, key.text) : undefined;
      hit = precise ? precise.some(tainted) : init !== undefined && tainted(init);
    }
    if (!hit && (ts.isVariableDeclaration(decl) || ts.isBindingElement(decl))) hit = writesTo(symbol, decl.getSourceFile()).some(tainted);
    symbols.set(symbol, hit);
    return hit;
  }

  /** Whether any part of `node` comes from a real clock read. */
  function tainted(node: ts.Node): boolean {
    const known = nodes.get(node);
    if (known !== undefined) return known;
    nodes.set(node, false);
    let hit = false;
    if (isClockRead(node)) hit = true;
    else if (ts.isIdentifier(node)) hit = nameTainted(node);
    else if (ts.isPropertyAccessExpression(node)) {
      const precise = propertyOf(node.expression, node.name.text);
      hit = precise ? precise.some(tainted) : tainted(node.expression);
    } else if (ts.isCallExpression(node)) {
      const returned = returnsOf(node.expression);
      hit =
        (returned?.some(tainted) ?? false) ||
        node.arguments.some(tainted) ||
        (ts.isPropertyAccessExpression(node.expression) && tainted(node.expression.expression));
    } else if (ts.isPropertyAssignment(node)) hit = tainted(node.initializer);
    else if (!ts.isTypeNode(node)) {
      ts.forEachChild(node, (c) => {
        if (!hit && tainted(c)) hit = true;
      });
    }
    nodes.set(node, hit);
    return hit;
  }

  /**
   * Whether a side is a bare clock value: a clock read, a `const` declared
   * with one and never written again, or `+`, `-`, `*`, `/` of two bare clock
   * values (an elapsed time `end - start` is one). Anything else, a constant,
   * a stamp, a call or a property, is slack, and an unknown counts as slack.
   */
  function bare(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const n = strip(node);
    if (seen.has(n)) return false;
    seen.add(n);
    if (isClockRead(n)) return true;
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const arithmetic =
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.MinusToken ||
        op === ts.SyntaxKind.AsteriskToken ||
        op === ts.SyntaxKind.SlashToken;
      return arithmetic && bare(n.left, seen) && bare(n.right, seen);
    }
    if (ts.isIdentifier(n)) {
      const symbol = checker.getSymbolAtLocation(n);
      const decl = symbol?.declarations?.[0];
      if (!symbol || !decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
      return writesTo(symbol, decl.getSourceFile()).length === 0 && bare(decl.initializer, seen);
    }
    return false;
  }

  return { tainted, bare };
}

/** The `it`/`test` callback an assertion sits in, and the `describe` callbacks and file around it. */
function scopesOf(node: ts.Node): { testBody: ts.Node | undefined; outer: ts.Node[] } {
  let testBody: ts.Node | undefined;
  const outer: ts.Node[] = [];
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) {
      if (ts.isSourceFile(n)) outer.push(n);
      continue;
    }
    const call = n.parent;
    if (!ts.isCallExpression(call)) continue;
    let head: ts.Expression = call.expression;
    while (ts.isPropertyAccessExpression(head) || ts.isCallExpression(head)) head = head.expression;
    const name = ts.isIdentifier(head) ? head.text : "";
    if ((name === "it" || name === "test") && !testBody) testBody = n.body;
    if (name === "describe") outer.push(n.body);
  }
  return { testBody, outer };
}

/** `vi.useFakeTimers(…)` that fakes Date, `vi.setSystemTime(…)`, or `vi.spyOn(Date | performance, "now")`. */
function fakesClock(call: ts.CallExpression): boolean {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== "vi") return false;
  if (e.name.text === "setSystemTime") return true;
  if (e.name.text === "useFakeTimers") {
    const opts = call.arguments[0];
    if (!opts || !ts.isObjectLiteralExpression(opts)) return true;
    const toFake = opts.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "toFake");
    if (!toFake || !ts.isPropertyAssignment(toFake) || !ts.isArrayLiteralExpression(toFake.initializer)) return true;
    return toFake.initializer.elements.some((el) => ts.isStringLiteral(el) && (el.text === "Date" || el.text === "performance"));
  }
  if (e.name.text === "spyOn") {
    const [obj, method] = call.arguments;
    return (
      obj !== undefined &&
      ts.isIdentifier(strip(obj)) &&
      ["Date", "performance"].includes((strip(obj) as ts.Identifier).text) &&
      method !== undefined &&
      ts.isStringLiteral(method) &&
      method.text === "now"
    );
  }
  return false;
}

const isRealTimers = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === "vi" &&
  call.expression.name.text === "useRealTimers";

/** Whether the assertion runs under a fake clock, as the module comment says. */
function underFakeClock(assertion: ts.Node): boolean {
  const { testBody, outer } = scopesOf(assertion);
  if (testBody) {
    let faked = false;
    const visit = (n: ts.Node): void => {
      if (n.getStart() >= assertion.getStart()) return;
      if (ts.isCallExpression(n) && fakesClock(n)) faked = true;
      else if (ts.isCallExpression(n) && isRealTimers(n)) faked = false;
      ts.forEachChild(n, visit);
    };
    visit(testBody);
    if (faked) return true;
  }
  for (const scope of outer) {
    let faked = false;
    const statements = ts.isSourceFile(scope) ? scope.statements : ts.isBlock(scope) ? scope.statements : [];
    for (const st of statements) {
      if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
      const call = st.expression;
      if (fakesClock(call)) faked = true;
      const hook = ts.isIdentifier(call.expression) ? call.expression.text : "";
      if (hook === "beforeEach" || hook === "beforeAll") {
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && fakesClock(n)) faked = true;
          ts.forEachChild(n, visit);
        };
        call.arguments.forEach(visit);
      }
    }
    if (faked) return true;
  }
  return false;
}

/**
 * Every clock-tainted ordering assertion in the test files of `root`
 * (repo-relative names). A file that spells no clock read or no ordering
 * matcher holds nothing the analysis could count, so only the others are parsed.
 */
export function wallClockBounds(root: string, rels: readonly string[]): Bound[] {
  const texts = new Map<string, string>();
  const relOf = new Map<string, string>();
  for (const rel of rels) {
    const file = path.resolve(root, rel);
    const text = readFileSync(file, "utf8");
    if (!SPELLS_CLOCK.test(text) || !SPELLS_ORDERING.test(text)) continue;
    texts.set(file, text);
    relOf.set(file, rel);
  }
  const checker = program(root, texts);
  const { tainted, bare } = taintReader(checker);
  const found: Bound[] = [];
  for (const file of texts.keys()) {
    const sf = checker.sourceOf(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const e = expectTarget(node);
        const bound = node.arguments[0];
        if (e && ORDERING.has(e.matcher)) {
          const inTarget = tainted(e.target);
          const inBound = bound !== undefined && tainted(bound);
          const order = inTarget && inBound && bare(e.target) && bare(bound!);
          if ((inTarget || inBound) && !order && !underFakeClock(node)) {
            found.push({
              file: relOf.get(file)!,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              text: node.getText(sf).replace(/\s+/g, " "),
              form: inTarget && inBound ? "both" : inTarget ? "target" : "bound",
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
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
