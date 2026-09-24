// SEC-4: the specifiers a workspace skill's code loads must stay inside the
// skill directory, because the approval hash covers nothing else.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { findOutsideImports, isSkillCodeFile, specifierLeavesSkill } from "./skill-import-scan.js";

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
    expect(scan('import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);')).toEqual(["createRequire()"]);
  });

  it("exempts type-only imports (erased before anything runs), but not inline type modifiers", () => {
    expect(scan('import type { ITool } from "../../src/tool.js";')).toEqual([]);
    expect(scan('import type Default from "../d.js";\nexport type { T } from "../t.js";\nexport type * from "../all.js";')).toEqual([]);
    expect(scan('import { type T } from "../x.js";')).toEqual(['"../x.js"']);
    // `type` as a default import's local name is a real import.
    expect(scan('import type from "../x.js";')).toEqual(['"../x.js"']);
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
    expect(isSkillCodeFile("types.d.ts")).toBe(false);
    expect(isSkillCodeFile("data.json")).toBe(false);
    expect(isSkillCodeFile("SKILL.md")).toBe(false);
  });
});
