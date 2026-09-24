#!/usr/bin/env node
/**
 * audit-env-coverage.mjs
 *
 * Cross-checks the environment variables the application READS against what
 * .env.example documents and what the deploy artifacts (Dockerfiles, compose
 * files) SET. Exits 1 on drift, so `npm run audit:env` can gate.
 *
 * It used to compare .env.example against the `EnvVarName` type union, not
 * against actual reads (OPS-26): it reported ~30 false "unused" variables that
 * are read via `process.env[...]`, missed ~40 real reads outside the union,
 * never looked at the deploy files, and always exited 0.
 *
 * "Read" means a literal name in non-test source under src/: `env["X"]`,
 * `env.X` (including `process.env.X`), or `const SOMETHING_ENV = "X"`.
 *
 * Usage:  node scripts/audit-env-coverage.mjs [--root <dir>]
 * npm:    npm run audit:env
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories under src/ that hold tests or test helpers, never runtime reads. */
const TEST_DIRECTORIES = new Set(["tests", "__tests__", "test-support", "node_modules"]);

// `env["X"]` / `activeEnv["X"]` / `process.env.X`, and a name held in a
// `const SOMETHING_ENV = "X"` or `const SOMETHING_VAR = "X"`.
const READ_PATTERN =
  /\b\w*[eE]nv\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]|\b\w*[eE]nv\.([A-Z][A-Z0-9_]*)\b|\bconst\s+\w+_(?:ENV|VAR)\s*=\s*["']([A-Z][A-Z0-9_]*)["']/g;

/**
 * Families read through a computed name, e.g. `env[`${p.toUpperCase()}_MODEL`]`.
 * A documented name matching `name` counts as read when some source matches
 * `evidence`.
 */
const DYNAMIC_FAMILIES = [
  { name: /^[A-Z][A-Z0-9]*_MODEL$/, evidence: /\[`\$\{\w+\.toUpperCase\(\)\}_MODEL`\]/ },
];

/**
 * Documented, intended to work, but not read today. Listed so the audit can
 * gate without hiding them: each is printed on every run.
 */
export const KNOWN_UNREAD = new Map([]);

/**
 * Read by the code but deliberately NOT in .env.example: set by the runtime,
 * the launcher, the OS, CI or a test harness, not by an operator.
 */
export const NOT_FOR_ENV_FILE = new Map([
  ["APPDATA", "OS"],
  ["CI", "CI runners"],
  ["COMSPEC", "OS"],
  ["ComSpec", "OS"],
  ["FORCE_COLOR", "terminal"],
  ["HOME", "OS"],
  ["LANG", "OS"],
  ["LOCALAPPDATA", "OS"],
  ["NODE_ENV", "Node/deployment convention"],
  ["NVM_DIR", "nvm"],
  ["PATH", "OS"],
  ["PATHEXT", "OS"],
  ["SHELL", "OS"],
  ["SYSTEMROOT", "OS (Windows)"],
  ["TEMP", "OS"],
  ["TERM", "terminal"],
  ["TMP", "OS"],
  ["TMPDIR", "OS"],
  ["USER", "OS"],
  ["USERNAME", "OS"],
  ["USERPROFILE", "OS"],
  ["VITEST", "test runner"],
  ["XDG_CONFIG_HOME", "OS"],
  ["STRADA_DAEMON", "set by the gateway for its daemon child process"],
  ["STRADA_HOME", "deployment: where the config root (and this .env) lives"],
  ["STRADA_INSTALL_ROOT", "set by the launcher"],
  ["STRADA_LAUNCH_CWD", "set by the launcher"],
  ["STRADA_LAUNCHER_PATH", "set by the launcher"],
  ["STRADA_NODE_PATH", "set by the launcher"],
  ["STRADA_SOURCE_CHECKOUT", "deployment: set by the launcher / service unit"],
]);

/** Every env var name non-test source under `srcDir` reads. */
export function collectEnvReads(srcDir = path.join(ROOT, "src")) {
  return scanSources(srcDir).reads;
}

/** Literal reads plus the computed-name families some source actually uses. */
function scanSources(srcDir) {
  const reads = new Set();
  const families = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!TEST_DIRECTORIES.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(READ_PATTERN)) reads.add(m[1] ?? m[2] ?? m[3]);
        for (const family of DYNAMIC_FAMILIES) if (family.evidence.test(text)) families.add(family);
      }
    }
  };
  walk(srcDir);
  return { reads, families: [...families] };
}

/** Names .env.example documents, as `KEY=` or commented `# KEY=`. */
export function collectDocumentedVars(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const stripped = line.trim().replace(/^#+\s*/, "");
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(stripped);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Names the deploy artifacts set: Dockerfile `ENV`, compose `environment:` lists. */
export function collectDeployVars(root = ROOT) {
  const found = new Map();
  const add = (name, file) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(file);
  };
  for (const rel of ["Dockerfile", path.join("docker", "Dockerfile.hardened")]) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
      const body = /^\s*ENV\s+(.*)$/i.exec(line.replace(/#.*$/, ""))?.[1];
      if (!body) continue;
      const pairs = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
      for (const name of pairs.length > 0 ? pairs : [body.trim().split(/\s+/)[0]]) add(name, rel);
    }
  }
  for (const rel of ["docker-compose.yml", "docker-compose.dev.yml", path.join("docker", "docker-compose.security.yml")]) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s+-\s+([A-Z][A-Z0-9_]*)=/gm)) add(m[1], rel);
  }
  return found;
}

/** Vars deploy artifacts may set without the app reading them (npm, Grafana, nginx …). */
const DEPLOY_EXTERNAL = /^(NPM_CONFIG_|GF_|NGINX_)/;

export function audit(root = ROOT) {
  const { reads, families } = scanSources(path.join(root, "src"));
  const documented = collectDocumentedVars(readFileSync(path.join(root, ".env.example"), "utf8"));
  const deploy = collectDeployVars(root);
  const isRead = (v) => reads.has(v) || families.some((family) => family.name.test(v));
  const documentedUnread = [...documented].filter((v) => !isRead(v)).sort();
  return {
    reads,
    documented,
    undocumented: [...reads].filter((v) => !documented.has(v) && !NOT_FOR_ENV_FILE.has(v)).sort(),
    unread: documentedUnread.filter((v) => !KNOWN_UNREAD.has(v)),
    knownUnread: documentedUnread.filter((v) => KNOWN_UNREAD.has(v)).map((v) => `${v} — ${KNOWN_UNREAD.get(v)}`),
    deployUnread: [...deploy.keys()]
      .filter((v) => !reads.has(v) && !NOT_FOR_ENV_FILE.has(v) && !DEPLOY_EXTERNAL.test(v))
      .sort()
      .map((v) => `${v} (${[...deploy.get(v)].join(", ")})`),
  };
}

function main() {
  // --root <dir> audits another tree (used by the contract test).
  const rootIndex = process.argv.indexOf("--root");
  const result = audit(rootIndex === -1 ? ROOT : path.resolve(process.argv[rootIndex + 1] ?? "."));
  console.log("=== Strada.Brain — Env-Var Coverage Audit ===\n");
  console.log(`Read by src/: ${result.reads.size}   Documented in .env.example: ${result.documented.size}\n`);
  const report = (title, items) => {
    if (items.length === 0) {
      console.log(`✓  ${title}: none`);
      return;
    }
    console.log(`✗  ${title} (${items.length}):`);
    for (const item of items) console.log(`   - ${item}`);
  };
  report("Read by the code but not documented in .env.example", result.undocumented);
  report("Documented in .env.example but never read", result.unread);
  report("Set by a Dockerfile/compose file but never read", result.deployUnread);
  if (result.knownUnread.length > 0) {
    console.log(`\n⚠  Known: documented but not read yet (${result.knownUnread.length}, not counted as drift):`);
    for (const item of result.knownUnread) console.log(`   - ${item}`);
  }
  const drift = result.undocumented.length + result.unread.length + result.deployUnread.length;
  if (drift > 0) {
    console.log(
      "\nDocument the variable in .env.example, delete the stale entry, or — for a" +
        "\nvariable an operator never sets — add it to NOT_FOR_ENV_FILE with a reason.",
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
