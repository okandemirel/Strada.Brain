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
