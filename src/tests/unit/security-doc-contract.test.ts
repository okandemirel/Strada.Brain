/**
 * SECURITY.md must describe the enforcement the code performs (SEC-10).
 *
 * It promised controls nothing runs: JWT authentication on the web channel,
 * approval of daemon write tools, TLS hardening and certificate pinning, four
 * selectable confirmation levels, an open-by-default Slack allowlist and a
 * shell "whitelist". Operators plan deployments around this file.
 *
 * Each assertion reads the CODE fact first (is there a caller, what does the
 * policy pass) and then checks the prose against it, so wiring a control in
 * later fails here until the document is updated to say so.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
const securityMd = read("SECURITY.md");
const securityReadme = read(path.join("src", "security", "README.md"));

/** Non-test TypeScript sources under src/, as [relative path, text]. */
function productionSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["tests", "__tests__", "test-support", "node_modules"].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push([path.relative(repoRoot, full).split(path.sep).join("/"), readFileSync(full, "utf8")]);
      }
    }
  };
  walk(path.join(repoRoot, "src"));
  return out;
}

const sources = productionSources();
const callersOf = (pattern: RegExp, except: string) =>
  sources.filter(([rel, text]) => rel !== except && pattern.test(text)).map(([rel]) => rel);

/** The body of `### <n>. …` in SECURITY.md. */
function section(n: number): string {
  const start = securityMd.search(new RegExp(`^### ${n}\\. `, "m"));
  expect(start, `SECURITY.md has no section ${n}`).toBeGreaterThan(-1);
  const rest = securityMd.slice(start);
  const next = rest.slice(4).search(/^##+ /m);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

describe("SECURITY.md matches enforcement (SEC-10)", () => {
  it("does not claim the web channel authenticates with JWT, since it never touches the JWT module", () => {
    const web = read(path.join("src", "channels", "web", "channel.ts"));
    expect(web).not.toMatch(/auth-hardened|JwtManager|getAuthManager/);
    expect(callersOf(/\bgetAuthManager\(/, "src/security/auth-hardened.ts")).toEqual([]);
    expect(securityMd).not.toMatch(/web channel uses JWT/i);
    expect(securityMd).not.toMatch(/\*\*Web\*\*: JWT-based/);
    expect(section(13)).toMatch(/not used by any channel|no channel authenticates/i);
  });

  it("states the scrypt cost the code uses", () => {
    const n = /scryptSync\([^)]*\{\s*N:\s*(\d+)/.exec(read(path.join("src", "security", "auth-hardened.ts")))?.[1];
    expect(n).toBeDefined();
    for (const [name, doc] of [["SECURITY.md", securityMd], ["src/security/README.md", securityReadme]] as const) {
      const stated = [...doc.matchAll(/N=(\d+)/g)].map((m) => m[1]);
      expect(stated.length, `${name} states no scrypt N`).toBeGreaterThan(0);
      expect(stated.every((value) => value === n), `${name} states N=${stated.join(",")}, code uses ${n}`).toBe(true);
    }
  });

  it("marks the daemon tool policy as not enforced while nothing calls it", () => {
    const callers = callersOf(/\.(checkPermission|requestApproval)\(/, "src/daemon/security/daemon-security-policy.ts")
      .filter((rel) => !rel.startsWith("src/daemon/security/"));
    expect(callers, "DaemonSecurityPolicy is now called: update SECURITY.md section 11").toEqual([]);
    const daemon = section(11);
    expect(daemon).toMatch(/not enforced/i);
    expect(daemon).not.toMatch(/Write tools require explicit user approval/);
  });

  it("marks communication.ts as not enforced while nothing imports it", () => {
    const importers = callersOf(/from\s+["'][^"']*communication\.js["']/, "src/security/communication.ts");
    expect(importers, "communication.ts is now imported: update SECURITY.md section 16").toEqual([]);
    expect(section(16)).toMatch(/not enforced/i);
    const row = securityReadme.split("\n").find((line) => line.startsWith("| `communication.ts` | ") && line.length > 60) ?? "";
    expect(row).toMatch(/not enforced/i);
  });

  it("marks the always/destructive_only confirmation levels as not enforced while nothing selects them", () => {
    expect(callersOf(/\.setSessionPrefs\(/, "src/security/dm-policy.ts")).toEqual([]);
    const confirmation = section(6);
    expect(confirmation).toMatch(/\*\*always\*\* and \*\*destructive_only\*\*: defined but \*\*not enforced\*\*/);
    expect(confirmation).not.toMatch(/supports four approval levels/);
  });

  it("states the Slack allowlist default the code has (closed, for users AND workspaces)", () => {
    const slack = read(path.join("src", "channels", "slack", "app.ts"));
    expect([...slack.matchAll(/isAllowedBySingleIdPolicy\([^;]*?"closed"/g)].length).toBeGreaterThanOrEqual(2);
    expect(securityMd).not.toMatch(/Slack.*open by default/i);
    for (const key of ["ALLOWED_SLACK_USER_IDS", "ALLOWED_SLACK_WORKSPACES"]) {
      const row = securityMd.split("\n").find((line) => line.startsWith(`| \`${key}\``)) ?? "";
      expect(row, key).toMatch(/deny all/);
    }
  });

  it("calls the shell check a denylist everywhere", () => {
    expect(securityMd).not.toMatch(/validated against a whitelist/i);
    expect(securityMd).toMatch(/denylist/);
  });
});
