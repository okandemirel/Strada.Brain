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
 * earlier one is below K" holds a tainted side. Two cases are left out, each on
 * purpose:
 *
 * - an order of two bare clock values, with no constant, stamp or call on
 *   either side (`expect(b).toBeGreaterThan(a)` with both clock reads, or two
 *   elapsed times compared): it checks that the clock moved on, or which of two
 *   runs was faster, which load does not decide by itself;
 * - an assertion whose every clock is proven frozen when it runs (frozenAt
 *   below): a fake clock that is not advancing, for the clock the assertion
 *   reads, not undone on the way.
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

/** The clocks a value can come from. Vitest's fake timers can fake the first three; nothing fakes uptime. */
const DATE = 1;
const PERF = 2;
const HRTIME = 4;
const UPTIME = 8;
/**
 * What `vi.useFakeTimers()` fakes without a `toFake`: in vitest 4 every timer
 * but nextTick and queueMicrotask, so Date, performance and hrtime
 * (vitest.config.ts sets no `fakeTimers`).
 */
const FAKED_BY_DEFAULT = DATE | PERF | HRTIME;
const TO_FAKE: Readonly<Record<string, number>> = { Date: DATE, performance: PERF, hrtime: HRTIME };

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

/** The calls that frame a test file: a test case, a group, a hook. */
const STRUCTURE = new Set(["it", "test", "describe", "beforeEach", "beforeAll", "afterEach", "afterAll"]);
const SPY_FREEZES = new Set(["mockReturnValue", "mockImplementation"]);
const SPY_METHODS = /^mock(?:ReturnValue|Implementation|ResolvedValue|RejectedValue)/;
const MOCK_RESETS = new Set(["restoreAllMocks", "resetAllMocks", "mockRestore", "mockReset"]);

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

/** The name a call chain starts from: `it` for `it.each(…)(…)`. */
function headOf(call: ts.CallExpression): string {
  let e: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : "";
}

/** Which framing call (`it`, `describe`, a hook) `fn` is the callback of, if any. */
function structural(fn: ts.Node): string | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !call.arguments.some((a) => a === fn)) return undefined;
  const head = headOf(call);
  return STRUCTURE.has(head) ? head : undefined;
}

/** A `vi.<name>(…)` call. */
const isVi = (call: ts.CallExpression, name: string): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  call.expression.name.text === name &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === "vi";

/** The state of the clocks while a test runs, as far as the file spells it. */
interface ClockState {
  installed: boolean; // vi.useFakeTimers is in effect
  timers: number; // the clocks the fake timers hold still
  dateMock: boolean; // vi.setSystemTime without fake timers: Date is mocked and still
  spies: number; // clocks whose `now` a spy answers without a real read
}
const real = (): ClockState => ({ installed: false, timers: 0, dateMock: false, spies: 0 });
const stillIn = (s: ClockState): number => (s.installed ? s.timers : 0) | (s.dateMock ? DATE : 0) | s.spies;

interface ClockEvent {
  pos: number;
  apply(s: ClockState): void;
}
const TO_REAL = (s: ClockState): void => void Object.assign(s, real());

/** Taint and fake-clock reading for one program; every answer is kept per node or symbol. */
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
    if (clockRead(n)) return true;
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
      return writesOf(symbol, n).length === 0 && bare(decl.initializer, seen);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Fake clocks
  // -------------------------------------------------------------------------

  /** The clock whose `now` `vi.spyOn(obj, "now")` replaces, as a bit. */
  function spiedClock(call: ts.CallExpression): number {
    if (!isVi(call, "spyOn")) return 0;
    const [obj, method] = call.arguments;
    if (!obj || !method || !ts.isStringLiteralLike(method) || method.text !== "now") return 0;
    return isClockObject(obj, "Date") ? DATE : isClockObject(obj, "performance") ? PERF : 0;
  }

  /** The calls of a chain `a(…).b(…).c(…)`, first one first. */
  function chain(expr: ts.Expression): ts.CallExpression[] {
    let e = strip(expr);
    if (ts.isAwaitExpression(e)) e = strip(e.expression);
    const calls: ts.CallExpression[] = [];
    while (ts.isCallExpression(e)) {
      calls.unshift(e);
      const callee = strip(e.expression);
      if (!ts.isPropertyAccessExpression(callee)) break;
      e = strip(callee.expression);
    }
    return calls;
  }

  /** A name declared with a spy on a clock's `now` (`const spy = vi.spyOn(Date, "now")`), as the clock's bit. */
  function spyName(e: ts.Expression): number {
    const n = strip(e);
    if (!ts.isIdentifier(n)) return 0;
    const decl = declarationOf(n);
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return 0;
    return chain(decl.initializer).reduce((m, c) => m | spiedClock(c), 0);
  }

  /** A clock call the analysis cannot place as a freeze: what it does to the state when it runs. */
  function clockCall(call: ts.CallExpression): ((s: ClockState) => void) | undefined {
    if (isVi(call, "useRealTimers")) return TO_REAL;
    if (isVi(call, "setTimerTickMode")) {
      const [mode] = call.arguments;
      if (mode && ts.isStringLiteralLike(mode) && mode.text === "manual") return undefined;
      return (s) => void (s.timers = 0); // the fake clock now moves by itself
    }
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee) && MOCK_RESETS.has(callee.name.text)) {
      return (s) => void (s.spies = 0);
    }
    if (isVi(call, "useFakeTimers") || isVi(call, "setSystemTime") || spiedClock(call)) return TO_REAL;
    if (ts.isPropertyAccessExpression(callee) && SPY_METHODS.test(callee.name.text) && spyName(callee.expression)) return TO_REAL;
    return undefined;
  }

  /** What a `vi.useFakeTimers(opts)` holds still, or undefined when the options cannot be read. */
  function fakeTimersFreeze(call: ts.CallExpression): number | undefined {
    const [opts] = call.arguments;
    if (!opts) return FAKED_BY_DEFAULT;
    if (!ts.isObjectLiteralExpression(opts)) return undefined;
    let faked = FAKED_BY_DEFAULT;
    for (const p of opts.properties) {
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return undefined;
      const name = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
      if (name === undefined) return undefined;
      const value = ts.isPropertyAssignment(p) ? strip(p.initializer) : p.name;
      if (name === "shouldAdvanceTime") {
        if (value.kind !== ts.SyntaxKind.FalseKeyword) return 0; // the fake clock moves with real time
      } else if (name === "toFake") {
        if (!ts.isArrayLiteralExpression(value)) return undefined;
        faked = 0;
        for (const el of value.elements) {
          if (!ts.isStringLiteralLike(el)) return undefined;
          faked |= TO_FAKE[el.text] ?? 0;
        }
      }
    }
    return faked;
  }

  /**
   * A statement (or an arrow's expression body) that freezes a clock when it
   * runs: `vi.useFakeTimers(…)`, `vi.setSystemTime(…)`, or a spy on a clock's
   * `now` given a fixed answer. Undefined when it is not one, or when any link
   * of its chain does something the analysis does not follow.
   */
  function freezeOf(node: ts.Node): { calls: ts.CallExpression[]; apply(s: ClockState): void } | undefined {
    const exprs = ts.isExpressionStatement(node)
      ? [node.expression]
      : ts.isVariableStatement(node)
        ? node.declarationList.declarations.flatMap((d) => (d.initializer ? [d.initializer] : []))
        : ts.isExpression(node)
          ? [node]
          : [];
    if (exprs.length !== 1) return undefined;
    const calls = chain(exprs[0]!);
    if (calls.length === 0) return undefined;
    const steps: ((s: ClockState) => void)[] = [];
    let spied = 0;
    for (const [i, call] of calls.entries()) {
      const callee = call.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      const onVi = isVi(call, method) || (i > 0 && steps.length > 0 && !spied); // vi.useFakeTimers() returns vi
      if (onVi && method === "useFakeTimers") {
        const still = fakeTimersFreeze(call);
        if (still === undefined) return undefined;
        steps.push((s) => Object.assign(s, { installed: true, timers: still, dateMock: false }));
      } else if (onVi && method === "setSystemTime") {
        steps.push((s) => {
          if (!s.installed) s.dateMock = true;
        });
      } else if (spiedClock(call)) {
        spied = spiedClock(call);
      } else if (SPY_FREEZES.has(method) && (spied || (i === 0 && spyName((callee as ts.PropertyAccessExpression).expression)))) {
        const clock = spied || spyName((callee as ts.PropertyAccessExpression).expression);
        const impl = call.arguments[0];
        if (method === "mockImplementation" && !fixedAnswer(impl)) return undefined;
        steps.push((s) => void (s.spies |= clock));
        spied = 0;
      } else return undefined;
    }
    if (steps.length === 0 || spied) return undefined;
    return { calls, apply: (s) => steps.forEach((step) => step(s)) };
  }

  /** An implementation that makes no call, so it cannot reach a real clock: `() => now`. */
  function fixedAnswer(impl: ts.Expression | undefined): boolean {
    if (!impl) return false;
    const fn = strip(impl);
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
    let calls = false;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) calls = true;
      else ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return !calls;
  }

  /** Whether a function the file declares reaches a clock call, through the file's functions. */
  const helperCache = new Map<ts.Node, boolean>();
  function helperTouchesClock(call: ts.CallExpression): boolean {
    const fn = declaredFunction(call.expression);
    if (!fn?.body) return false;
    const known = helperCache.get(fn);
    if (known !== undefined) return known;
    helperCache.set(fn, false);
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n) && (clockCall(n) || helperTouchesClock(n))) hit = true;
      else ts.forEachChild(n, visit);
    };
    visit(fn.body);
    helperCache.set(fn, hit);
    return hit;
  }

  /**
   * The clock events of one region: freezes from the statements that run for
   * sure, and every other clock call (or call of a file function that makes
   * one) as what it does, at its position. Framing callbacks inside the region
   * are skipped when `skipFraming` is set: they are regions of their own.
   */
  function regionEvents(root: ts.Node, sure: readonly ts.Node[], skipFraming: boolean): ClockEvent[] {
    const events: ClockEvent[] = [];
    const placed = new Set<ts.CallExpression>();
    for (const st of sure) {
      const f = freezeOf(st);
      if (!f) continue;
      f.calls.forEach((c) => placed.add(c));
      events.push({ pos: st.getEnd(), apply: f.apply });
    }
    const visit = (n: ts.Node): void => {
      if (skipFraming && n !== root && structural(n)) return;
      if (ts.isCallExpression(n) && !placed.has(n)) {
        const effect = clockCall(n) ?? (helperTouchesClock(n) ? TO_REAL : undefined);
        if (effect) events.push({ pos: n.getStart(), apply: effect });
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
    return events.sort((a, b) => a.pos - b.pos);
  }

  const statementsOf = (fn: ts.Node): readonly ts.Node[] => {
    if (ts.isSourceFile(fn)) return fn.statements;
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return [];
    return ts.isBlock(fn.body) ? fn.body.statements : [fn.body];
  };

  /** The top-level hooks `hook(fn)` of a scope (the file or a describe callback), their callbacks in order. */
  const hooksOf = (scope: ts.Node, hook: string): ts.Node[] =>
    statementsOf(scope).flatMap((st) => {
      if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression) || headOf(st.expression) !== hook) return [];
      return st.expression.arguments.filter((a) => structural(a) === hook);
    });

  /**
   * The clocks still (frozen) when `assertion` runs, as bits, following what
   * runs before it in vitest's order:
   *
   * 1. collection: the plain statements of the file and of each enclosing
   *    `describe`, in source order;
   * 2. the top-level `beforeAll` hooks of the enclosing scopes, outer first;
   *    a freeze from 1 or 2 is held for every test, so any clock call
   *    anywhere else in the file (another test, an `afterEach`, a hook that is
   *    not a top-level statement of an enclosing scope) voids it;
   * 3. the top-level `beforeEach` hooks of the enclosing scopes, outer first;
   * 4. the test body before the assertion, or all of it when the assertion is
   *    in a loop or a callback, whose order the analysis does not know.
   *
   * A freeze counts only from a statement that runs for sure (a top-level
   * statement of a hook or scope, or of a block around the assertion). Every
   * other clock call, a call of a file function that makes one, and a freeze
   * whose options cannot be read, voids what it may undo. An assertion outside
   * an `it`/`test` is not under any proven freeze.
   */
  function frozenAt(assertion: ts.Node): number {
    let testFn: ts.Node | undefined;
    let loose = false;
    const scopes: ts.Node[] = [assertion.getSourceFile()];
    const path: ts.Node[] = [];
    for (let n: ts.Node | undefined = assertion; n; n = n.parent) {
      const s = structural(n);
      if (!testFn) {
        path.push(n);
        if (s === "it" || s === "test") testFn = n;
        else if (s) return 0;
        else if (n !== assertion && (ts.isFunctionLike(n) || ts.isIterationStatement(n, false))) loose = true;
      } else if (s === "describe") scopes.splice(1, 0, n);
      else if (s) return 0;
    }
    if (!testFn) return 0;
    const enclosing = new Set(scopes);
    const state = real();
    const run = (events: readonly ClockEvent[]): void => events.forEach((e) => e.apply(state));

    run(scopes.flatMap((scope) => regionEvents(scope, statementsOf(scope), true)).sort((a, b) => a.pos - b.pos));
    for (const scope of scopes) for (const fn of hooksOf(scope, "beforeAll")) run(regionEvents(fn, statementsOf(fn), false));

    /** Whether a clock event at `n` runs in one of the regions above, or after the test. */
    const placedHere = (n: ts.Node): boolean => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        const s = structural(p);
        if (!s) continue;
        if (p === testFn) return true;
        if (s === "it" || s === "test") return false;
        if (s === "describe") return enclosing.has(p);
        const owner = p.parent.parent?.parent; // hook(fn) → ExpressionStatement → Block | SourceFile
        const scope = owner && (ts.isSourceFile(owner) ? owner : owner.parent);
        const topLevel = ts.isExpressionStatement(p.parent.parent!) && scope !== undefined && enclosing.has(scope);
        return topLevel && s !== "afterEach";
      }
      return true;
    };
    let elsewhere = false;
    const sweep = (n: ts.Node): void => {
      if (elsewhere) return;
      if (ts.isCallExpression(n) && (clockCall(n) || helperTouchesClock(n)) && !placedHere(n)) elsewhere = true;
      else ts.forEachChild(n, sweep);
    };
    sweep(assertion.getSourceFile());
    if (elsewhere) TO_REAL(state);

    for (const scope of scopes) for (const fn of hooksOf(scope, "beforeEach")) run(regionEvents(fn, statementsOf(fn), false));

    const sure: ts.Node[] = [];
    for (let i = path.length - 1; i > 0; i--) {
      const block = path[i]!;
      const child = path[i - 1]!;
      const statements = ts.isBlock(block) || ts.isSourceFile(block) ? block.statements : undefined;
      if (statements) sure.push(...statements.slice(0, statements.indexOf(child as ts.Statement)));
    }
    const limit = assertion.getStart();
    const body = (testFn as ts.ArrowFunction | ts.FunctionExpression).body;
    run(regionEvents(body, sure, false).filter((e) => loose || e.pos <= limit));
    return stillIn(state);
  }

  return { tainted, bare, frozenAt };
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
  const { tainted, bare, frozenAt } = analysis(checker);
  const found: Bound[] = [];
  for (const file of texts.keys()) {
    const sf = checker.sourceOf(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const e = expectTarget(node);
        const bound = node.arguments[0];
        if (e && ORDERING.has(e.matcher)) {
          const inTarget = tainted(e.target);
          const inBound = bound !== undefined ? tainted(bound) : 0;
          const clocks = inTarget | inBound;
          const order = inTarget !== 0 && inBound !== 0 && bare(e.target) && bare(bound!);
          if (clocks && !order && (clocks & ~frozenAt(node)) !== 0) {
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
