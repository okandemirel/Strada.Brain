/**
 * The contracts under docs/contracts/ are rules with teeth, not prose. This
 * file keeps them that way: every contract is well formed, every rule has a
 * detector that exists and names its contract back, the index and the
 * AGENTS.md router point only at contracts that exist, and the number of rules
 * that gate is pinned — a rule cannot quietly stop gating without this diff.
 *
 * Frontmatter is YAML whose structured values are JSON flow style, so it is
 * read here without a YAML library (the project adds no dependencies).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CONTRACTS_DIR = join(REPO, "docs", "contracts");

/** Pinned: move these only in the same change that adds, retires or downgrades a rule. */
const PINNED = { contracts: 5, active: 5, rules: 5, errorRules: 5 };

interface Rule {
  id: string;
  severity: string;
  text: string;
  detector: { kind: string; file: string };
}

interface Contract {
  file: string;
  meta: Record<string, unknown>;
  body: string;
}

/** `key: value` lines, a value continued on indented lines; JSON-looking values parsed as JSON. */
function parseFrontmatter(text: string, file: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`${file}: no frontmatter`);
  const meta: Record<string, unknown> = {};
  let key: string | undefined;
  const raw: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const head = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (head) {
      key = head[1]!;
      raw[key] = head[2]!;
    } else if (key && /^\s+\S/.test(line)) {
      raw[key] += `\n${line}`;
    } else if (line.trim() !== "") {
      throw new Error(`${file}: cannot read frontmatter line ${JSON.stringify(line)}`);
    }
  }
  for (const [k, v] of Object.entries(raw)) {
    const value = v.trim();
    meta[k] = /^[[{"]/.test(value) ? JSON.parse(value) : value;
  }
  return { meta, body: match[2]! };
}

function loadContracts(): Contract[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => {
      const { meta, body } = parseFrontmatter(readFileSync(join(CONTRACTS_DIR, name), "utf8"), name);
      return { file: name, meta, body };
    });
}

function rulesOf(contract: Contract): Rule[] {
  return Array.isArray(contract.meta["rules"]) ? (contract.meta["rules"] as Rule[]) : [];
}

describe("contracts (docs/contracts/)", () => {
  const contracts = loadContracts();
  const ids = new Set(contracts.map((c) => String(c.meta["id"])));

  it("every contract has the fixed anatomy", () => {
    const problems: string[] = [];
    for (const c of contracts) {
      const m = c.meta;
      if (m["id"] !== c.file.replace(/\.md$/, "")) problems.push(`${c.file}: id must equal the file name`);
      if (m["status"] !== "active" && m["status"] !== "draft") problems.push(`${c.file}: status is active or draft`);
      for (const k of ["scope", "read_trigger"]) {
        if (typeof m[k] !== "string" || (m[k] as string).length < 20) problems.push(`${c.file}: ${k} must say something`);
      }
      if (!Array.isArray(m["keywords"]) || m["keywords"].length === 0) problems.push(`${c.file}: keywords missing`);
      if (rulesOf(c).length === 0) problems.push(`${c.file}: a contract without a rule is a note, not a contract`);
      for (const section of ["## Single producer", "## Caller rules", "## Don't"]) {
        if (!c.body.includes(`\n${section}\n`)) problems.push(`${c.file}: missing section "${section}"`);
      }
      for (const related of (m["related"] as string[] | undefined) ?? []) {
        if (!ids.has(related)) problems.push(`${c.file}: related contract "${related}" does not exist`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every rule is keyed by content, appears on its Don't line, and has a live detector that names it back", () => {
    const problems: string[] = [];
    for (const c of contracts) {
      const dont = c.body.slice(c.body.indexOf("\n## Don't\n"));
      for (const rule of rulesOf(c)) {
        const where = `${c.file}#${rule.id}`;
        if (!/^[a-z][a-z0-9-]+$/.test(rule.id) || /^dn-\d+$/.test(rule.id)) {
          problems.push(`${where}: id must be a content key, not a position`);
        }
        if (rule.severity !== "error" && rule.severity !== "warn") problems.push(`${where}: severity is error or warn`);
        if (c.meta["status"] === "draft" && rule.severity === "error") {
          problems.push(`${where}: a draft contract cannot carry an error rule`);
        }
        if (!rule.text) problems.push(`${where}: rule text missing`);
        if (!dont.includes(`{#${rule.id}}`)) problems.push(`${where}: no "{#${rule.id}}" on a Don't line`);
        if (rule.detector?.kind !== "vitest") {
          problems.push(`${where}: no detector (a rule without one is prose, and prose is not enforced)`);
          continue;
        }
        const detector = join(REPO, rule.detector.file);
        if (!existsSync(detector)) {
          problems.push(`${where}: detector ${rule.detector.file} does not exist`);
          continue;
        }
        const source = readFileSync(detector, "utf8");
        if (!source.includes(`docs/contracts/${c.file}`)) {
          problems.push(`${where}: ${rule.detector.file} does not name docs/contracts/${c.file}`);
        }
        if (/\b(?:it|describe|test)\.(?:skip|only|todo)\(/.test(source)) {
          problems.push(`${where}: ${rule.detector.file} skips, focuses or defers a test`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every declared single producer exists and exports what it promises", () => {
    const problems: string[] = [];
    for (const c of contracts) {
      const producer = c.meta["single_producer"] as { file: string; exports: string[] } | undefined;
      if (!producer) continue;
      const path = join(REPO, producer.file);
      if (!existsSync(path)) {
        problems.push(`${c.file}: producer ${producer.file} does not exist`);
        continue;
      }
      const source = readFileSync(path, "utf8");
      for (const name of producer.exports) {
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`);
        if (!exported.test(source)) problems.push(`${c.file}: ${producer.file} does not export ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the index lists every contract and nothing else", () => {
    const index = readFileSync(join(CONTRACTS_DIR, "README.md"), "utf8");
    const linked = [...index.matchAll(/\]\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1]!);
    const files = contracts.map((c) => c.file);
    expect([...new Set(linked)].sort()).toEqual(files);
  });

  it("the AGENTS.md router points at the index and only at contracts that exist", () => {
    const router = readFileSync(join(REPO, "AGENTS.md"), "utf8");
    expect(router).toContain("docs/contracts/README.md");
    const named = [...router.matchAll(/docs\/contracts\/([a-z0-9-]+\.md)/g)].map((m) => m[1]!);
    const missing = named.filter((f) => f !== "README.md" && !existsSync(join(CONTRACTS_DIR, f)));
    expect(missing).toEqual([]);
  });

  it("the number of rules that gate is pinned", () => {
    const rules = contracts.flatMap(rulesOf);
    expect({
      contracts: contracts.length,
      active: contracts.filter((c) => c.meta["status"] === "active").length,
      rules: rules.length,
      errorRules: rules.filter((r) => r.severity === "error").length,
    }).toEqual(PINNED);
  });
});
