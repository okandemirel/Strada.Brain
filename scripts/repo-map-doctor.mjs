#!/usr/bin/env node
/**
 * Keeps docs/architecture/repo_map.yaml true to the code, and routes a task
 * to the module cards it needs.
 *
 *   node scripts/repo-map-doctor.mjs                  # check; exit 1 on any drift
 *   node scripts/repo-map-doctor.mjs --write          # rewrite every depends_on from the imports
 *   node scripts/repo-map-doctor.mjs --route <words>  # print the cards those words match
 *   node scripts/repo-map-doctor.mjs --root <dir> ... # act on another checkout (tests)
 *
 * A module is a directory directly under src/. Its depends_on is never typed
 * by hand: it is the set of other modules that its non-test files import.
 * An edge is any relative import that resolves into another module: a static
 * import, a type-only import, a re-export, a side-effect import, or an
 * import("…") with a literal path, whether it names a file in the module or
 * the module's directory itself. A type import counts because the reader
 * still has to open the other module to follow it. Test files (*.test.*,
 * *.spec.*, __tests__/) do not count: a test reaching into a module is not a
 * dependency of the code under test.
 *
 * Imports are read with TypeScript's own scanner (ts.preProcessFile), which
 * skips comments and strings. Measured on 748 files: the scanner takes 0.75 s,
 * a full AST parse 8.6 s, and a regular expression 0.24 s but counts an import
 * written inside a comment.
 *
 * A reported edge records an import; it does not make it legitimate. A real
 * boundary violation is recorded too, with a note on the card that names its
 * follow-up ticket. A doctor that stays red is worth less than an exact map.
 * Which edge is a violation is not left to whoever writes the card: it is an
 * edge from a FOUNDATION module, the layer every module may import, to a
 * module outside that layer. The doctor finds each one and stays red until
 * the card records it under `violations`, keyed by the module it reaches,
 * with the follow-up ticket (#<id>), and it reports a recorded violation that
 * the code no longer has, so the record cannot outlive the fix.
 *
 * The map is YAML restricted so that it reads without a YAML library, like
 * the contracts' frontmatter: every value is JSON, either on its key's line
 * or as `- <json>` list items / `<key>: <json>` map entries one level deeper.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const MAP_PATH = "docs/architecture/repo_map.yaml";
export const FIELDS = ["purpose", "entrypoints", "depends_on", "contracts", "read_when", "skip_when", "centers", "violations", "note"];
/** The layer every module may import. An edge from one of these to any other module is a boundary violation. */
export const FOUNDATION = ["types", "utils", "common", "security", "config"];
const REQUIRED = ["purpose", "entrypoints", "depends_on", "contracts", "read_when"];
const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const NOT_SCANNED = /\.(?:test|spec)\.[^/]+$|\.d\.ts$|(?:^|\/)__tests__\//;

/* ---- imports ------------------------------------------------------------ */

/** The modules under `<root>/src`, and for each one the modules it imports with one example import per edge. */
export function scanImports(root) {
  const src = join(root, "src");
  const modules = readdirSync(src)
    .filter((d) => !d.startsWith(".") && statSync(join(src, d)).isDirectory())
    .sort();
  const known = new Set(modules);
  /** @type {Record<string, Record<string, string>>} */
  const edges = Object.fromEntries(modules.map((m) => [m, {}]));
  for (const mod of modules) {
    const files = readdirSync(join(src, mod), { recursive: true, encoding: "utf8" })
      .map((f) => `${mod}/${f.replace(/\\/g, "/")}`)
      .filter((f) => SOURCE.test(f) && !NOT_SCANNED.test(f))
      .sort();
    for (const file of files) {
      for (const { fileName: spec } of ts.preProcessFile(readFileSync(join(src, file), "utf8"), true, true).importedFiles) {
        if (!spec.startsWith(".")) continue;
        const target = posix.normalize(posix.join(posix.dirname(file), spec)).split("/");
        // Outside src/, or a file at the src/ root ("../index.js"): no card covers it, so it is no edge.
        // A bare module name ("../campaign") is one: moduleResolution "bundler" resolves it to that module's index.
        if (!known.has(target[0]) || target[0] === mod) continue;
        edges[mod][target[0]] ??= `src/${file} imports "${spec}"`;
      }
    }
  }
  return { modules, edges };
}

/* ---- the map file ------------------------------------------------------- */

const json = (raw, where, problems) => {
  try {
    return JSON.parse(raw);
  } catch {
    problems.push(`${where}: value is not JSON: ${raw}`);
    return undefined;
  }
};

/** Cards by module name, plus every line that does not read. */
export function parseMap(text) {
  /** @type {Record<string, Record<string, unknown>>} */
  const nodes = {};
  const problems = [];
  let inNodes = false;
  let node = null;
  let field = null;
  let inline = false;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const at = `${MAP_PATH}:${i + 1}`;
    if (!line.trim() || /^\s*#/.test(line)) return;
    let m;
    if ((m = /^([a-z_]+):\s*(.*)$/.exec(line))) {
      inNodes = m[1] === "nodes" && m[2] === "";
      node = field = null;
    } else if (inNodes && (m = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line))) {
      node = m[1];
      field = null;
      if (nodes[node]) problems.push(`${at}: card "${node}" appears twice`);
      nodes[node] = {};
    } else if (node && (m = /^ {4}([a-z_]+):\s*(.*)$/.exec(line))) {
      field = m[1];
      inline = m[2] !== "";
      if (field in nodes[node]) problems.push(`${at}: card "${node}" sets "${field}" twice`);
      nodes[node][field] = inline ? json(m[2], at, problems) : null;
    } else if (node && field && inline && /^ {6}\S/.test(line)) {
      // YAML rejects a value on the key's line followed by items under it; reading both would merge them silently.
      const hint = field === "depends_on" ? " (node scripts/repo-map-doctor.mjs --write rewrites it)" : "";
      problems.push(`${at}: "${field}" has a value on its line and items below it — keep one form${hint}`);
    } else if (node && field && (m = /^ {6}- (.+)$/.exec(line))) {
      const prev = nodes[node][field];
      if (prev !== null && !Array.isArray(prev)) problems.push(`${at}: "${field}" mixes a list with another value`);
      else nodes[node][field] = [...(prev ?? []), json(m[1], at, problems)];
    } else if (node && field && (m = /^ {6}([\w./-][\w./*-]*):\s+(.+)$/.exec(line))) {
      const prev = nodes[node][field];
      if (prev !== null && (typeof prev !== "object" || Array.isArray(prev))) problems.push(`${at}: "${field}" mixes a map with another value`);
      else nodes[node][field] = { ...(prev ?? {}), [m[1]]: json(m[2], at, problems) };
    } else {
      problems.push(`${at}: unreadable line: ${line.trim()}`);
    }
  });
  return { nodes, problems };
}

const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");
const listOf = (v) => (Array.isArray(v) ? v : []);

/** Every way the cards disagree with the code, one sentence each. */
export function checkMap(nodes, scan, root, foundation = FOUNDATION) {
  const problems = [];
  const fix = `run node scripts/repo-map-doctor.mjs --write`;
  for (const mod of scan.modules) if (!nodes[mod]) problems.push(`src/${mod}/ has no card — ${fix}, then fill in its purpose, entrypoints and read_when`);
  for (const [name, card] of Object.entries(nodes)) {
    const at = `card "${name}"`;
    if (!scan.modules.includes(name)) {
      problems.push(`${at}: src/${name}/ does not exist — remove the card or rename it`);
      continue;
    }
    for (const key of Object.keys(card)) if (!FIELDS.includes(key)) problems.push(`${at}: unknown field "${key}" (fields: ${FIELDS.join(", ")})`);
    for (const key of REQUIRED) if (!(key in card) || card[key] === null) problems.push(`${at}: "${key}" is missing`);
    if (typeof card.purpose !== "string" || card.purpose.trim() === "") problems.push(`${at}: "purpose" must be one non-empty sentence`);
    if (!isStringList(card.read_when) || card.read_when.length === 0) problems.push(`${at}: "read_when" needs at least one line`);
    const entries = listOf(card.entrypoints);
    if (!isStringList(card.entrypoints) || entries.length < 1 || entries.length > 4) problems.push(`${at}: "entrypoints" lists 1 to 4 files`);
    for (const e of entries) {
      if (typeof e !== "string") continue;
      if (!e.startsWith(`src/${name}/`)) problems.push(`${at}: entrypoint ${e} is not inside src/${name}/`);
      else if (!existsSync(join(root, e)) || !statSync(join(root, e)).isFile()) problems.push(`${at}: entrypoint ${e} does not exist`);
    }
    for (const c of listOf(card.contracts)) {
      if (typeof c !== "string" || !existsSync(join(root, "docs", "contracts", `${c}.md`))) problems.push(`${at}: contract "${c}" is not a file in docs/contracts/`);
    }
    for (const s of listOf(card.skip_when)) {
      const to = typeof s === "string" ? /→\s*([a-z0-9-]+)\s*$/.exec(s) : null;
      if (!to) problems.push(`${at}: skip_when line must end with "→ <card>": ${JSON.stringify(s)}`);
      else if (!scan.modules.includes(to[1])) problems.push(`${at}: skip_when sends to "${to[1]}", which has no module`);
    }
    if (card.centers !== undefined && (card.centers === null || typeof card.centers !== "object" || Array.isArray(card.centers))) {
      problems.push(`${at}: "centers" maps a sub-path to what it holds`);
    }
    if (card.note !== undefined && typeof card.note !== "string") problems.push(`${at}: "note" is one string`);
    for (const key of ["entrypoints", "depends_on", "contracts", "read_when", "skip_when"]) {
      const list = listOf(card[key]);
      for (const twice of new Set(list.filter((x, i) => list.indexOf(x) !== i))) problems.push(`${at}: "${key}" lists ${JSON.stringify(twice)} twice`);
    }
    const declared = new Set(listOf(card.depends_on));
    const actual = scan.edges[name] ?? {};
    for (const [to, example] of Object.entries(actual)) {
      if (!declared.has(to)) problems.push(`${at}: imports ${to} but depends_on omits it (${example}) — ${fix}`);
    }
    for (const to of declared) if (!(to in actual)) problems.push(`${at}: depends_on lists ${to}, which it no longer imports — ${fix}`);
    problems.push(...checkViolations(name, card, actual, foundation));
  }
  return problems;
}

/** Holds a card's `violations` to the edges that leave the foundation layer: none missing, none stale, each with a ticket. */
function checkViolations(name, card, actual, foundation) {
  const at = `card "${name}"`;
  const problems = [];
  const recorded = card.violations ?? {};
  if (recorded === null || typeof recorded !== "object" || Array.isArray(recorded)) {
    return [`${at}: "violations" maps the module an edge reaches to why it is wrong and its follow-up ticket`];
  }
  const inFoundation = foundation.includes(name);
  const leaving = inFoundation ? Object.keys(actual).filter((to) => !foundation.includes(to)) : [];
  for (const to of leaving) {
    if (!(to in recorded)) {
      problems.push(
        `${at}: imports ${to} (${actual[to]}), but ${name} is a foundation module (${foundation.join(", ")}) and ${to} is not — ` +
          `record it under "violations" as ${to}: "<why> Follow-up: #<ticket>", or remove the import`,
      );
    }
  }
  for (const [to, why] of Object.entries(recorded)) {
    if (!inFoundation) problems.push(`${at}: violations lists ${to}, but only a foundation module's edges are violations (${foundation.join(", ")}) — use "note"`);
    else if (!(to in actual)) problems.push(`${at}: violations lists ${to}, which it no longer imports — remove the entry`);
    else if (foundation.includes(to)) problems.push(`${at}: violations lists ${to}, which is a foundation module — remove the entry`);
    else if (typeof why !== "string" || !/#\d+/.test(why)) problems.push(`${at}: the ${to} violation must name its follow-up ticket as #<id>`);
  }
  return problems;
}

const flow = (list) => `[${list.map((s) => JSON.stringify(s)).join(", ")}]`;

/** The map with every depends_on set to the imports, and a skeleton card for each module that has none. */
export function writeDependsOn(text, scan) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const derived = (mod) => flow(Object.keys(scan.edges[mod] ?? {}).sort());
  const headers = [];
  let inNodes = false;
  lines.forEach((line, i) => {
    if (/^[a-z_]+:/.test(line)) inNodes = /^nodes:\s*$/.test(line);
    const m = inNodes ? /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line) : null;
    if (m) headers.push({ name: m[1], line: i });
  });
  // Last card first, so a line added or removed in one card does not move the cards still to come.
  for (let k = headers.length - 1; k >= 0; k--) {
    const { name, line } = headers[k];
    if (!scan.modules.includes(name)) continue;
    let end = line + 1;
    const limit = k + 1 < headers.length ? headers[k + 1].line : lines.length;
    while (end < limit && !/^[^\s#]/.test(lines[end])) end++;
    const at = lines.slice(line + 1, end).findIndex((l) => /^ {4}depends_on:/.test(l));
    if (at < 0) {
      lines.splice(line + 1, 0, `    depends_on: ${derived(name)}`);
      continue;
    }
    // The old value may go on below its key as block items; they go with it.
    let after = line + 2 + at;
    while (after < end && /^ {6}/.test(lines[after])) after++;
    lines.splice(line + 1 + at, after - (line + 1 + at), `    depends_on: ${derived(name)}`);
  }
  let out = lines.join("\n");
  const have = new Set(Object.keys(parseMap(out).nodes));
  for (const mod of scan.modules.filter((m) => !have.has(m))) {
    const card = [`  ${mod}:`, `    purpose: ""`, `    entrypoints: []`, `    depends_on: ${derived(mod)}`, `    contracts: []`, `    read_when: []`];
    const next = out.split("\n");
    const before = next.findIndex((l) => {
      const m = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(l);
      return m && m[1] > mod;
    });
    if (before >= 0) next.splice(before, 0, ...card, "");
    else {
      while (next.length > 0 && next[next.length - 1] === "") next.pop();
      next.push("", ...card, "");
    }
    out = next.join("\n");
  }
  return out;
}

/* ---- routing ------------------------------------------------------------ */

/**
 * Words that say nothing about where code lives: grammar, the verbs of any
 * task, path noise, and the project's own name. Measured on the map: "the",
 * "and", "or", "a", "src" and "ts" are in 27 or more of the 32 cards, "is",
 * "in", "on", "its", "that", "strada" and "brain" in 7 to 10. A term like
 * these matches cards at random and hides a miss.
 */
export const FILLER = new Set(
  (
    "a an the and or nor but not no of to in on at by for from with into onto about over as if so " +
    "is are was were be been being am it its this that these those there here " +
    "i we you my our your me us they them their he she his her " +
    "do does did done has have had can could should would will shall may might must " +
    "when where what which who whom whose why how " +
    "fix fixes fixed fixing bug bugs issue issues problem broken wrong " +
    "add adds added adding change changes changed changing update updates updated updating make makes making " +
    "use uses using new " +
    "src ts tsx js mjs cjs " +
    "strada brain"
  ).split(" "),
);

const wordsOf = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** A plural and its singular are one word; "status", "process" and "analysis" keep their s. */
const stem = (w) => (w.length > 3 && /[^isu]s$/.test(w) ? w.slice(0, -1) : w);
/**
 * A term matches a whole word, never a piece of one ("is" is not in
 * "visualization", "resets" is not in "presets"). From five letters on it
 * also matches the start of a longer word ("config" → "configuration").
 */
const matches = (term, word) => stem(word) === term || (term.length >= 5 && word.startsWith(term));

/**
 * Cards ranked by how many of the words they match; the name weighs most, and
 * the word as typed half a point more than its plural or a longer word it
 * starts ("agents" is the agents card before agent-core). No meaningful word
 * matched is a miss: [].
 */
export function route(nodes, words) {
  // `--route "campaign milestone"` arrives as one argument; it means two words.
  const terms = words.flatMap(wordsOf).filter((w) => !FILLER.has(w));
  const ranked = [];
  for (const [name, card] of Object.entries(nodes)) {
    const fields = [
      [3, wordsOf(name)],
      [2, wordsOf(`${card.purpose ?? ""} ${listOf(card.read_when).join(" ")}`)],
      [1, wordsOf(`${listOf(card.entrypoints).join(" ")} ${JSON.stringify(card.centers ?? {})}`)],
    ];
    const weigh = (t) => fields.map(([w, ws]) => (ws.includes(t) ? w : ws.some((x) => matches(stem(t), x)) ? w - 0.5 : 0));
    const score = terms.reduce((sum, t) => sum + Math.max(0, ...weigh(t)), 0);
    if (score > 0) ranked.push({ name, score });
  }
  return ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** One card as an agent reads it before opening any file. */
export function formatCard(name, card) {
  const out = [`## ${name} — ${card.purpose ?? ""}`, `  open first: ${listOf(card.entrypoints).join(", ")}`];
  const contracts = listOf(card.contracts).map((c) => `docs/contracts/${c}.md`);
  out.push(`  contracts:  ${contracts.length ? contracts.join(", ") : "(none beyond the repo-wide ones)"}`);
  out.push(`  1 hop:      ${listOf(card.depends_on).join(", ") || "(imports no other module)"}`);
  for (const r of listOf(card.read_when)) out.push(`  read when:  ${r}`);
  for (const s of listOf(card.skip_when)) out.push(`  skip when:  ${s}`);
  for (const [k, v] of Object.entries(card.centers ?? {})) out.push(`  center:     ${k} — ${v}`);
  for (const [k, v] of Object.entries(card.violations ?? {})) out.push(`  violation:  → ${k} — ${v}`);
  if (card.note) out.push(`  note:       ${card.note}`);
  return out.join("\n");
}

/* ---- command line ------------------------------------------------------- */

const USAGE = "usage: repo-map-doctor.mjs [--write | --route <words…>] [--root <dir>]";

function main(argv) {
  const rootAt = argv.indexOf("--root");
  const root = rootAt >= 0 ? resolve(argv[rootAt + 1] ?? ".") : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = rootAt >= 0 ? argv.filter((_, i) => i !== rootAt && i !== rootAt + 1) : argv;
  if (args.includes("--help")) {
    console.log(`repo-map-doctor: ${USAGE}`);
    return 0;
  }
  const mapFile = join(root, MAP_PATH);
  const text = existsSync(mapFile) ? readFileSync(mapFile, "utf8") : "";
  if (args[0] === "--route") {
    const { nodes } = parseMap(text);
    const hits = route(nodes, args.slice(1)).slice(0, 3);
    if (hits.length === 0) {
      console.log(`repo-map: no card matches "${args.slice(1).join(" ")}". A miss is a bug in the map: search, then add the words to the right card's read_when in this same change.`);
      return 1;
    }
    for (const { name } of hits) console.log(`${formatCard(name, nodes[name])}\n`);
    return 0;
  }
  const scan = scanImports(root);
  if (args[0] === "--write") {
    writeFileSync(mapFile, writeDependsOn(text, scan));
    console.log(`repo-map: depends_on rewritten from the imports of ${scan.modules.length} modules in ${MAP_PATH}`);
    return 0;
  }
  if (args.length > 0) {
    console.error(`repo-map-doctor: unexpected argument ${args[0]}\n${USAGE}`);
    return 2;
  }
  if (!text) {
    console.error(`repo-map: ${MAP_PATH} does not exist`);
    return 1;
  }
  const parsed = parseMap(text);
  const problems = [...parsed.problems, ...checkMap(parsed.nodes, scan, root)];
  const edges = Object.values(scan.edges).reduce((n, e) => n + Object.keys(e).length, 0);
  for (const p of problems) console.error(`repo-map: ${p}`);
  console.log(
    problems.length === 0
      ? `repo-map: clean — ${scan.modules.length} modules, ${edges} import edges, every card matches the code`
      : `repo-map: ${problems.length} problem(s) across ${scan.modules.length} modules`,
  );
  return problems.length === 0 ? 0 : 1;
}

/**
 * Entry check by realpath: node runs a module from its realpath, so a script
 * started through a symlinked checkout has an argv[1] that never equals
 * import.meta.url as spelled (src/tests/integration/entry-guard-symlink.test.ts).
 */
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
