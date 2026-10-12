// SEC-4: the specifiers a workspace skill's code loads must stay inside the
// skill directory, because the approval hash covers nothing else.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { findOutsideImports, findOutsidePackageTargets, isSkillCodeFile, specifierLeavesSkill } from "./skill-import-scan.js";

const root = join("/proj", "skills", "deploy");
const entry = join(root, "index.js");
const scan = (source: string, file = entry): string[] => findOutsideImports(root, file, source);

describe("findOutsideImports", () => {
  it("allows node built-ins and relative imports that stay inside the skill directory", () => {
    const source = [
      'import fs from "node:fs";',
      "import path from 'path';",
      'import { readFile } from "fs/promises";',
      'import { helper } from "./lib/helper.js";',
      'export * from "./lib/more.js";',
      'import "./side-effect.js";',
      'const lazy = await import("./lazy.js");',
      "const tpl = await import(`./fixed.js`);",
      'const cjs = require("./cjs.cjs");',
      'import data from "./data.json" with { type: "json" };',
    ].join("\n");
    expect(scan(source)).toEqual([]);
    // A file deeper in the skill may climb back up to the skill root.
    expect(scan('import "../../lib.js";', join(root, "node_modules", "dep", "index.js"))).toEqual([]);
  });

  it("reports relative and absolute specifiers that leave the directory, in every loading form", () => {
    expect(scan('import { run } from "../_shared/run.js";')).toEqual(['"../_shared/run.js"']);
    expect(scan('export { x } from "../x.js";')).toEqual(['"../x.js"']);
    expect(scan('import "../side.js";')).toEqual(['"../side.js"']);
    expect(scan('const m = await import("../x.js");')).toEqual(['"../x.js"']);
    expect(scan('const m = require("../../x");')).toEqual(['"../../x"']);
    expect(scan('import x = require("../x");')).toEqual(['"../x"']);
    expect(scan('import "/etc/x.js";')).toEqual(['"/etc/x.js"']);
    expect(scan('import "file:///etc/x.js";')).toEqual(['"file:///etc/x.js"']);
    // Read as a URL, these climb out as well.
    expect(scan('import "./%2e%2e/x.js";')).toEqual(['"./%2e%2e/x.js"']);
    expect(scan('import "..\\\\x.js";')).toEqual(['"..\\\\x.js"']);
    // Escapes are not interpreted by a text scan, so any backslash is refused.
    expect(scan('import ".\\u002e/x.js";')).toEqual(['".\\u002e/x.js"']);
  });

  it("reports package names, import-map entries and non-file URLs (resolved outside the directory)", () => {
    expect(scan('import _ from "lodash";')).toEqual(['"lodash"']);
    expect(scan('import x from "@scope/pkg/sub.js";')).toEqual(['"@scope/pkg/sub.js"']);
    expect(scan('import x from "#internal";')).toEqual(['"#internal"']);
    expect(scan('import "https://example.com/x.js";')).toEqual(['"https://example.com/x.js"']);
    expect(scan('import "data:text/javascript,export default 1";')).toEqual(['"data:text/javascript,export default 1"']);
  });

  it("reports loading calls whose specifier is computed, and createRequire", () => {
    expect(scan('const m = await import("./" + name);')).toEqual(["import() with a computed specifier"]);
    expect(scan("const m = await import(`./${name}.js`);")).toEqual(["import() with a computed specifier"]);
    expect(scan("const m = require(name);")).toEqual(["require() with a computed specifier"]);
    expect(scan('import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);')).toEqual(["createRequire()", '"node:module"']);
  });

  it("exempts type-only imports (erased before anything runs), but not inline type modifiers", () => {
    expect(scan('import type { ITool } from "../../src/tool.js";')).toEqual([]);
    expect(scan('import type Default from "../d.js";\nexport type { T } from "../t.js";\nexport type * from "../all.js";')).toEqual([]);
    expect(scan('import { type T } from "../x.js";')).toEqual(['"../x.js"']);
    // `type` as a default import's local name is a real import.
    expect(scan('import type from "../x.js";')).toEqual(['"../x.js"']);
    // A comment inside the braces of a multi-line type-only import is still exempt.
    expect(scan('import type {\n  A, // the tool\n  B,\n} from "../../src/tool.js";')).toEqual([]);
  });

  // The type-only exemption used to erase from `import type {` to the next
  // `} from "…"`, wherever the first sat: a comment, a string, a regex or JSX
  // text swallowed the real loading statement after it.
  it("never lets text that only looks like a type-only import erase a real loading statement", () => {
    expect(scan('// import type {\nimport { evil } from "evil-pkg";')).toEqual(['"evil-pkg"']);
    expect(scan('const s = "import type {";\nimport { evil } from "evil-pkg";')).toEqual(['"evil-pkg"']);
    expect(scan('/* export type { */\nexport { evil } from "../../../x.js";')).toEqual(['"../../../x.js"']);
    // `export {} from` still evaluates the module.
    expect(scan('export {\n// import type {\n} from "../../evil.js";')).toEqual(['"../../evil.js"']);
    expect(scan('const r = /import type {} from "/; import("../../evil.js"); // "')).toContain('"../../evil.js"');
    expect(scan('const t = `import type {} from "`; import("../../evil.js"); // "')).toContain('"../../evil.js"');
    expect(scan('const el = <div>import type {} from "</div>; require("../../evil.js"); //"', join(root, "index.jsx"))).toContain('"../../evil.js"');
    // A line comment ends at U+2028 as at a newline.
    expect(scan('import type { a, // \u2028 b } from "./t.js"; import "../../evil.js"; import type { c\n} from "./u.js";')).toEqual(['"../../evil.js"']);
    // After a `/` the scan cannot tell a regex from a division, so a later type-only import is not exempt.
    expect(scan('const half = a / 2;\nimport type { T } from "../t.js";')).toEqual(['"../t.js"']);
  });

  it("refuses a relative path that climbs out of the skill directory, even to come back in", () => {
    // Node resolves it from the importer's real path: through a symlinked
    // `<project>/skills` this names a file outside the skill.
    expect(scan('import "../../skills/deploy/x.js";')).toEqual(['"../../skills/deploy/x.js"']);
    expect(scan('import "../deploy/x.js";')).toEqual(['"../deploy/x.js"']);
    expect(scan('import "./lib/../x.js";')).toEqual([]);
  });

  it("refuses absolute paths, file: URLs and package self-references even when they name the skill itself", () => {
    expect(scan(`import "${join(root, "x.js")}";`)).toEqual([`"${join(root, "x.js")}"`]);
    expect(scan('import "file:///proj/skills/deploy/x.js";')).toEqual(['"file:///proj/skills/deploy/x.js"']);
    expect(scan('import "file:../deploy/x.js";')).toEqual(['"file:../deploy/x.js"']);
    expect(scan('import "deploy/x.js";')).toEqual(['"deploy/x.js"']);
    // URL parsing strips tabs and reads `%2e` as a dot; neither is guessed at.
    expect(scan('import "./.\t./x.js";')).toEqual(['"./.\t./x.js"']);
    expect(scan('import "./x.js?../../a";')).toEqual(['"./x.js?../../a"']);
  });

  it("refuses a file CommonJS would run as JavaScript but the scan never reads", () => {
    expect(scan('require("./payload.txt");')).toEqual(['"./payload.txt"']);
    expect(scan('require("./types.d.ts");')).toEqual(['"./types.d.ts"']);
    expect(scan('import "./mod.wasm";')).toEqual(['"./mod.wasm"']);
    expect(scan('require("./lib"); require("./lib/"); import "./data.json"; require("./addon.node");')).toEqual([]);
  });

  // V8 lets any comment stand between two tokens. The scan matched the keyword
  // and the specifier with nothing but whitespace between them, so one comment
  // hid a real load (each of these ran outside code under plain node).
  it("reads a comment between the keyword and the specifier the way V8 does", () => {
    expect(scan('import /**/ "../../outside/evil.js";')).toEqual(['"../../outside/evil.js"']);
    expect(scan('export * from /* x */ "../../outside/evil.js";')).toEqual(['"../../outside/evil.js"']);
    expect(scan('import x from // c\n "evil-pkg";')).toEqual(['"evil-pkg"']);
    expect(scan('const m = await import /* c */ ("evil-pkg");')).toEqual(['"evil-pkg"']);
    expect(scan('require /* x */ ("../../outside/evil.js");')).toEqual(['"../../outside/evil.js"']);
    expect(scan('const m = await import(/* a */ "evil-pkg" /* b */);')).toEqual(['"evil-pkg"']);
    expect(scan('import /* a\n b */ x /* c */ from /* d */ // e\n\t"../x.js";')).toEqual(['"../x.js"']);
    // A CommonJS script also reads `<!--` anywhere, and `-->` at a line start, as a line comment.
    expect(scan('require <!-- c\n("evil-pkg");')).toEqual(['"evil-pkg"']);
    expect(scan('require\n--> c\n("evil-pkg");')).toEqual(['"evil-pkg"']);
    // The comment ends where V8 ends it: at the first `*/`, at U+2028 for a line comment.
    expect(scan('import /* a */ "./ok.js" /* b */; require /* c */ ("./lib/b.js");')).toEqual([]);
    expect(scan('import // c\u2028"evil-pkg";')).toEqual(['"evil-pkg"']);
  });

  // Every keyword starts a walk over the comments after it. Keywords inside
  // comments that look nested share one far-away end; walking to it once per
  // keyword took 39 s for 240 KB.
  it("stays linear when keywords sit in comments that look nested", () => {
    const started = Date.now();
    expect(scan("require <!--".repeat(100_000) + "\n")).toEqual(["require used other than as a direct call"]);
    expect(scan("from /*".repeat(100_000) + "*/" + " /**/".repeat(100_000))).toEqual([]);
    expect(scan("import //".repeat(100_000) + "\n")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("reads a specifier that holds the other quote character", () => {
    expect(scan(`import "../../evil's.js";`)).toEqual([`"../../evil's.js"`]);
    expect(scan(`export * from '../"x".js';`)).toEqual([`"../"x".js"`]);
    expect(scan(`require("../../evil's.js");`)).toEqual([`"../../evil's.js"`]);
  });

  // `require` loads whatever it is called with, so the scan can only check it
  // where it is called directly with a literal. Every other use hands the
  // function on to code that calls it with a name the scan never sees.
  it("recognises require under every spelling and refuses it as a value", () => {
    expect(scan('require?.("evil-pkg");')).toEqual(['"evil-pkg"']);
    expect(scan('\\u0072equire("evil-pkg");')).toEqual(['"evil-pkg"']);
    expect(scan('r\\u{65}quire("evil-pkg");')).toEqual(['"evil-pkg"']);
    expect(scan('module.require("evil-pkg");')).toEqual(['"evil-pkg"']);
    const asValue = ["require used other than as a direct call"];
    expect(scan('(0, require)("evil-pkg");')).toEqual(asValue);
    expect(scan('const r = require;\nr("evil-pkg");')).toEqual(asValue);
    expect(scan('require.call(null, "evil-pkg");')).toEqual(asValue);
    expect(scan('require?.call(null, "evil-pkg");')).toEqual(asValue);
    expect(scan('[\\u0072equire][0]("evil-pkg");')).toEqual(asValue);
    expect(scan('const m = module["require"]("evil-pkg");')).toEqual(asValue);
  });

  // Comments and strings are read as code too. A word after `require` on the
  // same line is prose, since as code the pair is a syntax error; the words
  // that continue an expression hand the function on, and after a line break
  // ASI can end the statement with `require` as its value.
  it("lets require pass in prose only where it cannot be code", () => {
    expect(scan("// tools that require a token\nexport const tools = [];")).toEqual([]);
    expect(scan('const hint = "skills require /* or not */ approval";')).toEqual([]);
    const asValue = ["require used other than as a direct call"];
    expect(scan("// tools that require.")).toEqual(asValue);
    expect(scan('"require" in module;')).toEqual(asValue);
    expect(scan("require in proxy;")).toEqual(asValue);
    expect(scan("require instanceof Loader;")).toEqual(asValue);
    expect(scan('(require as any)("evil-pkg");')).toEqual(asValue);
    expect(scan("const r = require satisfies Function;")).toEqual(asValue);
    expect(scan("class L extends require implements Loader {}")).toEqual(asValue);
    expect(scan("module.exports = require\nfoo();")).toEqual(asValue);
    expect(scan("export default require /* a\n */ foo;")).toEqual(asValue);
    expect(scan("module.exports = require // c\nfoo();")).toEqual(asValue);
    expect(scan("x = process.getBuiltinModule\nfoo();")).toEqual(["getBuiltinModule used other than as a direct call"]);
  });

  // V8 ends a string at its closing quote, not at the end of the line: a
  // backslash before a line break continues it, and the break is dropped.
  it("reads a string that continues over a line break, and refuses its escapes", () => {
    expect(scan('export * from "../../outside/evil\\\n.js";')).toEqual(['"../../outside/evil\\\n.js"']);
    expect(scan("import '..\\\r\n/x.js';")).toEqual(["\"..\\\r\n/x.js\""]);
    expect(scan('require("./lib/evil\\\n.js");')).toEqual(['"./lib/evil\\\n.js"']);
    expect(scan('import x from "./a\\".js";')).toEqual(['"./a\\".js"']);
    expect(scan("const m = await import(`./x\n.js`);")).toEqual(['"./x\n.js"']);
  });

  // The scan compares a specifier as written; V8 decodes its escapes and
  // drops its line continuations first. A built-in name is no exception:
  // "node:\x6dodule" is node:module to Node.
  it("refuses a built-in specifier spelled with an escape or a line break", () => {
    expect(scan('import M from "node:\\x6dodule";')).toEqual(['"node:\\x6dodule"']);
    expect(scan('const M = require("node:\\u{6d}odule");')).toEqual(['"node:\\u{6d}odule"']);
    expect(scan('const M = process.getBuiltinModule("node:mod\\\nule");')).toEqual(['"node:mod\\\nule"']);
    expect(scan('import fs from "node:\\u0066s";')).toEqual(['"node:\\u0066s"']);
    expect(scan('const os = await import("os\\\r\n");')).toEqual(['"os\\\r\n"']);
    expect(scan("const fs = require(`node:fs\n`);")).toEqual(['"node:fs\n"']);
    expect(specifierLeavesSkill(root, entry, "node:fs\u2028")).toBe(true);
    expect(specifierLeavesSkill(root, entry, "node:fs")).toBe(false);
  });

  it("checks import.source() and import.defer() like import(), and lets import.meta pass", () => {
    expect(scan('const m = await import.source("../../outside/evil.wasm");')).toEqual(['"../../outside/evil.wasm"']);
    expect(scan('const m = await import /* c */ . /* c */ source("evil-pkg");')).toEqual(['"evil-pkg"']);
    expect(scan("const m = await import.source(name);")).toEqual(["import.source() with a computed specifier"]);
    expect(scan('const ns = import.defer("evil-pkg");')).toEqual(['"evil-pkg"']);
    expect(scan('const m = await import.source("./mod.wasm");')).toEqual(['"./mod.wasm"']);
    expect(scan('const ns = import.defer("./lazy.js"); const u = import.meta.url; import /* c */ . meta;')).toEqual([]);
    expect(scan("// Nothing to import. Retry later.\nexport const tools = [];")).toEqual([]);
    expect(scan('import source m from "../../outside/evil.wasm";')).toEqual(['"../../outside/evil.wasm"']);
  });

  // esbuild (tsx) reads these in a comment and adds `import { jsx } from
  // "<source>/jsx-runtime"` to the file, "react" when no source is named.
  it("refuses the JSX pragmas that make tsx import a runtime", () => {
    expect(scan("/* @jsxRuntime automatic */\nexport const a = <div/>;", join(root, "ui.tsx"))).toEqual(["@jsxRuntime"]);
    expect(scan("/** @jsxImportSource ../../outside */\nexport const a = <div/>;", join(root, "ui.jsx"))).toEqual(["@jsxImportSource"]);
    expect(scan("/** @jsx h */\nexport const a = <div/>;", join(root, "ui.tsx"))).toEqual([]);
  });

  it("refuses the loader's internals and the node:module built-in that hands them out", () => {
    expect(scan('module.constructor._load("evil-pkg", module);')).toEqual(["_load()"]);
    expect(scan('import { Module } from "node:module";\nModule._load("evil-pkg");')).toEqual(['"node:module"', "_load()"]);
    expect(scan('const { Module } = require("module");')).toEqual(['"module"']);
    expect(scan('process.dlopen(module, "/abs/evil.node");')).toEqual(["dlopen()"]);
    expect(scan('process.getBuiltinModule("module").createRequire(__filename)("evil-pkg");')).toEqual(['"module"', "createRequire()"]);
    expect(scan("process.getBuiltinModule(name);")).toEqual(["getBuiltinModule() with a computed specifier"]);
    expect(scan('const fs = process.getBuiltinModule("node:fs");')).toEqual([]);
  });

  // The hash skips .git/, so a file there can change without invalidating the
  // approval. macOS and Windows find `.git` under any letter case, and Windows
  // drops a path segment's trailing dots and spaces.
  it("refuses a specifier into the directory the hash skips", () => {
    expect(scan('import "./.git/x.js";')).toEqual(['"./.git/x.js"']);
    expect(scan('require("./lib/.GIT/hooks/post-checkout");')).toEqual(['"./lib/.GIT/hooks/post-checkout"']);
    expect(scan('import "./.git./x.js";')).toEqual(['"./.git./x.js"']);
    expect(scan('require("./.git");')).toEqual(['"./.git"']);
    expect(scan('import "./.github/x.js"; import "./git/x.js";')).toEqual([]);
  });
});

describe("findOutsidePackageTargets", () => {
  const manifest = join(root, "lib", "package.json");
  const check = (json: string): string[] => findOutsidePackageTargets(root, manifest, json);

  it("refuses a main that points outside the skill or at a file the scan does not read", () => {
    expect(check('{"main":"../../../outside/evil.js"}')).toEqual(['main "../../../outside/evil.js"']);
    expect(check('{"main":".git/x.js"}')).toEqual(['main ".git/x.js"']);
    expect(check('{"main":"/abs/evil.js"}')).toEqual(['main "/abs/evil.js"']);
    expect(check('{"main":"payload.txt"}')).toEqual(['main "payload.txt"']);
    expect(check('{"main":"index.js"}')).toEqual([]);
    expect(check('{"main":"./dist/index","exports":{".":{"types":"./index.d.ts","default":"./dist/index.js"}}}')).toEqual([]);
    expect(check('{"name":"x"}')).toEqual([]);
  });

  it("checks every key spelled main: Node reads the raw key, JSON.parse the unescaped one", () => {
    expect(check('{"main":"../../../evil.js","m\\u0061in":"index.js"}')).toEqual(['main "../../../evil.js"']);
    expect(check('{"m\\u0061in":"../../../evil.js","main":"index.js"}')).toEqual(['main "../../../evil.js"']);
    expect(check('{"main":"index.js","main":"../../../evil.js"}')).toEqual(['main "../../../evil.js"']);
    expect(check('\uFEFF{"main":"../../../evil.js"}')).toEqual(['main "../../../evil.js"']);
  });

  it("fails closed on a package.json that does not parse", () => {
    expect(check('{"main": "index.js",}')).toEqual(["package.json does not parse, so its main cannot be checked"]);
  });
});

describe("specifierLeavesSkill / isSkillCodeFile", () => {
  it("treats the skill directory itself as inside and a prefix-sharing sibling as outside", () => {
    expect(specifierLeavesSkill(root, join(root, "lib", "a.js"), "..")).toBe(false);
    expect(specifierLeavesSkill(root, entry, "../deploy-evil/x.js")).toBe(true);
  });

  it("checks code files only, never declaration files", () => {
    expect(isSkillCodeFile("index.ts")).toBe(true);
    expect(isSkillCodeFile("lib/a.MJS")).toBe(true);
    // CommonJS runs an extensionless file as JavaScript (`require("./lib")`).
    expect(isSkillCodeFile("lib/payload")).toBe(true);
    expect(isSkillCodeFile("types.d.ts")).toBe(false);
    expect(isSkillCodeFile("data.json")).toBe(false);
    expect(isSkillCodeFile("SKILL.md")).toBe(false);
  });
});
