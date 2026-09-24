/**
 * scripts/deploy.sh, run for real against a stub `docker` (OPS-7, OPS-8).
 *
 * The script could never report success: it waited for a container named
 * `strata-nginx` (compose names it `strada-nginx`) and matched health with
 * `grep healthy`, which "unhealthy" satisfies too. `-b` backed up a volume name
 * compose never creates (compose prefixes the project), so the backup directory
 * was never made and the next `cp` aborted the deploy under `set -e`;
 * `--rollback` restored into a fresh orphan volume, and ran before compose was
 * even detected. The env file was `source`d, i.e. executed as bash.
 *
 * Each case copies deploy.sh into a throwaway project root (the script derives
 * every path from its own location) and puts a stub `docker` first on PATH that
 * records its arguments and answers like a compose project named `stradatest`.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const STUB_DOCKER = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
has() { local want="$1"; shift; for a in "$@"; do [[ "$a" == "$want" ]] && return 0; done; return 1; }
case "$1" in
  compose)
    if has config "$@"; then echo "name: stradatest"; fi
    exit 0 ;;
  volume)
    if [[ "$2" == ls ]]; then
      for a in "$@"; do
        case "$a" in label=com.docker.compose.volume=*) echo "stradatest_\${a#label=com.docker.compose.volume=}" ;; esac
      done
      exit 0
    fi
    if [[ "$2" == inspect ]]; then [[ "$3" == stradatest_* ]]; exit $?; fi
    exit 0 ;;
  inspect)
    name="\${!#}"
    case "$name" in
      strada-brain) echo "\${STUB_BRAIN_HEALTH:-healthy}" ;;
      strada-nginx) echo "\${STUB_NGINX_HEALTH:-healthy}" ;;
      *) echo "Error: No such object: $name" >&2; exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`;

interface Project {
  root: string;
  stubLog: string;
}

const projects: string[] = [];

function makeProject(envFile = "ANTHROPIC_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=123:abc\n"): Project {
  const root = mkdtempSync(path.join(os.tmpdir(), "strada-deploy-"));
  projects.push(root);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "bin"));
  copyFileSync(path.join(repoRoot, "scripts", "deploy.sh"), path.join(root, "scripts", "deploy.sh"));
  copyFileSync(path.join(repoRoot, "docker-compose.yml"), path.join(root, "docker-compose.yml"));
  writeFileSync(path.join(root, ".env"), envFile, "utf8");
  writeFileSync(path.join(root, "bin", "docker"), STUB_DOCKER, { encoding: "utf8", mode: 0o755 });
  return { root, stubLog: path.join(root, "docker-calls.log") };
}

function runDeploy(project: Project, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [path.join(project.root, "scripts", "deploy.sh"), ...args], {
    cwd: project.root,
    env: {
      ...process.env,
      PATH: `${path.join(project.root, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}`,
      STUB_LOG: project.stubLog,
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const calls = existsSync(project.stubLog) ? readFileSync(project.stubLog, "utf8").split("\n").filter(Boolean) : [];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
}

function composeContainerNames(): Set<string> {
  const compose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
  return new Set([...compose.matchAll(/^\s+container_name:\s*(\S+)\s*$/gm)].map((m) => m[1]!));
}

afterEach(() => {
  for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("scripts/deploy.sh", () => {
  it("backs up the project-prefixed volumes and succeeds when both containers are healthy", () => {
    const project = makeProject();
    const { status, output, calls } = runDeploy(project, ["-f", "-b"]);
    expect(status, output).toBe(0);
    expect(output).toContain("Deployment completed successfully");

    const backups = readdirSync(path.join(project.root, "backups"));
    expect(backups).toHaveLength(1);
    const backup = path.join(project.root, "backups", backups[0]!);
    expect(existsSync(path.join(backup, ".env"))).toBe(true);
    expect(existsSync(path.join(backup, "docker-compose.yml"))).toBe(true);
    for (const volume of ["stradatest_strada-memory", "stradatest_strada-home"]) {
      expect(calls.some((call) => call.startsWith("run --rm") && call.includes(`-v ${volume}:/data:ro`)), volume).toBe(true);
    }
  });

  it("inspects the container names docker-compose.yml declares, and nothing else", () => {
    const project = makeProject();
    const { status, calls } = runDeploy(project, ["-f"]);
    expect(status).toBe(0);
    const inspected = new Set(calls.filter((call) => call.startsWith("inspect ")).map((call) => call.split(" ").at(-1)!));
    expect(inspected).toEqual(new Set(["strada-brain", "strada-nginx"]));
    const declared = composeContainerNames();
    for (const name of inspected) expect(declared.has(name), name).toBe(true);
  });

  it("does not count an unhealthy backend as healthy", () => {
    const project = makeProject();
    const { status, output } = runDeploy(project, ["-f"], {
      STUB_BRAIN_HEALTH: "unhealthy",
      DEPLOY_HEALTH_TIMEOUT: "1",
      DEPLOY_HEALTH_INTERVAL: "1",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("failed to become healthy");
    expect(output).not.toContain("Deployment completed successfully");
  });

  it("reads the env file without executing it", () => {
    const marker = path.join(os.tmpdir(), `strada-deploy-marker-${process.pid}-${Date.now()}`);
    const project = makeProject(
      `ANTHROPIC_API_KEY=sk test with spaces\nTELEGRAM_BOT_TOKEN="123:abc"\nOTHER=$(touch ${marker})\n`,
    );
    const { status, output } = runDeploy(project, ["-c"]);
    expect(status, output).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(output).not.toContain("command not found");
    expect(output).not.toContain("Missing optional/required variables");
  });

  it("rolls back into the volumes the stack mounts", () => {
    const project = makeProject();
    const backup = path.join(project.root, "backups", "backup_20200101_000000");
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(backup, "strada-memory.tar.gz"), "");
    writeFileSync(path.join(backup, "strada-home.tar.gz"), "");
    const { status, output, calls } = runDeploy(project, ["--rollback"]);
    expect(status, output).toBe(0);
    const restores = calls.filter((call) => call.startsWith("run --rm"));
    expect(restores.some((call) => call.includes("-v stradatest_strada-memory:/data "))).toBe(true);
    expect(restores.some((call) => call.includes("-v stradatest_strada-home:/data "))).toBe(true);
    expect(restores.some((call) => /-v strada-memory:/.test(call))).toBe(false);
  });
});
