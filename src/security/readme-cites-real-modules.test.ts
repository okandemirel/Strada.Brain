/**
 * The security docs may only describe controls that exist on disk.
 *
 * Audited 2026-09-02: commit 9d34babb (2026-03-22) deleted rbac.ts, dm-state.ts,
 * filesystem-security.ts, dependency-security.ts, secret-rotation.ts,
 * src/network/firewall.ts and the src/security/index.ts barrel as dead code —
 * and never touched src/security/README.md or SECURITY.md. For five months
 * both documents described a chroot jail, a default-deny RBAC policy engine,
 * a firewall, a security audit logger and live .env rotation in present
 * tense. A reader auditing the deployment concluded those controls were in
 * place; none were. src/tests/unit/docs-consistency.test.ts only phrase-matches
 * and never checks that a cited module path exists, which is how this stood.
 *
 * This test is mechanical: every module path a security doc cites must
 * resolve to a real file, and the two claims that were false against code
 * that DOES exist (Slack allowlist default, sanitizer reach) must not return.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WRITE_TOOLS, READ_TOOLS } from "./read-only-guard.js";
import { DEFAULT_SECRET_PATTERNS } from "./secret-patterns.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function citedModulePaths(markdown: string): string[] {
  // `foo.ts`, `network/firewall.ts`, `src/security/rbac.ts`
  const out = new Set<string>();
  for (const m of markdown.matchAll(/`([\w./-]+?\.ts)`/g)) {
    out.add(m[1]);
  }
  return [...out];
}

describe("src/security/README.md cites only modules that exist", () => {
  const readme = readFileSync(resolve(here, "README.md"), "utf8");

  it("every backticked module path resolves under src/security/", () => {
    const missing = citedModulePaths(readme)
      .map((p) => (p.startsWith("src/") ? resolve(repoRoot, p) : resolve(here, p)))
      .filter((abs) => !existsSync(abs))
      .map((abs) => abs.slice(repoRoot.length + 1));
    expect(missing).toEqual([]);
  });

  it("does not describe the deleted modules or their classes", () => {
    for (const ghost of [
      "index.ts",
      "rbac.ts",
      "dm-state.ts",
      "filesystem-security.ts",
      "dependency-security.ts",
      "secret-rotation.ts",
      "firewall.ts",
      "initializeSecurity",
      "createSecurityMiddleware",
      "RbacManager",
      "ChrootJail",
      "FileIntegrityMonitor",
      "SecretRotationWatcher",
      "SecurityAuditLogger",
      "DMStateManager",
    ]) {
      expect(readme.includes(ghost), `README still mentions ${ghost}`).toBe(false);
    }
  });

  it("states the Slack allowlist default the code actually has (closed)", () => {
    // src/channels/slack/app.ts passes "closed" to isAllowedBySingleIdPolicy
    // for both the workspace and the user allowlist; an empty list denies.
    expect(readme).not.toMatch(/Slack:.*Open by default/);
  });

  it("does not claim the 26-pattern sanitizer runs on tool outputs", () => {
    // The tool-result path (orchestrator.ts sanitizeToolResult) applies one
    // API-key regex, not DEFAULT_SECRET_PATTERNS; sanitizeSecrets is applied
    // to task results, memory writes, channel sends and provider errors.
    expect(readme).not.toMatch(/patterns applied to all tool outputs/);
  });
});

describe("SECURITY.md cites only modules that exist", () => {
  const securityMd = readFileSync(resolve(repoRoot, "SECURITY.md"), "utf8");

  it("every cited src/security path resolves", () => {
    const missing = citedModulePaths(securityMd)
      .filter((p) => p.startsWith("src/"))
      .filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it("does not tell an operator to rely on a scanner or audit logger that is not in the tree", () => {
    expect(securityMd).not.toContain("dependency-security.ts");
    expect(securityMd).not.toMatch(/the security audit logger records/);
    expect(securityMd).not.toContain("### 8. Role-Based Access Control (RBAC)");
    expect(securityMd).not.toMatch(/A full RBAC system/);
  });
});

describe("the documented write-tool count is the one the guard enforces", () => {
  // Audited 2026-09-02: src/security/README.md said "22 write tools" in three
  // places and README.md said "23", while WRITE_TOOLS holds 23 entries — the
  // src/security count was never updated when dotnet_build/dotnet_test moved
  // out of READ_TOOLS. An operator reading src/security/README.md to decide
  // what READ_ONLY_MODE actually removes got a list two tools short of the
  // guard, and no test compared the prose to the set. These read the docs off
  // disk so the number cannot drift away from WRITE_TOOLS again.
  const securityReadme = readFileSync(resolve(here, "README.md"), "utf8");
  const rootReadme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
  const securityMd = readFileSync(resolve(repoRoot, "SECURITY.md"), "utf8");

  /** Every "<N> write tools" / "Write tool blocking (<N> tools)" number in a doc. */
  function documentedCounts(markdown: string): number[] {
    const out: number[] = [];
    for (const m of markdown.matchAll(/(\d+)\s+write tools/gi)) out.push(Number(m[1]));
    for (const m of markdown.matchAll(/Write tool blocking \((\d+) tools?\)/gi)) {
      out.push(Number(m[1]));
    }
    return out;
  }

  it("src/security/README.md states WRITE_TOOLS.size everywhere it states a count", () => {
    const counts = documentedCounts(securityReadme);
    expect(counts.length, "src/security/README.md states no write-tool count").toBeGreaterThan(0);
    expect(counts).toEqual(counts.map(() => WRITE_TOOLS.size));
  });

  it("README.md states WRITE_TOOLS.size everywhere it states a count", () => {
    const counts = documentedCounts(rootReadme);
    expect(counts.length, "README.md states no write-tool count").toBeGreaterThan(0);
    expect(counts).toEqual(counts.map(() => WRITE_TOOLS.size));
  });

  it("the Read-Only Guard section enumerates every blocked tool", () => {
    const section = securityReadme.split("## Read-Only Guard")[1]?.split("\n## ")[0] ?? "";
    expect(section, "Read-Only Guard section not found").not.toBe("");
    // The section lists tools grouped by prefix ("File: `write`, `edit`"), so
    // compare on the part after the first underscore.
    const missing = [...WRITE_TOOLS]
      .map((tool) => tool.slice(tool.indexOf("_") + 1))
      .filter((short) => !section.includes(`\`${short}\``));
    expect(missing).toEqual([]);
  });

  it("SECURITY.md never lists a read tool among the blocked write tools", () => {
    const line = securityMd.split("\n").find((l) => l.startsWith("Blocked tools include:")) ?? "";
    expect(line, "SECURITY.md lists no blocked tools").not.toBe("");
    const named = [...line.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((t) => READ_TOOLS.has(t))).toEqual([]);
    // and everything it names must actually be blocked
    expect(named.filter((t) => !WRITE_TOOLS.has(t))).toEqual([]);
  });

  it("SECURITY.md does not promise the 26-pattern sanitizer on tool output", () => {
    const section = securityMd.split("### 4. Secret Sanitizer")[1]?.split("\n### ")[0] ?? "";
    expect(section, "SECURITY.md section 4 not found").not.toBe("");
    // sanitizeSecrets() runs on task results, memory writes, learning storage,
    // channel sends, provider errors and dashboard config — not on tool
    // results, which get sanitizeToolResult's single API-key regex instead.
    expect(section).not.toMatch(/All tool output is scrubbed/i);
    expect(section).toMatch(/sanitizeToolResult/);
  });

  it("README.md states the real pattern count and does not claim it covers tool output", () => {
    // Same defect, second doc: "24 regex patterns ... in all tool outputs".
    // DEFAULT_SECRET_PATTERNS holds 26 and none of them runs on a tool result.
    const layer = rootReadme.split("### Layer 5: Secret Sanitizer")[1]?.split("\n### ")[0] ?? "";
    expect(layer, "README.md Layer 5 not found").not.toBe("");
    const stated = layer.match(/(\d+)\s+regex patterns/i);
    expect(stated, "README.md Layer 5 states no pattern count").not.toBeNull();
    expect(Number(stated![1])).toBe(DEFAULT_SECRET_PATTERNS.length);
    expect(layer).not.toMatch(/in all tool outputs/i);
  });
});
