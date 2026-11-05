/**
 * Holds docs/architecture/repo_map.yaml to the code.
 *
 * The map gives every module under src/ a card (purpose, entrypoints,
 * depends_on, contracts, read_when) so an agent can route to the code before
 * it searches the whole repository. A hand-kept dependency list goes stale in
 * weeks, so depends_on is derived from the imports by
 * scripts/repo-map-doctor.mjs, and this file fails when the map drifts: a
 * module without a card, a card without a module, an import the card omits,
 * an edge that is gone, a missing entrypoint, an unknown contract.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DOCTOR = join(REPO, "scripts/repo-map-doctor.mjs");

type Card = Record<string, unknown>;
interface Scan {
  modules: string[];
  edges: Record<string, Record<string, string>>;
}
interface Doctor {
  MAP_PATH: string;
  scanImports(root: string): Scan;
  parseMap(text: string): { nodes: Record<string, Card>; problems: string[] };
  checkMap(nodes: Record<string, Card>, scan: Scan, root: string): string[];
  writeDependsOn(text: string, scan: Scan): string;
  route(nodes: Record<string, Card>, words: string[]): Array<{ name: string; score: number }>;
}
const doctor = (await import(pathToFileURL(DOCTOR).href)) as Doctor;

const FIX = "run node scripts/repo-map-doctor.mjs --write";

describe("the repo map matches the code (docs/architecture/repo_map.yaml)", () => {
  it("every src/ module has a card, and every card matches its imports, files and contracts", () => {
    const { nodes, problems } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
    const scan = doctor.scanImports(REPO);
    expect([...problems, ...doctor.checkMap(nodes, scan, REPO)], FIX).toEqual([]);
    expect(Object.keys(nodes).sort()).toEqual(scan.modules);
  });

  it("AGENTS.md tells every agent to route through the map before it searches", () => {
    const agents = readFileSync(join(REPO, "AGENTS.md"), "utf8");
    expect(agents).toContain("docs/architecture/repo_map.yaml");
    expect(agents).toContain("node scripts/repo-map-doctor.mjs --route");
  });

  it("the pre-push gates run the doctor, so a stale map is caught before CI", () => {
    expect(readFileSync(join(REPO, "scripts/ci/gates.mjs"), "utf8")).toContain("scripts/repo-map-doctor.mjs");
  });
});

/* A tiny checkout with four modules. Each import form is one line. */
const FILES: Record<string, string> = {
  "src/index.ts": 'import { a } from "./alpha/a.js";\nexport { a };\n',
  "src/alpha/a.ts": [
    'import { b } from "../beta/b.js";',
    '// import { g } from "../gamma/g.js";',
    'import fs from "node:fs";',
    'import { root } from "../index.js";',
    "export const a = [b, fs, root];",
  ].join("\n"),
  "src/alpha/a.test.ts": 'import { g } from "../gamma/g.js";\n',
  "src/alpha/__tests__/helper.ts": 'import { g } from "../../gamma/g.js";\n',
  "src/beta/b.ts": 'export type { T } from "../gamma/t.js";\nexport const b = "import x from \'../alpha/a.js\'";\n',
  "src/gamma/g.ts": 'export const g = () => import("../delta/d.js");\n',
  "src/gamma/t.ts": "export type T = number;\n",
  "src/delta/d.ts": "export const d = 1;\n",
  "src/delta/legacy.cjs": 'module.exports = require("../beta/b.js");\n',
  "docs/contracts/some-rule.md": "# some rule\n",
};
const EXACT: Record<string, string[]> = { alpha: ["beta"], beta: ["gamma"], delta: ["beta"], gamma: ["delta"] };

const flow = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
function card(name: string, over: Record<string, string> = {}): string {
  const file = Object.keys(FILES).find((f) => f.startsWith(`src/${name}/`) && !/test/.test(f)) ?? "";
  const fields: Record<string, string> = {
    purpose: `"The ${name} module."`,
    entrypoints: flow([file]),
    depends_on: flow(EXACT[name] ?? []),
    contracts: flow(["some-rule"]),
    read_when: `\n      - "working on ${name} things"`,
    ...over,
  };
  const body = Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `    ${k}:${v.startsWith("\n") ? v : ` ${v}`}`);
  return [`  ${name}:`, ...body].join("\n");
}
const mapOf = (cards: string[]) => `# fixture\nversion: 1\n\nnodes:\n${cards.join("\n\n")}\n`;
const exactMap = () => mapOf(["alpha", "beta", "delta", "gamma"].map((n) => card(n)));

describe("repo-map-doctor on a fixture checkout", () => {
  let root = "";
  let scan: Scan;

  beforeAll(() => {
    root = mkdtempSync(join(os.tmpdir(), "strada-repo-map-"));
    for (const [rel, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    scan = doctor.scanImports(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const check = (text: string) => {
    const { nodes, problems } = doctor.parseMap(text);
    return [...problems, ...doctor.checkMap(nodes, scan, root)];
  };
  const writeMap = (text: string) => {
    mkdirSync(join(root, "docs/architecture"), { recursive: true });
    writeFileSync(join(root, doctor.MAP_PATH), text);
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [DOCTOR, "--root", root, ...args], { encoding: "utf8", timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("derives edges from static, type-only, re-exported and dynamic imports and require(), and nothing else", () => {
    expect(scan.modules).toEqual(["alpha", "beta", "delta", "gamma"]);
    const edges = Object.fromEntries(Object.entries(scan.edges).map(([m, e]) => [m, Object.keys(e).sort()]));
    // Not edges: the commented import, the import inside a string, the test
    // file, the __tests__ helper, the package, and the src/ root file.
    expect(edges).toEqual(EXACT);
    expect(scan.edges.alpha?.beta).toBe('src/alpha/a.ts imports "../beta/b.js"');
  });

  it("accepts a map whose cards match the code", () => {
    expect(check(exactMap())).toEqual([]);
  });

  it("reports an import the card omits, with the file that makes it", () => {
    const problems = check(mapOf([card("alpha", { depends_on: "[]" }), card("beta"), card("delta"), card("gamma")]));
    expect(problems).toEqual([`card "alpha": imports beta but depends_on omits it (src/alpha/a.ts imports "../beta/b.js") — ${FIX}`]);
  });

  it("reports an edge the code no longer has", () => {
    const problems = check(mapOf([card("alpha", { depends_on: flow(["beta", "delta"]) }), card("beta"), card("delta"), card("gamma")]));
    expect(problems).toEqual([`card "alpha": depends_on lists delta, which it no longer imports — ${FIX}`]);
  });

  it("reports a module without a card and a card without a module", () => {
    const problems = check(mapOf([card("alpha"), card("beta"), card("gamma"), card("omega", { entrypoints: "[]" })]));
    expect(problems).toContain(`src/delta/ has no card — ${FIX}, then fill in its purpose, entrypoints and read_when`);
    expect(problems).toContain('card "omega": src/omega/ does not exist — remove the card or rename it');
  });

  it("reports cards whose fields point at nothing", () => {
    const problems = check(
      mapOf([
        card("alpha", { entrypoints: flow(["src/alpha/gone.ts"]), contracts: flow(["no-such-rule"]) }),
        card("beta", { entrypoints: flow(["src/gamma/g.ts"]), skip_when: '\n      - "elsewhere → nowhere"' }),
        card("delta", { read_when: "[]", owner: '"someone"' }),
        card("gamma", { purpose: "", skip_when: '\n      - "no arrow here"' }),
      ]),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'card "alpha": entrypoint src/alpha/gone.ts does not exist',
        'card "alpha": contract "no-such-rule" is not a file in docs/contracts/',
        'card "beta": entrypoint src/gamma/g.ts is not inside src/beta/',
        'card "beta": skip_when sends to "nowhere", which has no module',
        'card "delta": "read_when" needs at least one line',
        expect.stringMatching(/^card "delta": unknown field "owner"/),
        'card "gamma": "purpose" is missing',
        'card "gamma": skip_when line must end with "→ <card>": "no arrow here"',
      ]),
    );
  });

  it("reports a line it cannot read instead of skipping it", () => {
    const problems = check(exactMap().replace('    purpose: "The beta module."', "    purpose: The beta module."));
    expect(problems).toEqual([`${doctor.MAP_PATH}:14: value is not JSON: The beta module.`, 'card "beta": "purpose" must be one non-empty sentence']);
  });

  it("--write sets every depends_on from the imports, adds a card per new module, and changes nothing else", () => {
    const stale = mapOf([card("alpha", { depends_on: flow(["delta"]) }), card("beta", { depends_on: "" }), card("gamma")]);
    const written = doctor.writeDependsOn(stale, scan);
    expect(doctor.writeDependsOn(written, scan)).toBe(written);
    const { nodes } = doctor.parseMap(written);
    expect(Object.keys(nodes)).toEqual(["alpha", "beta", "delta", "gamma"]);
    for (const [name, deps] of Object.entries(EXACT)) expect(nodes[name]?.depends_on, name).toEqual(deps);
    // The new card still needs a person's words, so the check stays red until it has them.
    expect(check(written)).toEqual([
      'card "delta": "purpose" must be one non-empty sentence',
      'card "delta": "read_when" needs at least one line',
      'card "delta": "entrypoints" lists 1 to 4 files',
    ]);
    const kept = (l: string) => l !== "" && !l.includes("depends_on");
    const skeleton = /^ {2}delta:$|^ {4}(?:purpose|entrypoints|contracts|read_when): (?:""|\[\])$/;
    expect(stale.split("\n").filter(kept)).toEqual(written.split("\n").filter((l) => kept(l) && !skeleton.test(l)));
  });

  it("--route ranks the cards a task's words match, the name first", () => {
    const { nodes } = doctor.parseMap(exactMap());
    expect(doctor.route(nodes, ["gamma"]).map((r) => r.name)).toEqual(["gamma"]);
    expect(doctor.route(nodes, ["module", "beta"])[0]?.name).toBe("beta");
    expect(doctor.route(nodes, ["xyzzy"])).toEqual([]);
  });

  it("the command line exits 1 on drift, 0 when clean, and routes", () => {
    writeMap(mapOf([card("alpha", { depends_on: "[]" }), card("beta"), card("delta"), card("gamma")]));
    const drift = run();
    expect(drift.status).toBe(1);
    expect(drift.out).toContain('card "alpha": imports beta but depends_on omits it');

    expect(run("--write").status).toBe(0);
    const clean = run();
    expect(clean.out).toContain("repo-map: clean — 4 modules, 4 import edges");
    expect(clean.status).toBe(0);

    const routed = run("--route", "gamma");
    expect(routed.status).toBe(0);
    expect(routed.out).toContain("## gamma — The gamma module.");
    expect(routed.out).toContain("1 hop:      delta");
    expect(run("--route", "xyzzy").status).toBe(1);
  }, 60_000);
});
