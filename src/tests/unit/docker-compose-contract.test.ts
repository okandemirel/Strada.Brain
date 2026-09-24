/**
 * docker-compose.yml published-port contract (OPS-4).
 *
 * A `ports:` entry without a host IP binds 0.0.0.0 on the host, and Docker's
 * own iptables rules put it in front of host firewalls such as ufw. The
 * dashboard, the metrics exporter, Prometheus and Grafana were all published
 * that way, so the nginx/TLS entry point could simply be walked around. Only
 * nginx's 80/443 may be public; everything else binds the host's loopback.
 *
 * Asserted over the file text: Docker cannot run here, and the property is
 * what the file says to publish.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const compose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");

interface PublishedPort {
  service: string;
  mapping: string;
}

/** Every `ports:` list item, with the service it belongs to. */
function publishedPorts(source: string): PublishedPort[] {
  const found: PublishedPort[] = [];
  let inServices = false;
  let service = "";
  let inPorts = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      inPorts = false;
      continue;
    }
    if (!inServices) continue;
    const serviceMatch = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1]!;
      inPorts = false;
      continue;
    }
    if (/^ {4}ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (!inPorts) continue;
    const item = /^ {6}-\s*["']?([^"'#\s]+)["']?/.exec(line);
    if (item) {
      found.push({ service, mapping: item[1]! });
    } else if (/^ {4}\S/.test(line)) {
      inPorts = false;
    }
  }
  return found;
}

/** nginx's public HTTP/HTTPS listeners are the one intended exposure. */
function isPublicEntryPoint(port: PublishedPort): boolean {
  return port.service === "nginx" && /:(80|443)$/.test(port.mapping);
}

describe("docker-compose.yml published ports", () => {
  const ports = publishedPorts(compose);

  it("finds the published ports it is meant to police", () => {
    const services = new Set(ports.map((p) => p.service));
    expect(services).toEqual(new Set(["strada-brain", "nginx", "prometheus", "grafana"]));
  });

  it("binds every published port except nginx 80/443 to the host's loopback", () => {
    const exposed = ports
      .filter((p) => !isPublicEntryPoint(p))
      .filter((p) => !p.mapping.startsWith("127.0.0.1:"));
    expect(exposed, "published on every interface").toEqual([]);
  });

  it("does not enable Prometheus's unauthenticated lifecycle API", () => {
    const commandLines = compose.split(/\r?\n/).filter((line) => /^\s*-\s*['"]?--/.test(line));
    expect(commandLines.some((line) => line.includes("--web.enable-lifecycle"))).toBe(false);
  });
});

describe("docker-compose.yml Host allow-list (CHN-2)", () => {
  it("lets Prometheus scrape the exporter by its compose hostname", () => {
    // monitoring/prometheus.yml scrapes `strada-brain:9090`, and every listener
    // refuses a Host it is not told about.
    const scrape = readFileSync(path.join(repoRoot, "monitoring", "prometheus.yml"), "utf8");
    expect(scrape).toContain("strada-brain:9090");
    expect(compose).toMatch(/^\s*- HTTP_ALLOWED_HOSTS=strada-brain,\$\{HTTP_ALLOWED_HOSTS:-\}\s*$/m);
  });
});

describe("docker/docker-compose.security.yml published ports", () => {
  it("binds every published port to the host's loopback (it runs no nginx)", () => {
    const hardened = readFileSync(path.join(repoRoot, "docker", "docker-compose.security.yml"), "utf8");
    const ports = publishedPorts(hardened);
    expect(ports.length).toBeGreaterThan(0);
    expect(ports.filter((p) => !p.mapping.startsWith("127.0.0.1:")), "published on every interface").toEqual([]);
  });
});

/** The lines of one service's block: everything indented under `  <name>:`. */
function serviceBlock(source: string, name: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** Persistent mount targets (`volumes:` long and short syntax) of a service block. */
function volumeTargets(block: string[]): string[] {
  const targets: string[] = [];
  let inVolumes = false;
  for (const line of block) {
    if (/^ {4}\S/.test(line)) {
      inVolumes = /^ {4}volumes:\s*$/.test(line);
      continue;
    }
    if (!inVolumes) continue;
    const long = /^\s+target:\s*["']?([^"'\s#]+)/.exec(line);
    if (long) targets.push(long[1]!);
    const short = /^ {6}-\s*["']?[^\s:"']+:(\/[^:"'\s]+)/.exec(line);
    if (short) targets.push(short[1]!);
  }
  return targets;
}

/** `- KEY=value` entries of a service's `environment:` list. */
function serviceEnvironment(block: string[]): Map<string, string> {
  const env = new Map<string, string>();
  let inEnv = false;
  for (const line of block) {
    if (/^ {4}\S/.test(line)) {
      inEnv = /^ {4}environment:\s*$/.test(line);
      continue;
    }
    const entry = inEnv ? /^ {6}-\s*([A-Z0-9_]+)=(.*)$/.exec(line) : null;
    if (entry) env.set(entry[1]!, entry[2]!.trim());
  }
  return env;
}

/** `ENV` values of a Dockerfile's `production` stage (both `A=b` and `A b` forms). */
function productionStageEnv(dockerfile: string): { env: Map<string, string>; user: string | undefined; runs: string[] } {
  const joined = dockerfile.replace(/\\\r?\n/g, " ");
  const stage = joined.split(/^FROM\s+/m).find((chunk) => /^\S+\s+AS\s+production\b/i.test(chunk)) ?? "";
  const env = new Map<string, string>();
  let user: string | undefined;
  const runs: string[] = [];
  for (const raw of stage.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (/^ENV\s/i.test(line)) {
      const body = line.slice(4).trim();
      const pairs = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S*)/g)];
      if (pairs.length > 0) {
        for (const pair of pairs) env.set(pair[1]!, pair[2]!.replace(/^"|"$/g, ""));
      } else {
        const [key, ...rest] = body.split(/\s+/);
        env.set(key!, rest.join(" "));
      }
    } else if (/^USER\s/i.test(line)) {
      user = line.slice(5).trim().split(":")[0];
    } else if (/^RUN\s/i.test(line)) {
      runs.push(line);
    }
  }
  return { env, user, runs };
}

const covers = (mount: string, target: string) => target === mount || target.startsWith(`${mount}/`);

/**
 * OPS-3. An image has no .git, so its config root is STRADA_HOME (else
 * $HOME/.strada), and startup mkdir's it before any handler is installed. Both
 * compose files run with `read_only: true`, and neither mounted anything there,
 * so the container died on EROFS and restart-looped; nginx, which waits for a
 * healthy backend, never started.
 */
describe.each([
  ["docker-compose.yml", "Dockerfile"],
  [path.join("docker", "docker-compose.security.yml"), path.join("docker", "Dockerfile.hardened")],
])("%s keeps the config root writable (OPS-3)", (composeFile, dockerfilePath) => {
  const composeSource = readFileSync(path.join(repoRoot, composeFile), "utf8");
  const dockerfile = productionStageEnv(readFileSync(path.join(repoRoot, dockerfilePath), "utf8"));
  const block = serviceBlock(composeSource, "strada-brain");
  const composeEnv = serviceEnvironment(block);
  const env = (key: string) => composeEnv.get(key) ?? dockerfile.env.get(key);

  it("runs strada-brain with a read-only root filesystem (the reason this matters)", () => {
    expect(block.some((line) => /^ {4}read_only:\s*true\s*$/.test(line))).toBe(true);
  });

  it("sets an absolute STRADA_HOME in the image", () => {
    expect(env("STRADA_HOME"), "STRADA_HOME is not set").toMatch(/^\//);
  });

  it("mounts a persistent volume over STRADA_HOME and $HOME/.strada", () => {
    const targets = volumeTargets(block);
    const home = env("HOME");
    expect(home, "HOME is not set").toMatch(/^\//);
    for (const required of [env("STRADA_HOME")!, `${home}/.strada`]) {
      expect(targets.some((mount) => covers(mount, required)), `${required} is on the read-only rootfs`).toBe(true);
    }
  });

  it("creates STRADA_HOME in the image and gives it to the runtime user", () => {
    const stradaHome = env("STRADA_HOME")!;
    const user = dockerfile.user;
    expect(user, "the production stage has no USER").toBeDefined();
    const creates = dockerfile.runs.find((run) => /\bmkdir\b/.test(run) && run.includes(stradaHome));
    expect(creates, `nothing creates ${stradaHome}`).toBeDefined();
    const chown = /chown\s+(?:-R\s+)?([^\s:]+)(?::\S+)?\s+(\S+)/.exec(creates!);
    expect(chown?.[1]).toBe(user);
    expect(covers(chown![2]!.replace(/\/+$/, ""), stradaHome)).toBe(true);
  });
});
