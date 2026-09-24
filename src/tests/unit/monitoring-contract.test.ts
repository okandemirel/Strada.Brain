/**
 * The monitoring profile's config must point at things that exist (OPS-24).
 *
 * prometheus.yml scraped `redis:6379` (Redis does not speak HTTP) and
 * `nginx:9113` (no exporter runs), so both targets were permanently down, and
 * its `replica: '{{.ExternalURL}}'` label was a literal string — Prometheus
 * does not template external labels. The Grafana dashboard JSON was mounted
 * straight into provisioning/dashboards/, which Grafana ignores without a
 * provider file, so the dashboard never loaded.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(repoRoot, ...parts), "utf8");
const prometheus = read("monitoring", "prometheus.yml");
const compose = read("docker-compose.yml");
const active = (text: string) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

describe("monitoring/prometheus.yml", () => {
  it("scrapes only Prometheus itself and the Strada exporter", () => {
    const targets = [...active(prometheus).matchAll(/targets:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => m[1]!.split(","))
      .map((target) => target.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    const exporterPort = /^\s*- PROMETHEUS_PORT=(\d+)\s*$/m.exec(compose)?.[1];
    expect(exporterPort, "docker-compose.yml sets no PROMETHEUS_PORT").toBeDefined();
    expect(new Set(targets)).toEqual(new Set(["localhost:9090", `strada-brain:${exporterPort}`]));
  });

  it("uses no Go template in external labels (Prometheus does not expand them)", () => {
    expect(active(prometheus)).not.toMatch(/\{\{/);
  });
});

describe("Grafana provisioning in docker-compose.yml", () => {
  const mounts = [...compose.matchAll(/source:\s*(\S+)\s*\n\s*target:\s*(\S+)/g)].map((m) => ({ source: m[1]!, target: m[2]! }));

  it("mounts no dashboard JSON directly into provisioning/dashboards/", () => {
    const direct = mounts.filter((m) => m.target.startsWith("/etc/grafana/provisioning/dashboards/") && m.target.endsWith(".json"));
    expect(direct).toEqual([]);
  });

  it("mounts a dashboard provider whose path holds the dashboard JSON", () => {
    const provider = mounts.find((m) => m.target.startsWith("/etc/grafana/provisioning/dashboards/") && /\.ya?ml$/.test(m.target));
    expect(provider, "no dashboard provider is mounted").toBeDefined();
    const providerPath = /^\s*path:\s*(\S+)\s*$/m.exec(read(provider!.source))?.[1];
    expect(providerPath).toBeDefined();
    const dashboard = mounts.find((m) => m.source.endsWith("grafana-dashboard.json"));
    expect(dashboard, "the dashboard JSON is not mounted").toBeDefined();
    expect(path.posix.dirname(dashboard!.target)).toBe(providerPath);
  });
});
