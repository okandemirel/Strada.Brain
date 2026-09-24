import { describe, expect, it } from "vitest";
import { isAllowedHostHeader, resolveAllowedHosts } from "./host-validation.js";

describe("isAllowedHostHeader (CHN-2 / COR-11)", () => {
  it.each([
    ["localhost:3000"],
    ["LOCALHOST:3100"],
    ["localhost"],
    ["127.0.0.1:3000"],
    ["127.0.0.1"],
    ["[::1]:3000"],
    ["[::1]"],
    // An IP literal can never be a rebound DNS name: LAN access to a server
    // bound with BIND_HOST=0.0.0.0, and orchestrator probes by pod IP, stay served.
    ["192.168.1.10:3000"],
    ["[fe80::1]:3100"],
    // Port mappings, the Vite dev proxy and `$host` forwarding change the port.
    ["localhost:5173"],
  ])("serves %s without any configuration", (host) => {
    expect(isAllowedHostHeader(host)).toBe(true);
  });

  it("serves a request without a Host header (a non-browser client)", () => {
    expect(isAllowedHostHeader(undefined)).toBe(true);
  });

  it.each([
    ["evil.test:3000"],
    ["evil.test"],
    ["127.0.0.1.evil.test"],
    ["localhost.evil.test:3000"],
    ["strada-brain:9090"],
    [""],
    ["localhost:3000 evil"],
    ["user@localhost:3000"],
    ["localhost/x"],
    ["[not-an-ip]:3000"],
  ])("refuses %j when nothing names it", (host) => {
    expect(isAllowedHostHeader(host)).toBe(false);
  });

  it("serves an operator-configured bare hostname on any port", () => {
    const opts = { allowedHosts: ["strada.example", "strada-brain"] };
    expect(isAllowedHostHeader("strada.example", opts)).toBe(true);
    expect(isAllowedHostHeader("STRADA.example:8443", opts)).toBe(true);
    expect(isAllowedHostHeader("strada-brain:9090", opts)).toBe(true);
    expect(isAllowedHostHeader("other.example", opts)).toBe(false);
  });

  it("serves a configured host:port on exactly that port", () => {
    const opts = { allowedHosts: ["strada.example:8443"] };
    expect(isAllowedHostHeader("strada.example:8443", opts)).toBe(true);
    expect(isAllowedHostHeader("strada.example:9443", opts)).toBe(false);
    expect(isAllowedHostHeader("strada.example", opts)).toBe(false);
  });

  it("serves the hostname of a configured trusted origin (WEB_TRUSTED_ORIGINS)", () => {
    const opts = { trustedOrigins: ["https://portal.example"] };
    expect(isAllowedHostHeader("portal.example", opts)).toBe(true);
    expect(isAllowedHostHeader("portal.example:443", opts)).toBe(true);
    expect(isAllowedHostHeader("evil.example", opts)).toBe(false);
  });

  it("accepts a complete origin in allowedHosts as its hostname", () => {
    // WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS may hold either form.
    expect(isAllowedHostHeader("dash.example:3100", { allowedHosts: ["https://dash.example"] })).toBe(true);
  });
});

describe("resolveAllowedHosts", () => {
  it("is empty when HTTP_ALLOWED_HOSTS is unset", () => {
    expect(resolveAllowedHosts({})).toEqual([]);
  });

  it("splits, trims and drops malformed entries instead of widening", () => {
    expect(
      resolveAllowedHosts({ HTTP_ALLOWED_HOSTS: " strada-brain, ,portal.example:8443,bad host,https://x.example " }),
    ).toEqual(["strada-brain", "portal.example:8443", "https://x.example"]);
  });

  it("serves a BIND_HOST hostname — the operator named this machine by it", () => {
    const hosts = resolveAllowedHosts({ BIND_HOST: "workstation.lan" });
    expect(hosts).toEqual(["workstation.lan"]);
    expect(isAllowedHostHeader("workstation.lan:3000", { allowedHosts: hosts })).toBe(true);
    // An IP or wildcard bind address adds nothing an IP-literal Host did not already get.
    expect(resolveAllowedHosts({ BIND_HOST: "::" })).toEqual([]);
  });
});
