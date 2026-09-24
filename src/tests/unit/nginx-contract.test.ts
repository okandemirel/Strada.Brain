/**
 * nginx /health contract (14F2 / D71, second half).
 *
 * `location /health` answered `return 200 "healthy"` from nginx itself. A load
 * balancer, an orchestrator probe or an operator hitting that path therefore
 * got "healthy" while the backend behind it was dead, restarting or wedged —
 * the reverse proxy reported its own liveness under the application's health
 * path. The nginx-level check has its own path (`/nginx-health`), and `/health`
 * must reach the backend.
 *
 * Asserted over the config text: nginx cannot run in this environment, and the
 * property in question is which upstream a location routes to.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const conf = readFileSync(path.join(repoRoot, "nginx", "nginx.conf"), "utf8");

/** Every `location <match> { … }` body, brace-balanced. */
function locations(source: string, match: string): string[] {
  const found: string[] = [];
  const opener = new RegExp(`location\\s+(?:=\\s+)?${match.replace(/\//g, "\\/")}\\s*\\{`, "g");
  let hit: RegExpExecArray | null;
  while ((hit = opener.exec(source)) !== null) {
    let depth = 1;
    let i = hit.index + hit[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    found.push(source.slice(start, i - 1));
  }
  return found;
}

describe("nginx.conf", () => {
  it("declares a /health location in every server block", () => {
    const serverBlocks = conf.split(/\n\s{4}server\s*\{/).slice(1);
    expect(serverBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of serverBlocks) {
      expect(locations(block, "/health").length, "server block without /health").toBeGreaterThan(0);
    }
  });

  it("routes /health to the application backend, never answering from nginx", () => {
    const healthBlocks = locations(conf, "/health");
    expect(healthBlocks.length).toBeGreaterThan(0);
    for (const body of healthBlocks) {
      expect(body).toMatch(/proxy_pass\s+http:\/\/strata_backend/);
      expect(body).not.toMatch(/return\s+200/);
    }
  });

  it("keeps the nginx-level liveness check on its own path", () => {
    const own = locations(conf, "/nginx-health");
    expect(own.length).toBe(1);
    expect(own[0]).toMatch(/return\s+200/);
  });
});

/** Active (uncommented) configuration only. */
const active = conf
  .split("\n")
  .map((line) => line.replace(/#.*$/, ""))
  .join("\n");

describe("nginx.conf hardening (OPS-19)", () => {
  it("sends `Connection: upgrade` only for WebSocket handshakes", () => {
    // Forced on every request it defeated the upstream keepalive pool.
    expect(active).not.toMatch(/proxy_set_header\s+Connection\s+"upgrade"/);
    expect(active).toMatch(/map\s+\$http_upgrade\s+\$connection_upgrade\s*\{[^}]*default\s+upgrade;[^}]*''\s+'';/);
    // The portal's chat WebSocket connects on `/` of the HTTPS server.
    const httpsRoot = locations(active.slice(active.indexOf("listen 443")), "/")[0];
    expect(httpsRoot).toMatch(/proxy_set_header\s+Connection\s+\$connection_upgrade/);
  });

  it("keeps /metrics off the public internet", () => {
    const metrics = locations(active, "/metrics");
    expect(metrics.length).toBe(1);
    expect(metrics[0]).toMatch(/deny\s+all;/);
  });

  it("sends HSTS from the HTTPS server", () => {
    expect(active).toMatch(/add_header\s+Strict-Transport-Security\s+"max-age=\d+/);
  });

  it("allows eval in no Content-Security-Policy", () => {
    expect(active).not.toMatch(/'unsafe-eval'/);
  });

  it("sets a request body limit instead of the 1 MB default", () => {
    expect(active).toMatch(/client_max_body_size\s+\d+[kmg];/i);
  });

  it("uses no add_header inside a location of the HTTPS server (it would drop the security headers there)", () => {
    const https = active.slice(active.indexOf("listen 443"));
    const offenders = [...https.matchAll(/location\s+[^{]+\{([^{}]*)\}/g)]
      .filter((m) => /\badd_header\b/.test(m[1]!))
      .map((m) => m[0].split("{")[0]!.trim());
    expect(offenders).toEqual([]);
  });
});
