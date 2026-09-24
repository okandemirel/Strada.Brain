/**
 * docker/security-scan.sh must not report PASSED when it scanned nothing (OPS-20).
 *
 * Without trivy it printed "skipping" and ended "Security scan PASSED", exit 0;
 * an unreadable report counted as zero vulnerabilities (`|| echo 0`). Its
 * posture checks could never pass: they grepped for '"User": "1001"' in an
 * image whose USER is `nodejs`, and for "cap_drop: ALL" in a compose file that
 * writes it as a YAML list.
 *
 * Runs the real script against a stub `docker` (and a stub `trivy` where the
 * case has one), with PATH limited to the tools each case grants.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const roots: string[] = [];

const STUB_DOCKER = `#!/bin/bash
case "$1" in
  images) echo "Size: 1MB" ;;
  inspect)
    case "$*" in
      *Config.User*) echo "\${STUB_IMAGE_USER-nodejs}" ;;
      *Config.Healthcheck*) echo yes ;;
    esac ;;
esac
exit 0
`;

/** Writes the report trivy was asked for; STUB_TRIVY_JSON is the JSON body. */
const STUB_TRIVY = `#!/bin/bash
out=""; format=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift ;;
    --format) format="$2"; shift ;;
  esac
  shift
done
if [ "$format" = json ]; then printf '%s' "\${STUB_TRIVY_JSON}" > "$out"; else echo "table" > "$out"; fi
`;

function which(tool: string): string | undefined {
  const result = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const BASE_TOOLS = ["date", "mkdir", "grep", "cat", "ls"];
const hasTools = [...BASE_TOOLS, "jq"].every((tool) => which(tool) !== undefined);

function runScan(options: { trivy: boolean; env?: Record<string, string> }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "strada-scan-"));
  roots.push(root);
  const dockerDir = path.join(root, "docker");
  const bin = path.join(root, "bin");
  mkdirSync(dockerDir);
  mkdirSync(bin);
  copyFileSync(path.join(repoRoot, "docker", "security-scan.sh"), path.join(dockerDir, "security-scan.sh"));
  copyFileSync(path.join(repoRoot, "docker", "docker-compose.security.yml"), path.join(dockerDir, "docker-compose.security.yml"));
  writeFileSync(path.join(bin, "docker"), STUB_DOCKER, { mode: 0o755 });
  if (options.trivy) writeFileSync(path.join(bin, "trivy"), STUB_TRIVY, { mode: 0o755 });
  for (const tool of [...BASE_TOOLS, "jq"]) symlinkSync(which(tool)!, path.join(bin, tool));

  const result = spawnSync("/bin/bash", ["security-scan.sh", "strada-brain:test"], {
    cwd: dockerDir,
    env: { PATH: bin, HOME: root, ...options.env },
    encoding: "utf8",
    timeout: 60_000,
  });
  const reports = path.join(dockerDir, "security-reports");
  let summary = "";
  try {
    const file = readdirSync(reports).find((name) => name.startsWith("summary-"));
    if (file) summary = readFileSync(path.join(reports, file), "utf8");
  } catch {
    // No reports directory: the script stopped before writing any.
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}`, summary };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32" || !hasTools)("docker/security-scan.sh", () => {
  const clean = JSON.stringify({ Results: [{ Target: "image", Vulnerabilities: [] }] });

  it("fails, and never says PASSED, when trivy is not installed", () => {
    const { status, output } = runScan({ trivy: false });
    expect(status).not.toBe(0);
    expect(output).not.toContain("PASSED");
  });

  it("fails when the Trivy report cannot be read, instead of counting zero vulnerabilities", () => {
    const { status, output } = runScan({ trivy: true, env: { STUB_TRIVY_JSON: "not json" } });
    expect(status).not.toBe(0);
    expect(output).not.toContain("PASSED");
  });

  it("passes a clean scan, and its posture checks can pass for the hardened image", () => {
    const { status, output, summary } = runScan({ trivy: true, env: { STUB_TRIVY_JSON: clean } });
    expect(status, output).toBe(0);
    expect(output).toContain("PASSED");
    for (const check of ["Non-root user", "Read-only rootfs", "No new privileges", "Dropped capabilities", "Health check"]) {
      expect(summary, check).toMatch(new RegExp(`\\| ${check} \\| ✅ PASS \\|`));
    }
  });

  it("reports a root image user as a failed check", () => {
    const { summary } = runScan({ trivy: true, env: { STUB_TRIVY_JSON: clean, STUB_IMAGE_USER: "root" } });
    expect(summary).toMatch(/\| Non-root user \| ❌ FAIL \|/);
  });

  it("fails the scan on a critical vulnerability", () => {
    const critical = JSON.stringify({ Results: [{ Vulnerabilities: [{ Severity: "CRITICAL" }] }] });
    const { status, output } = runScan({ trivy: true, env: { STUB_TRIVY_JSON: critical } });
    expect(status).toBe(1);
    expect(output).toContain("1 critical");
  });
});
