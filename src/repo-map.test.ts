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
  FOUNDATION: string[];
  scanImports(root: string): Scan;
  parseMap(text: string): { nodes: Record<string, Card>; problems: string[] };
  checkMap(nodes: Record<string, Card>, scan: Scan, root: string, foundation?: string[]): string[];
  writeDependsOn(text: string, scan: Scan): string;
  route(nodes: Record<string, Card>, words: string[]): Array<{ name: string; score: number }>;
  termsOf(words: string[]): string[];
  singulars(word: string): string[];
}
const doctor = (await import(pathToFileURL(DOCTOR).href)) as Doctor;

const FIX = "run node scripts/repo-map-doctor.mjs --write";

describe("the repo map matches the code (docs/architecture/repo_map.yaml)", () => {
  // One scan of the real tree serves every case. It takes about a second on an idle machine and
  // far longer when parallel agents load it, so it runs once, under its own generous timeout.
  let scan: Scan;
  beforeAll(() => {
    scan = doctor.scanImports(REPO);
  }, 120_000);

  it("every src/ module has a card, and every card matches its imports, files and contracts", () => {
    const { nodes, problems } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
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

  it("every foundation module exists, so the violation rule never names a module that is gone", () => {
    expect(scan.modules).toEqual(expect.arrayContaining(doctor.FOUNDATION));
  });

  it("routes a task phrase an agent quotes as one argument", () => {
    const { nodes } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
    expect(doctor.route(nodes, ["campaign milestone"])[0]?.name).toBe("campaign");
  });

  it("routes a natural sentence by its meaningful words, never by filler or a piece of a word", () => {
    const { nodes } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    // "is" sat inside "history", "supervisor" and "visualization", and "the" in every purpose.
    expect(names("the worktree lease is lost")[0]).toBe("agents");
    // "resets" sat inside "presets", which put config before core.
    expect(names("auto-updater resets the branch")[0]).toBe("core");
    expect(names("auto-updater resets the branch")).not.toContain("config");
    // The module's own name as typed outranks its plural folded into another name ("agent-core").
    expect(names("agents")[0]).toBe("agents");
    for (const filler of ["a", "in", "is", "the"]) expect(names(filler), filler).toEqual([]);
  });

  it("routes every module's own name to its card first, even when that name is a word of another card's name", () => {
    const { nodes } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
    // "core" is also a word of "agent-core": both scored 3 on the name, and the alphabet put agent-core first.
    for (const name of Object.keys(nodes)) expect(doctor.route(nodes, [name])[0]?.name, name).toBe(name);
  });

  it("routes every class an entrypoint exports to its card: never a miss, the owner in the top 3 or sent there by one of them", () => {
    const { nodes } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
    // A symbol from a stack trace or a task is an agent's likeliest query. Lower-cased whole, "CampaignManager"
    // was one word no card holds: 47 of these 50 classes missed, and the doctor asked to write each into read_when.
    const sendsTo = (card: Card | undefined, owner: string) =>
      Array.isArray(card?.skip_when) && card.skip_when.some((s) => typeof s === "string" && s.trimEnd().endsWith(`→ ${owner}`));
    const classes: Array<[string, string]> = [];
    for (const [owner, card] of Object.entries(nodes)) {
      for (const entry of (card.entrypoints as string[]) ?? []) {
        for (const m of readFileSync(join(REPO, entry), "utf8").matchAll(/^export (?:abstract )?class (\w+)/gm)) classes.push([m[1]!, owner]);
      }
    }
    expect(classes.length).toBeGreaterThan(0);
    for (const [symbol, owner] of classes) {
      const top = doctor.route(nodes, [symbol]).slice(0, 3).map((r) => r.name);
      // "Daemon" is both the daemon card's name and gateway's restart class; the daemon card sends it on (AGENTS.md step 1).
      expect(top.includes(owner) || top.some((n) => sendsTo(nodes[n], owner)), `${symbol} (${owner}): ${top.join(", ") || "miss"}`).toBe(true);
    }
  });

  it("routes C#, the language this product writes, though it is one letter and a sign", () => {
    const { nodes } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
    expect(doctor.route(nodes, ["C#"])[0]?.name).toBe("intelligence");
  });

  it("routes an -ies or -es plural to the cards of its singular, and the plural of a word ending in e too", () => {
    const { nodes } = doctor.parseMap(readFileSync(join(REPO, doctor.MAP_PATH), "utf8"));
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    // "memories" folded to "memorie", which no card says: a false miss that asked the agent to edit the map.
    // The plural of a card's name routes to that card first: the name and the full-name point outweigh any other field.
    expect(names("memories")[0]).toBe("memory");
    // "caches", "leases", "phases": the singular ends in e, so only dropping "es" would lose them.
    // The same cards, not the same order: a card that writes the plural as typed ranks half a point higher,
    // so read_when may say "leases" (step 4 of AGENTS.md adds words as they come) without breaking this case.
    const cards = (q: string) => names(q).sort();
    for (const [plural, singular] of [["memories", "memory"], ["processes", "process"], ["policies", "policy"], ["caches", "cache"], ["leases", "lease"], ["phases", "phase"]]) {
      expect(cards(singular), singular).not.toEqual([]);
      expect(cards(plural), plural).toEqual(cards(singular));
    }
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
  "src/delta/d.ts": 'export type G = typeof import("../gamma");\nexport const d = 1;\n',
  "src/delta/legacy.cjs": 'module.exports = require("../beta/b.js");\n',
  "docs/contracts/some-rule.md": "# some rule\n",
};
const EXACT: Record<string, string[]> = { alpha: ["beta"], beta: ["gamma"], delta: ["beta", "gamma"], gamma: ["delta"] };

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

  it("derives edges from static, type-only, re-exported and dynamic imports, require() and a module's directory, and nothing else", () => {
    expect(scan.modules).toEqual(["alpha", "beta", "delta", "gamma"]);
    const edges = Object.fromEntries(Object.entries(scan.edges).map(([m, e]) => [m, Object.keys(e).sort()]));
    // Not edges: the commented import, the import inside a string, the test
    // file, the __tests__ helper, the package, and the src/ root file.
    expect(edges).toEqual(EXACT);
    expect(scan.edges.alpha?.beta).toBe('src/alpha/a.ts imports "../beta/b.js"');
    // "../gamma" names the directory; moduleResolution "bundler" resolves it to gamma's index.
    expect(scan.edges.delta?.gamma).toBe('src/delta/d.ts imports "../gamma"');
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

  it("reads a quoted phrase as its words, on the command line too", () => {
    const { nodes } = doctor.parseMap(exactMap());
    expect(doctor.route(nodes, ["module gamma"])).toEqual(doctor.route(nodes, ["module", "gamma"]));
    expect(doctor.route(nodes, ["module gamma"])[0]?.name).toBe("gamma");
    writeMap(exactMap());
    const routed = run("--route", "module gamma");
    expect(routed.out).toContain("## gamma — The gamma module.");
    expect(routed.status).toBe(0);
  }, 60_000);

  it("drops filler words, so a sentence whose meaningful words match no card is a miss, on the command line too", () => {
    const { nodes } = doctor.parseMap(exactMap());
    // Every fixture card says "The … module." and "working on … things".
    expect(doctor.route(nodes, ["the xyzzy is on a"])).toEqual([]);
    expect(doctor.route(nodes, ["a"])).toEqual([]);
    writeMap(exactMap());
    const missed = run("--route", "the xyzzy is on a");
    expect(missed.out).toContain('no card matches "the xyzzy is on a"');
    expect(missed.status).toBe(1);
  }, 60_000);

  it("tells a query with no meaningful word from a miss, and never asks to fix the map for it", () => {
    expect(doctor.termsOf(["fix the bug"])).toEqual([]);
    expect(doctor.termsOf([])).toEqual([]);
    writeMap(exactMap());
    for (const query of [["fix the bug"], ["the", "a"], []]) {
      const r = run("--route", ...query);
      expect(r.out, query.join(" ")).toContain("no meaningful word in the query");
      expect(r.out, query.join(" ")).not.toContain("read_when");
      expect(r.status, query.join(" ")).toBe(2);
    }
  }, 60_000);

  it("drops the clitic of a possessive or a negation, so its letter matches no card that has one", () => {
    expect(doctor.termsOf(["the agent's lease"])).toEqual(["agent", "lease"]);
    expect(doctor.termsOf(["it’s the agent’s"])).toEqual(["agent"]);
    expect(doctor.termsOf(["don't touch the lease, it isn't held"])).toEqual(["touch", "lease", "held"]);
    const { nodes } = doctor.parseMap(mapOf([card("alpha", { read_when: '\n      - "the worker\'s queue"' }), card("beta"), card("delta"), card("gamma")]));
    expect(doctor.route(nodes, ["beta's"]).map((r) => r.name)).toEqual(["beta"]);
  });

  it("keeps C# and F# as one word each, so the language routes while the letter alone does not", () => {
    expect(doctor.termsOf(["C# parser"])).toEqual(["csharp", "parser"]);
    const { nodes } = doctor.parseMap(
      mapOf([card("alpha", { read_when: '\n      - "scripts in F#"' }), card("beta", { read_when: '\n      - "Unity and C#: C# parsing"' }), card("delta"), card("gamma")]),
    );
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    expect(names("C#")).toEqual(["beta"]);
    expect(names("f#")).toEqual(["alpha"]);
    expect(names("c")).toEqual([]);
  });

  it("splits a symbol into the words its file and the cards spell, on both sides", () => {
    expect(doctor.termsOf(["CampaignManager"])).toEqual(["campaign", "manager"]);
    expect(doctor.termsOf(["AgentDBAdapter"])).toEqual(["agent", "db", "adapter"]);
    expect(doctor.termsOf(["HNSWVectorStore"])).toEqual(["hnsw", "vector", "store"]);
    const { nodes } = doctor.parseMap(
      mapOf([
        card("alpha", { entrypoints: flow(["src/alpha/lease-keeper.ts"]) }),
        card("beta", { read_when: '\n      - "the HNSWVectorStore index"' }),
        card("delta"),
        card("gamma"),
      ]),
    );
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    // The query holds the symbol, the card its file name.
    expect(names("LeaseKeeper")).toEqual(["alpha"]);
    // The card holds the symbol, the query its words.
    expect(names("vector store")).toEqual(["beta"]);
  });

  it("matches whole words: a plural, and from five letters the start of a longer word, never a piece of one", () => {
    const { nodes } = doctor.parseMap(mapOf([card("alpha"), card("beta"), card("delta"), card("gamma", { read_when: '\n      - "configuration and autonomy"' })]));
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    expect(names("amm")).toEqual([]); // inside "gamma"
    expect(names("orking")).toEqual([]); // inside "working"
    expect(names("modules")).toEqual(["alpha", "beta", "delta", "gamma"]); // the plural of "module"
    expect(names("config")).toEqual(["gamma"]); // starts "configuration"
    expect(names("auto")).toEqual([]); // starts "autonomy", but four letters start too many words
  });

  it("folds a plural onto its singular however English spells it, and leaves a word that ends in s whole", () => {
    const { nodes } = doctor.parseMap(
      mapOf([
        card("alpha", { read_when: '\n      - "memory policy process"' }),
        card("beta", { read_when: '\n      - "cache lease size"' }),
        card("delta", { read_when: '\n      - "status analysis"' }),
        card("gamma"),
      ]),
    );
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    for (const q of ["memories", "policies", "processes"]) expect(names(q), q).toEqual(["alpha"]); // -ies is -y; -es after s, x, z, ch, sh
    for (const q of ["caches", "leases", "sizes"]) expect(names(q), q).toEqual(["beta"]); // and still only -s after an e
    for (const q of ["status", "statuses", "analysis"]) expect(names(q), q).toEqual(["delta"]);
    for (const q of ["memory", "policy", "process", "cache", "lease", "size", "status"]) expect(names(q), q).not.toEqual([]);
    for (const w of ["status", "process", "analysis", "bus"]) expect(doctor.singulars(w), w).toEqual([w]);
    expect(doctor.singulars("memories")).toContain("memory");
    expect(doctor.singulars("processes")).toContain("process");
    expect(doctor.singulars("caches")).toContain("cache");
  });

  it("routes a plural and its singular to the same cards when one card writes the plural and another the singular", () => {
    const { nodes } = doctor.parseMap(
      mapOf([
        card("alpha", { read_when: '\n      - "task leases"' }),
        card("beta", { read_when: '\n      - "the lease of a worktree"' }),
        card("delta", { read_when: '\n      - "memories and processes"' }),
        card("gamma", { read_when: '\n      - "memory of a process"' }),
      ]),
    );
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    const cards = (q: string) => names(q).sort();
    for (const [plural, singular, both] of [["leases", "lease", ["alpha", "beta"]], ["memories", "memory", ["delta", "gamma"]], ["processes", "process", ["delta", "gamma"]]] as const) {
      expect(cards(plural), plural).toEqual(both);
      expect(cards(singular), singular).toEqual(both);
    }
    // The word as typed ranks half a point higher, so the order is not the same, by design.
    expect(names("leases")).toEqual(["alpha", "beta"]);
    expect(names("lease")).toEqual(["beta", "alpha"]);
  });

  it("puts the card a query names in full before a card whose name it only shares a word with", () => {
    // Both names hold the word "core", and on a tie the alphabet puts agent-core first.
    const { nodes } = doctor.parseMap(mapOf([card("agent-core"), card("core")]));
    const names = (q: string) => doctor.route(nodes, [q]).map((r) => r.name);
    expect(names("core")).toEqual(["core", "agent-core"]);
    expect(names("agent core")).toEqual(["agent-core", "core"]);
    expect(names("agent-core")).toEqual(["agent-core", "core"]);
  });

  it("reports a value on the key's line with items below it, instead of merging the two", () => {
    const text = exactMap().replace('    depends_on: ["gamma"]', '    depends_on: ["gamma"]\n      - "alpha"');
    const line = text.split("\n").indexOf('      - "alpha"') + 1;
    const { nodes, problems } = doctor.parseMap(text);
    expect(nodes.beta?.depends_on).toEqual(["gamma"]);
    expect(problems).toEqual([
      `${doctor.MAP_PATH}:${line}: "depends_on" has a value on its line and items below it — keep one form (node scripts/repo-map-doctor.mjs --write rewrites it)`,
    ]);
  });

  it("reports a field a card sets twice", () => {
    const problems = check(exactMap().replace('    depends_on: ["gamma"]', '    depends_on: ["gamma"]\n    depends_on: ["gamma"]'));
    expect(problems).toEqual([expect.stringMatching(/: card "beta" sets "depends_on" twice$/)]);
  });

  it("reports an entry a list holds twice", () => {
    const problems = check(exactMap().replace('    depends_on: ["gamma"]', '    depends_on: ["gamma", "gamma"]'));
    expect(problems).toEqual(['card "beta": "depends_on" lists "gamma" twice']);
  });

  it("--write replaces a depends_on together with the items below it, so the fix it names works", () => {
    const blocky = exactMap()
      .replace('    depends_on: ["beta"]', '    depends_on:\n      - "delta"\n      - "gamma"\n      - "beta"')
      .replace('    depends_on: ["gamma"]', '    depends_on: ["gamma"]\n      - "alpha"');
    expect(check(blocky)).toEqual(
      expect.arrayContaining([expect.stringMatching(/"depends_on" has a value on its line and items below it/), expect.stringMatching(/^card "alpha": depends_on lists delta/)]),
    );
    const written = doctor.writeDependsOn(blocky, scan);
    expect(written).toBe(exactMap());
    expect(check(written)).toEqual([]);
  });

  describe("violations: an edge from a foundation module to a module outside it", () => {
    // beta and gamma play the foundation: beta -> gamma stays inside it, gamma -> delta leaves it.
    const FOUNDATION = ["beta", "gamma"];
    const checkWith = (text: string) => {
      const { nodes, problems } = doctor.parseMap(text);
      return [...problems, ...doctor.checkMap(nodes, scan, root, FOUNDATION)];
    };
    const recorded = (entries: string) => `\n      ${entries}`;

    it("is demanded for each such edge, and for no other", () => {
      expect(checkWith(exactMap())).toEqual([
        'card "gamma": imports delta (src/gamma/g.ts imports "../delta/d.js"), but gamma is a foundation module (beta, gamma) and delta is not — ' +
          'record it under "violations" as delta: "<why> Follow-up: #<ticket>", or remove the import',
      ]);
    });

    it("is accepted once recorded with its follow-up ticket", () => {
      const map = mapOf(["alpha", "beta", "delta"].map((n) => card(n)).concat(card("gamma", { violations: recorded('delta: "g.ts loads delta. Follow-up: #7."') })));
      expect(checkWith(map)).toEqual([]);
    });

    it("needs a ticket, and cannot be recorded where the rule does not apply", () => {
      const map = mapOf([
        card("alpha", { violations: recorded('beta: "Follow-up: #7."') }),
        card("beta", { violations: recorded('gamma: "Follow-up: #7."') }),
        card("delta", { violations: '["beta"]' }),
        card("gamma", { violations: recorded('delta: "someone should fix this"') + recorded('alpha: "Follow-up: #7."') }),
      ]);
      expect(checkWith(map)).toEqual([
        'card "alpha": violations lists beta, but only a foundation module\'s edges are violations (beta, gamma) — use "note"',
        'card "beta": violations lists gamma, which is a foundation module — remove the entry',
        'card "delta": "violations" maps the module an edge reaches to why it is wrong and its follow-up ticket',
        'card "gamma": the delta violation must name its follow-up ticket as #<id>',
        'card "gamma": violations lists alpha, which it no longer imports — remove the entry',
      ]);
    });
  });

  it("--write starts a map its own parser reads where there is none, or none with a nodes: key", () => {
    for (const text of ["", "# a map still to write\n", "# no nodes key\nversion: 1\n"]) {
      const written = doctor.writeDependsOn(text, scan);
      const { nodes, problems } = doctor.parseMap(written);
      expect(problems, JSON.stringify(text)).toEqual([]);
      expect(Object.keys(nodes), JSON.stringify(text)).toEqual(["alpha", "beta", "delta", "gamma"]);
      expect(written.match(/^version: 1$/gm), JSON.stringify(text)).toHaveLength(1);
      expect(doctor.writeDependsOn(written, scan), JSON.stringify(text)).toBe(written);
    }
    // A checkout with no docs/architecture/ at all.
    rmSync(join(root, "docs/architecture"), { recursive: true, force: true });
    expect(run("--write").status).toBe(0);
    const after = run();
    expect(after.out).not.toContain("unreadable line");
    expect(after.out).toContain('card "alpha": "read_when" needs at least one line');
    expect(after.status).toBe(1);
  }, 60_000);

  it("the command line exits 1 on drift, 0 when clean, and routes", () => {
    writeMap(mapOf([card("alpha", { depends_on: "[]" }), card("beta"), card("delta"), card("gamma")]));
    const drift = run();
    expect(drift.status).toBe(1);
    expect(drift.out).toContain('card "alpha": imports beta but depends_on omits it');

    expect(run("--write").status).toBe(0);
    const clean = run();
    expect(clean.out).toContain("repo-map: clean — 4 modules, 5 import edges");
    expect(clean.status).toBe(0);

    const routed = run("--route", "gamma");
    expect(routed.status).toBe(0);
    expect(routed.out).toContain("## gamma — The gamma module.");
    expect(routed.out).toContain("1 hop:      delta");
    expect(run("--route", "xyzzy").status).toBe(1);
  }, 60_000);
});
