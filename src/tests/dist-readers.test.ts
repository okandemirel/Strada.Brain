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
 * is join), and an import of a relative specifier counts too. A path whose end
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Every path the source builds that lands at or below `root`/dist, with
 * `root` standing for process.cwd(). `file` is where the source sits.
 */
function pathsIntoDist(file: string, source: string, root: string): Hit[] {
  const { sf, checker } = parse(file, source);
  const dist = path.join(root, "dist");
  const following = new Set<ts.Node>();

  /**
   * The module an imported name came from and the name it has there: "node:path"
   * and `join` for `joinPath` in `import { join as joinPath } from "node:path"`.
   */
  const imported = (id: ts.Identifier): { from: string; name: string } | undefined => {
    const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
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

  const nameValue = (id: ts.Identifier): Value => {
    const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) {
      if (following.has(decl)) return undefined;
      following.add(decl);
      try {
        return value(decl.initializer);
      } finally {
        following.delete(decl);
      }
    }
    if (decl) return undefined;
    if (id.text === "__dirname") return path.dirname(file);
    if (id.text === "__filename") return file;
    return undefined;
  };

  const whole = (v: Value): string | undefined => (typeof v === "string" ? v : undefined);

  const propertyValue = (n: ts.PropertyAccessExpression): Value => {
    if (ts.isMetaProperty(n.expression) && n.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      if (n.name.text === "url") return pathToFileURL(file).href;
      if (n.name.text === "dirname") return path.dirname(file);
      if (n.name.text === "filename") return file;
      return undefined;
    }
    if (n.name.text === "href") return whole(value(n.expression));
    if (n.name.text === "pathname") return asPath(whole(value(n.expression)));
    return undefined;
  };

  const callValue = (n: ts.CallExpression): Value => {
    const fn = callee(n.expression);
    if (!fn) return undefined;
    if (PROCESS.has(fn.from) && fn.name === "cwd") return root;
    // A spread (`...parts`) is not a value here, so it counts as a run-time part.
    const parts = n.arguments.map(value);
    if (PATH_MODULES.has(fn.from) && (fn.name === "join" || fn.name === "resolve")) {
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
    const spec = value(n.arguments[0]);
    const base = n.arguments[1] === undefined ? undefined : whole(value(n.arguments[1]));
    if (spec === undefined || (n.arguments[1] !== undefined && base === undefined)) return undefined;
    try {
      if (typeof spec === "string") return new URL(spec, base).href;
      // A spec whose end comes at run time resolves by its whole segments, as a
      // join does: new URL(`../dist/${name}`, import.meta.url) is open after "…/dist/".
      return { open: new URL(settled(spec), base).href };
    } catch {
      return undefined;
    }
  };

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

  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    let target: { at: string; open: boolean } | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      target = place(node.moduleSpecifier.text, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      target = place(value(node.arguments[0]), true);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) {
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
  visit(sf);
  return hits;
}

/** The test files under `root` that build a path into its dist/, and those of them the gate cannot see. */
function scan(root: string): { readers: string[]; unmarked: string[] } {
  const readers: string[] = [];
  const unmarked: string[] = [];
  for (const rel of distBuild.testFiles(root)) {
    const source = readFileSync(path.join(root, rel), "utf8");
    // Every path into dist/ spells the word somewhere; the rest need no parse.
    if (!/\bdist\b/.test(source)) continue;
    const [first] = pathsIntoDist(path.join(root, rel), source, root);
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

describe("a test that reads the repository's dist/ says so (docs/contracts/dist-readers.md)", () => {
  it("every test file that builds a path into dist/ fails asking for npm run build, so the build gate picks it", () => {
    const { unmarked } = scan(REPO);
    expect(
      unmarked,
      "These tests build a path into dist/ and never fail asking for `npm run build`, so scripts/ci/dist-build.mjs " +
        "never builds dist/ for them and a fresh worktree shows them red. Check the path before the read, failing with " +
        `"<path> is missing: ${MESSAGE.replace(/\\`/g, "`")}", or build the dist/ the test needs in its own temp folder.`,
    ).toEqual([]);
  });

  it("finds today's readers by the paths they build, and not the tests that set up a dist/ of their own", () => {
    const { readers } = scan(REPO);
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
  });

  it("turns red on a new test that reads dist/ without the message, and not on one with it or one with its own dist/", () => {
    const root = tempRoot();
    const write = (rel: string, body: string): void => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), IMPORTS + body, "utf8");
    };
    write("src/new-reader.test.ts", 'const cli = join(process.cwd(), "dist", "core", "tool.js");\n');
    write(
      "src/said-reader.test.ts",
      'const cli = join(process.cwd(), "dist", "core", "tool.js");\n' +
        `expect(existsSync(cli), \`\${cli} is missing: ${MESSAGE}\`).toBe(true);\n`,
    );
    write("tests/own-dist.test.ts", 'const root = mkdtempSync("own-");\nconst cli = join(root, "dist", "core", "tool.js");\n');
    expect(scan(root)).toEqual({
      readers: ["src/new-reader.test.ts", "src/said-reader.test.ts"],
      unmarked: ["src/new-reader.test.ts:3 builds dist/core/tool.js"],
    });
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
    ["a dist/ path in a command string", "src/a.test.ts", 'const command = "node dist/index.js start --channel web";'],
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
