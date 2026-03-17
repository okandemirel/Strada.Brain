import { describe, expect, it, vi } from "vitest";
import { Firewall } from "./firewall.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("Firewall", () => {
  it("allows requests under a rate_limit rule until the burst is exhausted", () => {
    const firewall = new Firewall();
    firewall.addRule({
      name: "limit ssh",
      action: "rate_limit",
      direction: "inbound",
      protocol: "tcp",
      sourceIps: [{ type: "single", value: "203.0.113.10" }],
      destinationIps: [{ type: "single", value: "127.0.0.1" }],
      ports: [22],
      priority: 100,
      enabled: true,
      log: false,
      rateLimit: {
        requestsPerSecond: 10,
        burstSize: 2,
      },
    });

    const first = firewall.checkConnection("203.0.113.10", "127.0.0.1", 22, "tcp");
    const second = firewall.checkConnection("203.0.113.10", "127.0.0.1", 22, "tcp");

    expect(first).toMatchObject({ allowed: true, action: "rate_limit" });
    expect(second).toMatchObject({ allowed: true, action: "rate_limit" });
  });

  it("returns rate_limited once a rate_limit rule exceeds its burst budget", () => {
    const firewall = new Firewall();
    firewall.addRule({
      name: "limit webhook",
      action: "rate_limit",
      direction: "inbound",
      protocol: "tcp",
      sourceIps: [{ type: "single", value: "203.0.113.11" }],
      destinationIps: [{ type: "single", value: "127.0.0.1" }],
      ports: [443],
      priority: 100,
      enabled: true,
      log: false,
      rateLimit: {
        requestsPerSecond: 1,
        burstSize: 1,
      },
    });

    const first = firewall.checkConnection("203.0.113.11", "127.0.0.1", 443, "tcp");
    const second = firewall.checkConnection("203.0.113.11", "127.0.0.1", 443, "tcp");

    expect(first).toMatchObject({ allowed: true, action: "rate_limit" });
    expect(second).toMatchObject({ allowed: false, action: "rate_limited" });
  });

  it("fails closed for misconfigured rate_limit rules without silently behaving like deny", () => {
    const firewall = new Firewall();
    firewall.addRule({
      name: "broken limit rule",
      action: "rate_limit",
      direction: "inbound",
      protocol: "tcp",
      sourceIps: [{ type: "single", value: "203.0.113.12" }],
      destinationIps: [{ type: "single", value: "127.0.0.1" }],
      ports: [8080],
      priority: 100,
      enabled: true,
      log: false,
    });

    const result = firewall.checkConnection("203.0.113.12", "127.0.0.1", 8080, "tcp");
    expect(result).toMatchObject({ allowed: false, action: "rate_limit_misconfigured" });
  });
});
