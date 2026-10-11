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
 *
 * The pre-checks were GNU-only: `df -BG` is refused by BSD df, the empty result
 * compared as 0, and every macOS deploy died on "Insufficient disk space" with
 * tens of GB free; `free -g || echo "4"` invented 4GB of memory where `free`
 * does not exist; BSD `xargs -I {}` aborted backup pruning under a long path.
 * The BSD df stub reproduces macOS on any host.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  info)
    if [[ "$*" == *MemTotal* && -n "\${STUB_DOCKER_MEMTOTAL:-}" ]]; then echo "$STUB_DOCKER_MEMTOTAL"; fi
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

// BSD (macOS) df: no GNU `-B`, same POSIX `-P -k` columns as GNU df. The mount
// point has a space, as /Volumes/<name> often does on macOS.
const STUB_BSD_DF = `#!/bin/bash
for a in "$@"; do
  case "$a" in
    -*B*|--*)
      echo "df: invalid option -- B" >&2
      echo "usage: df [--libxo] [-b | -g | -H | -h | -k | -m | -P] [-acIilnY] [-,] [-T type] [-t type]" >&2
      exit 1 ;;
  esac
done
if [[ -n "\${STUB_DF_FAIL:-}" ]]; then echo "df: \${STUB_DF_FAIL}" >&2; exit 1; fi
echo "Filesystem     1024-blocks      Used Available Capacity  Mounted on"
echo "/dev/disk3s1s1   482797652  13337956  \${STUB_DF_AVAIL_KB:-46368720}    23%    /Volumes/Work Disk"
`;

interface Project {
  root: string;
  stubLog: string;
}

const projects: string[] = [];

interface ProjectOptions {
  envFile?: string;
  bsdDf?: boolean;
  /** Extra path component under the temp root, to make the project path long. */
  nest?: string;
}

function makeProject(
  envFileOrOptions: string | ProjectOptions = "ANTHROPIC_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=123:abc\n",
): Project {
  const options = typeof envFileOrOptions === "string" ? { envFile: envFileOrOptions } : envFileOrOptions;
  const envFile = options.envFile ?? "ANTHROPIC_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=123:abc\n";
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "strada-deploy-"));
  projects.push(tempRoot);
  const root = options.nest ? path.join(tempRoot, options.nest) : tempRoot;
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  copyFileSync(path.join(repoRoot, "scripts", "deploy.sh"), path.join(root, "scripts", "deploy.sh"));
  copyFileSync(path.join(repoRoot, "docker-compose.yml"), path.join(root, "docker-compose.yml"));
  writeFileSync(path.join(root, ".env"), envFile, "utf8");
  writeFileSync(path.join(root, "bin", "docker"), STUB_DOCKER, { encoding: "utf8", mode: 0o755 });
  if (options.bsdDf) writeFileSync(path.join(root, "bin", "df"), STUB_BSD_DF, { encoding: "utf8", mode: 0o755 });
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

  it("measures free disk space with a BSD df that has no -B", () => {
    const project = makeProject({ bsdDf: true });
    const { status, output } = runDeploy(project, ["-c"]);
    expect(status, output).toBe(0);
    expect(output).toContain("Disk space check passed (44GB available)");
    expect(output).not.toContain("Insufficient disk space");
  });

  it("reports a df that measured nothing as unmeasured, not as a full disk", () => {
    const project = makeProject({ bsdDf: true });
    const { status, output } = runDeploy(project, ["-c"], { STUB_DF_FAIL: "statfs: Permission denied" });
    expect(status).not.toBe(0);
    expect(output).toContain("Could not measure free disk space");
    expect(output).toContain("statfs: Permission denied");
    expect(output).not.toContain("Insufficient disk space");
  });

  it("still refuses a disk measured below 5GB, and says how much it measured", () => {
    const project = makeProject({ bsdDf: true });
    const { status, output } = runDeploy(project, ["-c"], { STUB_DF_AVAIL_KB: String(1024 * 1024) });
    expect(status).not.toBe(0);
    expect(output).toContain("Insufficient disk space");
    expect(output).toContain("1GB available, at least 5GB required");
    expect(output).not.toContain("Disk space check passed");
  });

  // /proc/meminfo cannot be stubbed, so each host checks the source it really has.
  const hasMeminfo = existsSync("/proc/meminfo");

  it.skipIf(hasMeminfo)("says memory was NOT measured when nothing reports it, instead of inventing 4GB", () => {
    const project = makeProject({ bsdDf: true });
    const { status, output } = runDeploy(project, ["-c"]);
    expect(status, output).toBe(0);
    expect(output).toContain("Memory was NOT measured");
    expect(output).not.toContain("Memory check passed");
  });

  it.skipIf(hasMeminfo)("reads memory from the Docker daemon where /proc/meminfo does not exist", () => {
    const project = makeProject({ bsdDf: true });
    const { status, output } = runDeploy(project, ["-c"], { STUB_DOCKER_MEMTOTAL: String(512 * 1024 * 1024) });
    expect(status, output).toBe(0);
    expect(output).toContain("Low memory detected: 512MB total per docker info MemTotal");
    expect(output).not.toContain("Memory was NOT measured");
  });

  it.runIf(hasMeminfo)("reads available memory from /proc/meminfo where it exists", () => {
    const project = makeProject({ bsdDf: true });
    const { status, output } = runDeploy(project, ["-c"]);
    expect(status, output).toBe(0);
    expect(output).toMatch(/(Memory check passed|Low memory detected): \d+MB available per \/proc\/meminfo MemAvailable/);
    expect(output).not.toContain("Memory was NOT measured");
  });

  it("prunes to the newest 10 backups under a project path longer than BSD xargs -I allows", () => {
    const project = makeProject({ bsdDf: true, nest: "p".repeat(200) });
    const backupsDir = path.join(project.root, "backups");
    const old = Array.from({ length: 11 }, (_, i) => `backup_202001${String(i + 1).padStart(2, "0")}_000000`);
    old.forEach((name, i) => {
      const dir = path.join(backupsDir, name);
      mkdirSync(dir, { recursive: true });
      const when = new Date(Date.UTC(2020, 0, i + 1));
      utimesSync(dir, when, when);
    });
    // BSD xargs refuses to build a command whose replacement exceeds 255 bytes.
    expect(path.join(backupsDir, old[0]!).length).toBeGreaterThan(255);

    const { status, output } = runDeploy(project, ["-f", "-b"]);
    expect(status, output).toBe(0);
    const remaining = readdirSync(backupsDir);
    expect(remaining).toHaveLength(10);
    expect(remaining).not.toContain(old[0]);
    expect(remaining).not.toContain(old[1]);
    expect(remaining.filter((name) => !old.includes(name))).toHaveLength(1);
  });
});
