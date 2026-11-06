/**
 * Detector for docs/contracts/dist-readers.md, rule dist-reader-says-so.
 *
 * The "build dist/" gate (scripts/ci/dist-build.mjs) builds dist/ before the
 * tests only for a test that says it reads the build: its failure message asks
 * for `npm run build` (READS_BUILD). Until this file that was a habit with
 * nothing behind it. A new test that read dist/ under any other message would
 * never make the gate build, and in a fresh worktree, which has no dist/, it
 * would come up red for every agent whose change selected it: the false red
 * the gate was made to end.
 *
 * What counts as reading dist/ here: a path the test file builds that lands in
 * the repository's own dist/. Each file is parsed with TypeScript and its path
 * expressions are worked out from their parts. process.cwd() is the
 * repository root, as vitest runs here. import.meta.url, import.meta.dirname
 * and __dirname are the test file's own place. path.join, path.resolve,
 * path.dirname, fileURLToPath, new URL(…), .pathname, template strings, `+`
 * and the const a name was declared with (in its own scope) are followed; an
 * imported function is judged by its name in its module (`join as joinPath`
 * is join). A name imported from a relative module is worked out in that
 * module, from its own place: REPO_ROOT from ../helpers/local-fixtures.js is
 * the root its `export const` climbs to (re-exports, `export *`, a namespace
 * import and a default export are followed too), and it counts where the test
 * uses it as it is: existsSync(BUILT_CLI), [paths.BUILT_CLI]. An import,
 * import(), vi.importActual, vi.importMock or import.meta.resolve of a
 * relative specifier counts. A path whose end
 * comes at run time counts by its known start, up to its last whole segment:
 * join(repoRoot, "dist", name), `${repoRoot}/dist/${name}` and
 * new URL(`../dist/${name}`, import.meta.url) land in dist/ whatever name is.
 * A test that builds a dist/ in its own temp folder points
 * somewhere else and is not a reader.
 *
 * The message is assembled below and never written out whole: this file names
 * dist/ paths in its fixtures, and with the message in it the gate would build
 * dist/ every time the detectors run.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { isAtOrInside } from "../common/path-containment.js";

interface DistBuildModule {
  READS_BUILD: RegExp;
  testFiles(root: string): string[];
}

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distBuild = (await import(pathToFileURL(path.join(REPO, "scripts", "ci", "dist-build.mjs")).href)) as DistBuildModule;

/** The failure message the gate looks for, as a reader's source holds it inside a template literal. */
const MESSAGE = ["run \\`npm run build\\`", "before this test"].join(" ");

const PATH_MODULES = new Set(["path", "node:path"]);
const URL_MODULES = new Set(["url", "node:url"]);
const PROCESS = new Set(["process", "node:process"]);

/** A path in dist/ the file builds: the line it is on and where it lands, relative to the root. */
interface Hit {
  line: number;
  target: string;
}

/** One file as a program of its own, so a name resolves to the declaration in its scope. */
function parse(file: string, source: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (path.resolve(name) === path.resolve(file) ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => path.dirname(file),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => path.resolve(name) === path.resolve(file),
    readFile: () => undefined,
  };
  const program = ts.createProgram([file], { noLib: true, noResolve: true, types: [] }, host);
  return { sf, checker: program.getTypeChecker() };
}

function unwrap(node: ts.Expression): ts.Expression {
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

/**
 * A value whose start is known and whose rest comes only at run time:
 * `${repoRoot}/dist/${name}` is open after "<root>/dist/".
 */
interface Open {
  open: string;
}

/** What an expression comes to: the whole of it, its known start, or nothing. */
type Value = string | Open | undefined;

/**
 * The whole segments an open value starts with, up to its last separator:
 * "<root>/dist/" of `${root}/dist/${name}`, but "<root>/" of `${root}/dist${suffix}`,
 * whose run-time part may go on with the segment ("dist-old").
 */
function settled(value: Open | undefined): string {
  return value?.open.match(/^[\s\S]*[\\/]/)?.[0] ?? "";
}

/** A file URL as a path, an absolute path as itself, anything else as nothing. */
function asPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(value) ? value : undefined;
}

function isFile(at: string): boolean {
  try {
    return statSync(at).isFile();
  } catch {
    return false;
  }
}

/**
 * The source file a relative specifier names, as the sources hold it:
 * "./root.js" is ./root.ts. A package name names no file here.
 */
function relativeModule(from: string, specifier: string): string | undefined {
  if (!/^\.\.?\//.test(specifier)) return undefined;
  const at = path.resolve(path.dirname(from), specifier);
  return [at.replace(/\.(m?)js$/, ".$1ts"), at].find(isFile);
}

/** A module read for the paths into dist/ it builds and for what its exports come to. */
interface Module {
  hits(): Hit[];
  exported(name: string): Value;
}

/** The modules one scan has read, by file: a helper that many tests import is parsed once. */
type Modules = Map<string, Module>;

function moduleAt(file: string, root: string, modules: Modules): Module {
  let found = modules.get(file);
  if (!found) {
    found = reader(file, readFileSync(file, "utf8"), root, modules);
    modules.set(file, found);
  }
  return found;
}

/**
 * Every path the source builds that lands at or below `root`/dist, with
 * `root` standing for process.cwd(). `file` is where the source sits.
 */
function pathsIntoDist(file: string, source: string, root: string, modules: Modules = new Map()): Hit[] {
  const found = reader(file, source, root, modules);
  modules.set(file, found);
  return found.hits();
}

/**
 * One module of a scan. A name it imports from a relative module is worked
 * out in that module, from that module's own place: REPO_ROOT in
 * `import { REPO_ROOT } from "../helpers/local-fixtures.js"` is the
 * `export const` there, with its import.meta.url.
 */
function reader(file: string, source: string, root: string, modules: Modules): Module {
  const { sf, checker } = parse(file, source);
  const dist = path.join(root, "dist");
  const following = new Set<ts.Node>();
  const exporting = new Set<string>();

  /** What export `name` of the module `specifier` names comes to; nothing for a package. */
  const foreign = (specifier: string, name: string): Value => {
    const target = relativeModule(file, specifier);
    return target === undefined ? undefined : moduleAt(target, root, modules).exported(name);
  };

  /**
   * The module an imported name came from and the name it has there: "node:path"
   * and `join` for `joinPath` in `import { join as joinPath } from "node:path"`.
   */
  const importOf = (decl: ts.Declaration | undefined): { from: string; name: string } | undefined => {
    if (!decl) return undefined;
    const [statement, name] = ts.isImportSpecifier(decl)
      ? [decl.parent.parent.parent, (decl.propertyName ?? decl.name).text]
      : ts.isNamespaceImport(decl)
        ? [decl.parent.parent, "*"]
        : ts.isImportClause(decl)
          ? [decl.parent, "default"]
          : [undefined, ""];
    return statement && ts.isStringLiteral(statement.moduleSpecifier) ? { from: statement.moduleSpecifier.text, name } : undefined;
  };

  const imported = (id: ts.Identifier): { from: string; name: string } | undefined =>
    importOf(checker.getSymbolAtLocation(id)?.declarations?.[0]);

  /** `join` from "node:path" for `join(…)`, `path.join(…)` and `path.posix.join(…)`; `cwd` from "process" for process.cwd(). */
  const callee = (expr: ts.Expression): { from: string; name: string } | undefined => {
    if (ts.isIdentifier(expr)) return imported(expr);
    if (!ts.isPropertyAccessExpression(expr)) return undefined;
    let owner = expr.expression;
    if (ts.isPropertyAccessExpression(owner) && owner.name.text === "posix") owner = owner.expression;
    if (!ts.isIdentifier(owner)) return undefined;
    const from = imported(owner)?.from;
    if (from !== undefined) return { from, name: expr.name.text };
    // A global such as `process`; a local that only shares the name is not the module.
    return checker.getSymbolAtLocation(owner) ? undefined : { from: owner.text, name: expr.name.text };
  };

  /** What a declaration comes to: a const by its initializer, an imported name by its export in a relative module. */
  const declValue = (decl: ts.Declaration | undefined): Value => {
    if (decl && ts.isVariableDeclaration(decl)) {
      if (!decl.initializer || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) || following.has(decl)) return undefined;
      following.add(decl);
      try {
        return value(decl.initializer);
      } finally {
        following.delete(decl);
      }
    }
    const from = importOf(decl);
    return from === undefined || from.name === "*" ? undefined : foreign(from.from, from.name);
  };

  const nameValue = (id: ts.Identifier): Value => {
    const symbol = checker.getSymbolAtLocation(id);
    // An imported name has no value declaration in this file, only its import.
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (decl) return declValue(decl);
    if (id.text === "__dirname") return path.dirname(file);
    if (id.text === "__filename") return file;
    return undefined;
  };

  /**
   * What the module's export `name` comes to: an exported const, a name it
   * exports or re-exports under that name (`export * from` too), or its default.
   */
  const exported = (name: string): Value => {
    if (exporting.has(name)) return undefined;
    exporting.add(name);
    try {
      const stars: string[] = [];
      for (const statement of sf.statements) {
        if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          const decl = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
          if (decl) return declValue(decl);
        } else if (name === "default" && ts.isExportAssignment(statement) && !statement.isExportEquals) {
          return value(statement.expression);
        } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
          const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
          const clause = statement.exportClause;
          if (clause === undefined) {
            if (from !== undefined) stars.push(from);
            continue;
          }
          const spec = ts.isNamedExports(clause) ? clause.elements.find((e) => e.name.text === name) : undefined;
          if (!spec) continue;
          if (from !== undefined) return foreign(from, (spec.propertyName ?? spec.name).text);
          const local = checker.getExportSpecifierLocalTargetSymbol(spec);
          return declValue(local?.valueDeclaration ?? local?.declarations?.[0]);
        }
      }
      // `export *` never carries a default.
      for (const from of name === "default" ? [] : stars) {
        const found = foreign(from, name);
        if (found !== undefined) return found;
      }
      return undefined;
    } finally {
      exporting.delete(name);
    }
  };

  const whole = (v: Value): string | undefined => (typeof v === "string" ? v : undefined);

  const isImportMeta = (expr: ts.Expression): expr is ts.MetaProperty =>
    ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.ImportKeyword;

  const propertyValue = (n: ts.PropertyAccessExpression): Value => {
    if (isImportMeta(n.expression)) {
      if (n.name.text === "url") return pathToFileURL(file).href;
      if (n.name.text === "dirname") return path.dirname(file);
      if (n.name.text === "filename") return file;
      return undefined;
    }
    // A namespace import of a relative module: fixtures.REPO_ROOT is that module's REPO_ROOT.
    if (ts.isIdentifier(n.expression)) {
      const from = imported(n.expression);
      if (from?.name === "*") return foreign(from.from, n.name.text);
    }
    if (n.name.text === "href") return whole(value(n.expression));
    if (n.name.text === "pathname") return asPath(whole(value(n.expression)));
    return undefined;
  };

  const callValue = (n: ts.CallExpression): Value => {
    if (ts.isPropertyAccessExpression(n.expression) && isImportMeta(n.expression.expression) && n.expression.name.text === "resolve") {
      const spec = n.arguments[0] === undefined ? undefined : value(n.arguments[0]);
      // A relative or absolute specifier resolves from the test file, as new URL(…, import.meta.url)
      // does; a package name or an import-map alias goes through resolution this check does not run.
      const text = typeof spec === "string" ? spec : settled(spec);
      return /^(\.\.?\/|\/|file:)/.test(text) ? resolveUrl(spec, pathToFileURL(file).href) : undefined;
    }
    const fn = callee(n.expression);
    if (!fn) return undefined;
    if (PROCESS.has(fn.from) && fn.name === "cwd") return root;
    const joins = PATH_MODULES.has(fn.from) && (fn.name === "join" || fn.name === "resolve");
    const takesOne =
      (PATH_MODULES.has(fn.from) && (fn.name === "dirname" || fn.name === "normalize")) ||
      (URL_MODULES.has(fn.from) && fn.name === "fileURLToPath");
    // Only a path function's result is a path; the arguments of any other call
    // are visited on their own.
    if (!joins && !takesOne) return undefined;
    // A spread (`...parts`) is not a value here, so it counts as a run-time part.
    const parts = n.arguments.map(value);
    if (joins) {
      // A relative resolve() starts from the working directory, which is the root.
      const build = (args: string[]): string => (fn.name === "join" ? path.join(...args) : path.resolve(root, ...args));
      const runTime = parts.findIndex((part) => typeof part !== "string");
      if (runTime === -1) return build(parts as string[]);
      // The parts before the first run-time one fix where the path starts:
      // join(repoRoot, "dist", name) is under dist/ whatever name is.
      const known = parts.slice(0, runTime) as string[];
      return { open: path.join(build([...known, settled(parts[runTime] as Open | undefined)]), "/") };
    }
    const args = parts.map(whole);
    if (args.some((arg) => arg === undefined)) return undefined;
    const [first] = args;
    if (first === undefined) return undefined;
    if (PATH_MODULES.has(fn.from)) {
      if (fn.name === "dirname") return path.dirname(first);
      if (fn.name === "normalize") return path.normalize(first);
    }
    if (URL_MODULES.has(fn.from) && fn.name === "fileURLToPath") return first.startsWith("file:") ? asPath(first) : undefined;
    return undefined;
  };

  const urlValue = (n: ts.NewExpression): Value => {
    if (!ts.isIdentifier(n.expression) || n.expression.text !== "URL" || !n.arguments?.[0]) return undefined;
    const base = n.arguments[1] === undefined ? undefined : whole(value(n.arguments[1]));
    if (n.arguments[1] !== undefined && base === undefined) return undefined;
    return resolveUrl(value(n.arguments[0]), base);
  };

  /** The URL `spec` names against `base`, as new URL(spec, base) gives it. */
  function resolveUrl(spec: Value, base: string | undefined): Value {
    if (spec === undefined) return undefined;
    try {
      if (typeof spec === "string") return new URL(spec, base).href;
      // A spec whose end comes at run time resolves by its whole segments, as a
      // join does: new URL(`../dist/${name}`, import.meta.url) is open after "…/dist/".
      return { open: new URL(settled(spec), base).href };
    } catch {
      return undefined;
    }
  }

  /**
   * What a string- or path-valued expression comes to: the whole of it when
   * every part is known, its start when only its end comes at run time.
   */
  function value(node: ts.Expression): Value {
    const n = unwrap(node);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      let text = n.head.text;
      for (const span of n.templateSpans) {
        const part = value(span.expression);
        if (typeof part !== "string") return { open: text + (part?.open ?? "") };
        text += part + span.literal.text;
      }
      return text;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(n.left);
      if (typeof left !== "string") return left;
      const right = value(n.right);
      return typeof right === "string" ? left + right : { open: left + (right?.open ?? "") };
    }
    if (ts.isIdentifier(n)) return nameValue(n);
    if (ts.isPropertyAccessExpression(n)) return propertyValue(n);
    if (ts.isNewExpression(n)) return urlValue(n);
    if (ts.isCallExpression(n)) return callValue(n);
    return undefined;
  }

  /**
   * Where a value lands on disk, an open one by the whole segments it starts
   * with. `specifier` reads it as an import does: relative to the test file.
   */
  const place = (v: Value, specifier = false): { at: string; open: boolean } | undefined => {
    if (v === undefined) return undefined;
    const open = typeof v !== "string";
    const text = open ? settled(v) : v;
    const at = specifier && /^\.\.?\//.test(text) ? path.resolve(path.dirname(file), text) : asPath(text);
    return at === undefined ? undefined : { at, open };
  };

  /** vi.importActual(…) and vi.importMock(…) load the module they name, as import() does. */
  const loadsModule = (expr: ts.Expression): boolean => {
    const fn = callee(expr);
    return (fn?.from === "vitest" || fn?.from === "vi") && (fn.name === "importActual" || fn.name === "importMock");
  };

  /** The names the file's imports bind. */
  const importedNames = new Set<string>();
  for (const statement of sf.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause?.name) importedNames.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) importedNames.add(bindings.name.text);
    else if (bindings) for (const element of bindings.elements) importedNames.add(element.name.text);
  }

  /**
   * A name the file imports, or a member of a namespace it imports, where it
   * stands for its value: BUILT_CLI in existsSync(BUILT_CLI), paths.BUILT_CLI
   * in [paths.BUILT_CLI]. A helper's const is visited in the helper, so the
   * test that uses it as it is would otherwise build nothing of its own.
   */
  const usesImport = (node: ts.Node): node is ts.Identifier | ts.PropertyAccessExpression => {
    const member = ts.isPropertyAccessExpression(node);
    const owner = member ? node.expression : node;
    // Only a name an import binds can resolve to one; putting every name to the checker adds seconds to a scan.
    if (!ts.isIdentifier(owner) || !importedNames.has(owner.text)) return false;
    // The name in the import itself, and a function being called, are no path.
    if (!member && (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent))) return false;
    if ((ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node) return false;
    const from = imported(owner);
    return from !== undefined && (member ? from.name === "*" : from.name !== "*");
  };

  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    // A type is gone at run time (an `extends` clause is not).
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    let target: { at: string; open: boolean } | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      target = place(node.moduleSpecifier.text, true);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || loadsModule(node.expression))
    ) {
      target = place(value(node.arguments[0]), true);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) {
      target = place(value(node));
    } else if (usesImport(node)) {
      target = place(value(node));
    }
    if (target !== undefined && isAtOrInside(dist, target.at)) {
      const rel = path.relative(root, target.at).split(path.sep).join("/");
      hits.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        // An open path is named by its known start: dist/core/… for join(root, "dist", "core", name).
        target: target.open ? `${rel}/…` : rel,
      });
    }
    ts.forEachChild(node, visit);
  };

  return {
    hits: () => {
      hits.length = 0;
      visit(sf);
      return [...hits];
    },
    exported,
  };
}

const SPELLS_DIST = /\bdist\b/;
const RELATIVE_FROM = /\bfrom\s*["'](\.\.?\/[^"']*)["']/g;

/** The test files under `root` that build a path into its dist/, and those of them the gate cannot see. */
function scan(root: string): { readers: string[]; unmarked: string[] } {
  const readers: string[] = [];
  const unmarked: string[] = [];
  const modules: Modules = new Map();
  const texts = new Map<string, string>();
  const text = (file: string): string => {
    const known = texts.get(file) ?? readFileSync(file, "utf8");
    texts.set(file, known);
    return known;
  };
  for (const rel of distBuild.testFiles(root)) {
    const file = path.join(root, rel);
    const source = text(file);
    // A path into dist/ spells the word in the test or in a module it imports
    // from; parsing every test file instead would take a full scan from
    // seconds to a quarter of a minute.
    const spells =
      SPELLS_DIST.test(source) ||
      [...source.matchAll(RELATIVE_FROM)].some(([, specifier]) => {
        const target = specifier === undefined ? undefined : relativeModule(file, specifier);
        return target !== undefined && SPELLS_DIST.test(text(target));
      });
    if (!spells) continue;
    const [first] = pathsIntoDist(file, source, root, modules);
    if (!first) continue;
    readers.push(rel);
    if (!distBuild.READS_BUILD.test(source)) unmarked.push(`${rel}:${first.line} builds ${first.target}`);
  }
  return { readers, unmarked };
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "strada-dist-readers-"));
  temps.push(root);
  return root;
}

const IMPORTS = 'import path, { join } from "node:path";\nimport { fileURLToPath } from "node:url";\n';

/** Writes each file under `root`, below the imports every fixture starts with. */
function writeAll(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), IMPORTS + body, "utf8");
  }
}

let repoScan: ReturnType<typeof scan> | undefined;
/** The repository's own scan, made once for the tests that read it. */
const scanRepo = (): ReturnType<typeof scan> => (repoScan ??= scan(REPO));
/**
 * The scan reads every test file and parses about 180 modules: 3-6 s measured
 * at load averages of 42-84, and longer still when many agents run the gates
 * at once, which leaves vitest's 30 s default little room. Vitest fails a
 * test that outlasts its limit even after it passes, which would be a false
 * red from the gate's own detector. Either test that reads the scan may be
 * the one to make it (`-t` picks one alone), so both carry the limit.
 */
const REPO_SCAN_TIMEOUT_MS = 120_000;

describe("a test that reads the repository's dist/ says so (docs/contracts/dist-readers.md)", () => {
  it("every test file that builds a path into dist/ fails asking for npm run build, so the build gate picks it", () => {
    const { unmarked } = scanRepo();
    expect(
      unmarked,
      "These tests build a path into dist/ and never fail asking for `npm run build`, so scripts/ci/dist-build.mjs " +
        "never builds dist/ for them and a fresh worktree shows them red. Check the path before the read, failing with " +
        `"<path> is missing: ${MESSAGE.replace(/\\`/g, "`")}", or build the dist/ the test needs in its own temp folder.`,
    ).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it("finds today's readers by the paths they build, and not the tests that set up a dist/ of their own", () => {
    const { readers } = scanRepo();
    expect(readers).toEqual(
      expect.arrayContaining([
        "src/tests/unit/live-verify-providers.test.ts",
        "src/tests/unit/live-verify-weights.test.ts",
        "src/tests/unit/restore-script.test.ts",
      ]),
    );
    for (const fixtureDist of ["src/tests/unit/backup-script.test.ts", "src/tests/integration/source-launcher.test.ts"]) {
      expect(readers).not.toContain(fixtureDist);
    }
  }, REPO_SCAN_TIMEOUT_MS);

  it("turns red on a new test that reads dist/ without the message, and not on one with it or one with its own dist/", () => {
    const root = tempRoot();
    writeAll(root, {
      "src/new-reader.test.ts": 'const cli = join(process.cwd(), "dist", "core", "tool.js");\n',
      "src/said-reader.test.ts":
        'const cli = join(process.cwd(), "dist", "core", "tool.js");\n' +
        `expect(existsSync(cli), \`\${cli} is missing: ${MESSAGE}\`).toBe(true);\n`,
      "tests/own-dist.test.ts": 'const root = mkdtempSync("own-");\nconst cli = join(root, "dist", "core", "tool.js");\n',
    });
    expect(scan(root)).toEqual({
      readers: ["src/new-reader.test.ts", "src/said-reader.test.ts"],
      unmarked: ["src/new-reader.test.ts:3 builds dist/core/tool.js"],
    });
  });

  it("turns red on a test that reads dist/ through a path its helper exports, though the test never spells the word", () => {
    const root = tempRoot();
    writeAll(root, {
      "src/helpers/paths.ts": 'export const BUILD = join(process.cwd(), "dist");\n',
      "src/via-helper.test.ts": 'import { BUILD } from "./helpers/paths.js";\nconst cli = join(BUILD, "core", "tool.js");\n',
    });
    expect(scan(root)).toEqual({
      readers: ["src/via-helper.test.ts"],
      unmarked: ["src/via-helper.test.ts:4 builds dist/core/tool.js"],
    });
  });

  it("turns red on a test that uses a helper's dist/ path as it is, though the test never spells the word", () => {
    const root = tempRoot();
    writeAll(root, {
      "src/helpers/paths.ts": 'export const CLI = join(process.cwd(), "dist", "index.js");\n',
      "src/bare.test.ts": 'import { CLI } from "./helpers/paths.js";\nexpect(existsSync(CLI)).toBe(true);\n',
      "src/namespace.test.ts": 'import * as paths from "./helpers/paths.js";\nexecFileSync(process.execPath, [paths.CLI, "--help"]);\n',
    });
    expect(scan(root)).toEqual({
      readers: ["src/bare.test.ts", "src/namespace.test.ts"],
      unmarked: ["src/bare.test.ts:4 builds dist/index.js", "src/namespace.test.ts:4 builds dist/index.js"],
    });
  });
});

describe("a name imported from another module of the repository", () => {
  const TEST = "src/tests/unit/a.test.ts";
  /** The dist/ targets the test file builds, with it and its helpers on disk under a temp root. */
  const targetsWith = (files: Record<string, string>): string[] => {
    const root = tempRoot();
    writeAll(root, files);
    return pathsIntoDist(path.join(root, TEST), IMPORTS + (files[TEST] ?? ""), root).map((hit) => hit.target);
  };
  const ROOT_TS = { "src/tests/root.ts": "export const ROOT = process.cwd();" };
  const BUILT_TS = {
    ...ROOT_TS,
    "src/tests/paths.ts": 'import { ROOT } from "./root.js";\nexport const BUILT = join(ROOT, "dist", "index.js");',
  };

  it.each<[string, Record<string, string>, string]>([
    ["a const root exported by a helper", { ...ROOT_TS, [TEST]: 'import { ROOT } from "../root.js";\njoin(ROOT, "dist", "x.js");' }, "dist/x.js"],
    [
      "a root the helper climbs to from its own import.meta.url, not the test's",
      {
        // Climbed from the test's place instead, "../../" would land in src/, not the root.
        "src/tests/fixtures.ts": 'export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));',
        [TEST]: 'import { REPO_ROOT } from "../fixtures.js";\nreadFileSync(join(REPO_ROOT, "dist", "index.js"));',
      },
      "dist/index.js",
    ],
    ["a namespace import", { ...ROOT_TS, [TEST]: 'import * as fixtures from "../root.js";\njoin(fixtures.ROOT, "dist", "x.js");' }, "dist/x.js"],
    [
      "a default export",
      { "src/tests/root.ts": "export default process.cwd();", [TEST]: 'import ROOT from "../root.js";\njoin(ROOT, "dist", "x.js");' },
      "dist/x.js",
    ],
    [
      "a name exported under another name, through export * and a renaming re-export",
      {
        "src/tests/root.ts": "const base = process.cwd();\nexport { base as ROOT };",
        "src/tests/barrel.ts": 'export * from "./root.js";',
        "src/tests/index.ts": 'export { ROOT as REPO } from "./barrel.js";',
        [TEST]: 'import { REPO } from "../index.js";\njoin(REPO, "dist", "x.js");',
      },
      "dist/x.js",
    ],
    [
      "a helper's const that imports its root in turn",
      {
        ...ROOT_TS,
        "src/tests/paths.ts": 'import { ROOT } from "./root.js";\nexport const BUILD = join(ROOT, "dist");',
        [TEST]: 'import { BUILD } from "../paths.js";\nexistsSync(join(BUILD, "index.js"));',
      },
      "dist/index.js",
    ],
    [
      "a helper's dist/ path the test uses as it is",
      { ...BUILT_TS, [TEST]: 'import { BUILT } from "../paths.js";\nexistsSync(BUILT);' },
      "dist/index.js",
    ],
    [
      "a helper's dist/ path the test uses as it is, through a namespace import",
      { ...BUILT_TS, [TEST]: 'import * as paths from "../paths.js";\nspawn(process.execPath, [paths.BUILT]);' },
      "dist/index.js",
    ],
    [
      "a helper's default export of a dist/ path, used as it is",
      {
        "src/tests/paths.ts": 'export default join(process.cwd(), "dist", "index.js");',
        [TEST]: 'import BUILT from "../paths.js";\nconst cli = BUILT;',
      },
      "dist/index.js",
    ],
  ])("%s", (_label, files, target) => {
    expect(targetsWith(files)).toContain(target);
  });

  it.each<[string, Record<string, string>]>([
    [
      "not a helper's temp folder",
      { "src/tests/root.ts": 'export const ROOT = mkdtempSync("x-");', [TEST]: 'import { ROOT } from "../root.js";\njoin(ROOT, "dist", "x.js");' },
    ],
    ["not a package's export", { [TEST]: 'import { ROOT } from "some-package";\njoin(ROOT, "dist", "x.js");' }],
    [
      "not a helper's temp dist/ the test uses as it is",
      {
        "src/tests/paths.ts": 'export const OWN = join(mkdtempSync("x-"), "dist");',
        [TEST]: 'import { OWN } from "../paths.js";\nimport * as paths from "../paths.js";\nexistsSync(OWN);\nexistsSync(paths.OWN);',
      },
    ],
    ["not a helper's dist/ path named only in a type", { ...BUILT_TS, [TEST]: 'import { BUILT } from "../paths.js";\nlet cli: typeof BUILT;' }],
    [
      "not a helper's root the test uses as it is",
      { ...ROOT_TS, [TEST]: 'import { ROOT } from "../root.js";\nimport * as fixtures from "../root.js";\nconst roots = [ROOT, fixtures.ROOT];' },
    ],
    [
      "not modules that import and re-export each other, and the scan ends",
      {
        "src/tests/one.ts": 'import { B } from "./two.js";\nexport const A = B;\nexport * from "./two.js";',
        "src/tests/two.ts": 'import { A } from "./one.js";\nexport const B = A;\nexport * from "./one.js";',
        [TEST]: 'import { A, C } from "../one.js";\njoin(A, "dist", "x.js");\njoin(C, "dist", "x.js");',
      },
    ],
  ])("%s", (_label, files) => {
    expect(targetsWith(files)).toEqual([]);
  });
});

describe("what counts as a path into dist/", () => {
  const ROOT = path.join(os.tmpdir(), "dist-readers-root");
  const targets = (rel: string, body: string): string[] =>
    pathsIntoDist(path.join(ROOT, rel), IMPORTS + body, ROOT).map((hit) => hit.target);

  it.each([
    ["process.cwd() joined with dist", "src/a.test.ts", 'path.join(process.cwd(), "dist", "core", "x.js");', "dist/core/x.js"],
    ["a const root taken from process.cwd()", "src/a.test.ts", 'const repoRoot = process.cwd();\njoin(repoRoot, "dist/index.js");', "dist/index.js"],
    [
      "a root climbed to from import.meta.url",
      "src/tests/unit/a.test.ts",
      'const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");\njoin(repoRoot, "dist", "x.js");',
      "dist/x.js",
    ],
    [
      "a root from new URL(…, import.meta.url)",
      "src/a.test.ts",
      'const REPO = fileURLToPath(new URL("..", import.meta.url));\njoin(REPO, "dist", "vault", "schema.sql");',
      "dist/vault/schema.sql",
    ],
    ["import.meta.dirname", "src/tests/a.test.ts", 'path.resolve(import.meta.dirname, "..", "..", "dist");', "dist"],
    ["a template string", "src/a.test.ts", "const root = process.cwd();\nconst cli = `${root}/dist/core/x.js`;", "dist/core/x.js"],
    ["string concatenation", "src/a.test.ts", 'const cli = process.cwd() + "/dist/core/x.js";', "dist/core/x.js"],
    ["a relative resolve(), from the working directory", "src/a.test.ts", 'path.resolve("dist", "index.js");', "dist/index.js"],
    ["a dynamic import of a relative specifier", "src/tests/unit/a.test.ts", 'await import("../../../dist/core/x.js");', "dist/core/x.js"],
    ["a static import of a relative specifier", "src/a.test.ts", 'import { x } from "../dist/core/x.js";', "dist/core/x.js"],
    ["vi.importActual of a relative specifier", "src/tests/unit/a.test.ts", 'await vi.importActual("../../../dist/core/x.js");', "dist/core/x.js"],
    [
      "vi.importMock, with vi imported from vitest",
      "src/tests/unit/a.test.ts",
      'import { vi } from "vitest";\nawait vi.importMock("../../../dist/core/x.js");',
      "dist/core/x.js",
    ],
    [
      "a path function imported under another name",
      "src/a.test.ts",
      'import { join as joinPath } from "node:path";\njoinPath(process.cwd(), "dist", "core", "x.js");',
      "dist/core/x.js",
    ],
    [
      "a loop over names under dist/",
      "src/a.test.ts",
      'for (const name of ["a.js", "b.js"]) existsSync(path.join(process.cwd(), "dist", name));',
      "dist/…",
    ],
    [
      "a helper's parameter under dist/",
      "src/a.test.ts",
      'const repoRoot = process.cwd();\nfunction entry(name: string) {\n  return path.join(repoRoot, "dist", name);\n}',
      "dist/…",
    ],
    [
      "the rest of the path spread in",
      "src/a.test.ts",
      'function at(...parts: string[]) {\n  return join(process.cwd(), "dist", "core", ...parts);\n}',
      "dist/core/…",
    ],
    [
      "a template string whose end comes at run time",
      "src/a.test.ts",
      'const repoRoot = process.cwd();\nit.each(["a.js"])("%s", (name) => readFileSync(`${repoRoot}/dist/${name}`));',
      "dist/…",
    ],
    [
      "string concatenation whose end comes at run time",
      "src/a.test.ts",
      'function f(name: string) {\n  return process.cwd() + "/dist/core/" + name;\n}',
      "dist/core/…",
    ],
    [
      "new URL(…, import.meta.url) whose end comes at run time",
      "src/tests/a.test.ts",
      "function f(name: string) {\n  return readFileSync(new URL(`../../dist/${name}`, import.meta.url));\n}",
      "dist/…",
    ],
    [
      "a module imported by name through new URL(…, import.meta.url).href",
      "src/tests/unit/a.test.ts",
      'it.each(["database-backup"])("%s", async (name) => {\n  await import(new URL(`../../../dist/core/${name}.js`, import.meta.url).href);\n});',
      "dist/core/…",
    ],
    [
      "import.meta.resolve of a relative specifier",
      "src/tests/unit/a.test.ts",
      'await import(import.meta.resolve("../../../dist/core/x.js"));',
      "dist/core/x.js",
    ],
    [
      "import.meta.resolve whose end comes at run time",
      "src/tests/unit/a.test.ts",
      "function f(name: string) {\n  return readFileSync(fileURLToPath(import.meta.resolve(`../../../dist/${name}.js`)));\n}",
      "dist/…",
    ],
  ])("%s", (_label, rel, body, target) => {
    expect(targets(rel, body)).toContain(target);
  });

  it.each([
    ["a dist/ in a temp folder", "src/a.test.ts", 'const root = mkdtempSync(join(tmpdir(), "x-"));\njoin(root, "dist", "index.js");'],
    ["the web portal's own dist/", "src/a.test.ts", 'join(process.cwd(), "web-portal", "dist", "index.html");'],
    ["a name that only begins with dist", "src/a.test.ts", 'join(process.cwd(), "distribution", "x.js");'],
    [
      "a climb that stops short of the root",
      "src/tests/unit/a.test.ts",
      'path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");',
    ],
    [
      "an inner name that shadows the root",
      "src/a.test.ts",
      'const root = process.cwd();\nfunction fixture() {\n  const root = mkdtempSync("x-");\n  return join(root, "dist");\n}',
    ],
    ["a resolve() imported from another module", "src/a.test.ts", 'import { resolve } from "./routes.js";\nresolve(process.cwd(), "dist");'],
    [
      "another path function imported under the name resolve",
      "src/a.test.ts",
      'import { relative as resolve } from "node:path";\nresolve(process.cwd(), "dist");',
    ],
    ["a local that is only named path", "src/a.test.ts", 'function f(path: { join(...p: string[]): string }) {\n  return path.join(process.cwd(), "dist");\n}'],
    [
      "a local vi's importActual",
      "src/tests/unit/a.test.ts",
      'const vi = { importActual: (s: string) => s };\nvi.importActual("../../../dist/core/x.js");',
    ],
    ["a dist/ path in a command string", "src/a.test.ts", 'const command = "node dist/index.js start --channel web";'],
    // Beside the root, "dist/index.js" read as a relative path would land in dist/; it names a package.
    ["import.meta.resolve of a package named dist", "a.test.ts", 'import.meta.resolve("dist/index.js");'],
    ["a run-time part before dist", "src/a.test.ts", 'function f(sub: string) {\n  return join(process.cwd(), sub, "dist", "x.js");\n}'],
    [
      "a template whose run-time part may go on with the dist segment",
      "src/a.test.ts",
      "const root = process.cwd();\nfunction f(suffix: string) {\n  return `${root}/dist${suffix}`;\n}",
    ],
    [
      "a join whose run-time part may go on with the dist segment",
      "src/a.test.ts",
      "function f(suffix: string) {\n  return join(process.cwd(), `dist${suffix}`, \"x.js\");\n}",
    ],
    [
      "a URL whose run-time part may go on with the dist segment",
      "src/tests/a.test.ts",
      "function f(suffix: string) {\n  return new URL(`../../dist${suffix}`, import.meta.url);\n}",
    ],
  ])("not %s", (_label, rel, body) => {
    expect(targets(rel, body)).toEqual([]);
  });
});
