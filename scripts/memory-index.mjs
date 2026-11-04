#!/usr/bin/env node
/**
 * Derives docs/memory/CORE.md and docs/memory/INDEX.md from docs/memory/entries/.
 * docs/memory/POLICY.md says why both are derived and never hand-edited.
 *
 *   node scripts/memory-index.mjs          # regenerate both files
 *   node scripts/memory-index.mjs --check  # exit 1 when an entry is invalid or a file is stale
 *
 * Frontmatter is `key: value` lines, and structured values are JSON. That is
 * the contracts' format, so the file is read without a YAML library.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_LINE_LIMIT = 40;
const KINDS = ["decision", "guideline", "gotcha", "spike"];
const REQUIRED = ["id", "kind", "tier", "status", "topics", "paths", "purpose", "summary", "decided_on"];
const SECTIONS = ["## Context", "## Decision", "## Rejected alternatives", "## Consequences"];
const BANNER =
  "<!-- DERIVED from docs/memory/entries by `node scripts/memory-index.mjs`. Do not edit or hand-merge: regenerate. -->";

function scalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (/^[[{"]/.test(v) || /^(null|true|false|-?\d+(\.\d+)?)$/.test(v)) return JSON.parse(v);
  return v;
}

/** One entry file: frontmatter fields, the body, and the file name. */
export function parseEntry(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { file, fields: {}, body: text, problems: [`${file}: no frontmatter`] };
  const fields = {};
  const problems = [];
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (!kv) {
      problems.push(`${file}: unreadable frontmatter line "${line}"`);
      continue;
    }
    try {
      fields[kv[1]] = scalar(kv[2]);
    } catch {
      problems.push(`${file}: ${kv[1]} is not valid JSON`);
    }
  }
  return { file, fields, body: m[2], problems };
}

/** Topic ids registered in topics.yaml. */
export function parseTopics(text) {
  return [...text.matchAll(/^\s*-\s*id:\s*([\w-]+)/gm)].map((m) => m[1]);
}

/** Every reason the set of entries is not acceptable, as sentences. */
export function validate(entries, topics) {
  const problems = entries.flatMap((e) => e.problems);
  const ids = new Map(entries.map((e) => [e.fields.id, e]));
  for (const e of entries) {
    const f = e.fields;
    for (const key of REQUIRED) if (f[key] === undefined || f[key] === "") problems.push(`${e.file}: missing ${key}`);
    if (f.id && !e.file.endsWith(`-${f.id}.md`)) problems.push(`${e.file}: file name must end with -${f.id}.md`);
    if (f.decided_on && !e.file.startsWith(String(f.decided_on))) problems.push(`${e.file}: file name must start with decided_on`);
    if (f.kind && !KINDS.includes(f.kind)) problems.push(`${e.file}: kind ${f.kind} is not one of ${KINDS.join(", ")}`);
    if (f.tier !== 0 && f.tier !== 1) problems.push(`${e.file}: tier must be 0 or 1`);
    if (f.tier === 0 && !f.tier_reason) problems.push(`${e.file}: tier 0 needs a tier_reason`);
    for (const t of Array.isArray(f.topics) ? f.topics : []) {
      if (!topics.includes(t)) problems.push(`${e.file}: topic ${t} is not in topics.yaml`);
    }
    for (const s of SECTIONS) if (!e.body.includes(s)) problems.push(`${e.file}: missing section "${s}"`);
    const rejected = /## Rejected alternatives\n([\s\S]*?)(?:\n## |$)/.exec(e.body)?.[1]?.trim() ?? "";
    if (e.body.includes("## Rejected alternatives") && rejected.length < 20) {
      problems.push(`${e.file}: Rejected alternatives is empty — list what was rejected, or say why nothing was`);
    }
    for (const other of Array.isArray(f.conflicts_with) ? f.conflicts_with : []) {
      const o = ids.get(other);
      if (!o) problems.push(`${e.file}: conflicts_with ${other}, which does not exist`);
      else if (!(o.fields.conflicts_with ?? []).includes(f.id)) problems.push(`${e.file}: conflict with ${other} is not recorded on both sides`);
    }
    if (f.superseded_by && !ids.has(f.superseded_by)) problems.push(`${e.file}: superseded_by ${f.superseded_by}, which does not exist`);
    if (f.status === "superseded" && !f.superseded_by) problems.push(`${e.file}: superseded but names no successor`);
  }
  return problems;
}

const active = (entries) => entries.filter((e) => e.fields.status === "active");
const byDate = (a, b) => String(a.fields.decided_on).localeCompare(String(b.fields.decided_on)) || a.file.localeCompare(b.file);

export function buildCore(entries) {
  const lines = [
    BANNER,
    "# Team memory — core",
    "",
    "Read this at the start of every session. Tier-0 entries only, 40 lines at most. Open the entry for the why; `INDEX.md` lists the rest.",
    "",
  ];
  for (const e of active(entries).filter((x) => x.fields.tier === 0).sort(byDate)) {
    lines.push(`- **${e.fields.summary}** ${e.fields.purpose} → \`entries/${e.file}\``);
  }
  return `${lines.join("\n")}\n`;
}

export function buildIndex(entries, topics) {
  const lines = [
    BANNER,
    "# Team memory — index",
    "",
    "Scan the topic you are about to work in, and open only the entries that match. Policy: `POLICY.md`.",
  ];
  for (const topic of topics) {
    const rows = active(entries).filter((e) => (e.fields.topics ?? []).includes(topic)).sort(byDate);
    if (rows.length === 0) continue;
    lines.push("", `## ${topic}`, "");
    for (const e of rows) {
      const tier = e.fields.tier === 0 ? " (core)" : "";
      lines.push(`- [${e.fields.kind}]${tier} ${e.fields.summary} — \`entries/${e.file}\` · ${(e.fields.paths ?? []).join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function loadMemory(memoryDir) {
  const entriesDir = join(memoryDir, "entries");
  const files = existsSync(entriesDir) ? readdirSync(entriesDir).filter((f) => f.endsWith(".md")).sort() : [];
  const entries = files.map((f) => parseEntry(readFileSync(join(entriesDir, f), "utf8"), f));
  const topics = parseTopics(readFileSync(join(memoryDir, "topics.yaml"), "utf8"));
  return { entries, topics };
}

/** Problems, plus the two derived files as they should read. */
export function derive(memoryDir) {
  const { entries, topics } = loadMemory(memoryDir);
  const core = buildCore(entries);
  const problems = validate(entries, topics);
  const coreLines = core.trimEnd().split("\n").length;
  if (coreLines > CORE_LINE_LIMIT) problems.push(`CORE.md would be ${coreLines} lines; the limit is ${CORE_LINE_LIMIT} — move an entry to tier 1`);
  return { problems, core, index: buildIndex(entries, topics) };
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
if (isMain) {
  const memoryDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "memory");
  const { problems, core, index } = derive(memoryDir);
  const corePath = join(memoryDir, "CORE.md");
  const indexPath = join(memoryDir, "INDEX.md");
  if (process.argv.includes("--check")) {
    const stale = [
      [corePath, core],
      [indexPath, index],
    ].filter(([p, want]) => !existsSync(p) || readFileSync(p, "utf8") !== want).map(([p]) => `${p} is stale — run node scripts/memory-index.mjs`);
    for (const p of [...problems, ...stale]) console.error(`memory-index: ${p}`);
    process.exitCode = problems.length + stale.length === 0 ? 0 : 1;
  } else if (problems.length > 0) {
    for (const p of problems) console.error(`memory-index: ${p}`);
    process.exitCode = 1;
  } else {
    writeFileSync(corePath, core);
    writeFileSync(indexPath, index);
    console.log(`memory-index: wrote CORE.md and INDEX.md`);
  }
}
