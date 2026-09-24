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
