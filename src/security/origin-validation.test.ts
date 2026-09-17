import { describe, it, expect } from "vitest";
import { isAllowedOrigin, effectiveOriginPort, normalizeOrigin } from "./origin-validation.js";

// The protected server in these tests listens on 3000.
const SELF = { selfPort: 3000 } as const;

describe("isAllowedOrigin", () => {
  describe("absent origin (non-browser clients)", () => {
    it("should accept undefined origin", () => {
      expect(isAllowedOrigin(undefined, SELF)).toBe(true);
    });

    it("should accept undefined origin with custom allowed list", () => {
      expect(isAllowedOrigin(undefined, { selfPort: 3000, allowedHosts: ["example.com"] })).toBe(true);
    });
  });

  describe("suspicious browser origins", () => {
    it("should reject empty string origin", () => {
      expect(isAllowedOrigin("", SELF)).toBe(false);
    });

    it("should reject 'null' string origin", () => {
      expect(isAllowedOrigin("null", SELF)).toBe(false);
    });
  });

  describe("the server's own loopback origin", () => {
    it("should accept every loopback spelling on its own port", () => {
      expect(isAllowedOrigin("http://localhost:3000", SELF)).toBe(true);
      expect(isAllowedOrigin("http://127.0.0.1:3000", SELF)).toBe(true);
      expect(isAllowedOrigin("http://[::1]:3000", SELF)).toBe(true);
      expect(isAllowedOrigin("https://localhost:3000", SELF)).toBe(true);
    });

    it("should accept a port-less origin when the scheme's default port IS the server's", () => {
      expect(isAllowedOrigin("http://localhost", { selfPort: 80 })).toBe(true);
      expect(isAllowedOrigin("https://localhost", { selfPort: 443 })).toBe(true);
      expect(isAllowedOrigin("ws://127.0.0.1", { selfPort: 80 })).toBe(true);
      expect(isAllowedOrigin("wss://127.0.0.1", { selfPort: 443 })).toBe(true);
    });

    it("should accept ws:// and wss:// on the server's own port", () => {
      expect(isAllowedOrigin("ws://localhost:3000", SELF)).toBe(true);
      expect(isAllowedOrigin("wss://127.0.0.1:3000", SELF)).toBe(true);
    });

    it("effectiveOriginPort fills in the scheme's default port", () => {
      expect(effectiveOriginPort(new URL("http://localhost"))).toBe("80");
      expect(effectiveOriginPort(new URL("https://localhost"))).toBe("443");
      expect(effectiveOriginPort(new URL("ws://localhost"))).toBe("80");
      expect(effectiveOriginPort(new URL("wss://localhost"))).toBe("443");
      expect(effectiveOriginPort(new URL("http://localhost:8080"))).toBe("8080");
    });
  });

  // Audit 13F6 / plan 4.8 — this is the defect: the check compared the HOSTNAME
  // only, so any other process's page on the loopback interface counted as the
  // protected server's own origin.
  describe("another loopback PORT is another origin (13F6 / 4.8)", () => {
    it("should reject a loopback origin on a different port", () => {
      expect(isAllowedOrigin("http://localhost:9999", SELF)).toBe(false);
      expect(isAllowedOrigin("http://127.0.0.1:5173", SELF)).toBe(false);
      expect(isAllowedOrigin("http://[::1]:8080", SELF)).toBe(false);
    });

    it("should reject a port-less loopback origin when the default port is not the server's", () => {
      expect(isAllowedOrigin("http://localhost", SELF)).toBe(false);
      expect(isAllowedOrigin("https://127.0.0.1", SELF)).toBe(false);
    });

    it("should reject a loopback WebSocket origin on a different port", () => {
      expect(isAllowedOrigin("ws://localhost:8080", SELF)).toBe(false);
    });

    it("should reject a scheme's default port that merely looks adjacent", () => {
      expect(isAllowedOrigin("http://localhost:443", SELF)).toBe(false);
      expect(isAllowedOrigin("http://127.0.0.1:80", SELF)).toBe(false);
    });
  });

  describe("extraPorts (the portal's port, for the dashboard's gate)", () => {
    it("should accept a loopback origin on an explicitly trusted extra port", () => {
      expect(isAllowedOrigin("http://localhost:3000", { selfPort: 3100, extraPorts: [3000] })).toBe(true);
      expect(isAllowedOrigin("http://127.0.0.1:3100", { selfPort: 3100, extraPorts: [3000] })).toBe(true);
    });

    it("should still reject a loopback origin on a port nobody named", () => {
      expect(isAllowedOrigin("http://localhost:9999", { selfPort: 3100, extraPorts: [3000] })).toBe(false);
    });

    it("should not treat an empty extraPorts list as a wildcard", () => {
      expect(isAllowedOrigin("http://localhost:9999", { selfPort: 3100, extraPorts: [] })).toBe(false);
    });
  });

  describe("blocked external origins", () => {
    it("should reject external HTTPS origin", () => {
      expect(isAllowedOrigin("https://example.com", SELF)).toBe(false);
    });

    it("should reject external HTTP origin", () => {
      expect(isAllowedOrigin("http://evil.com", SELF)).toBe(false);
    });

    it("should reject an external origin even on the server's own port", () => {
      expect(isAllowedOrigin("http://evil.com:3000", SELF)).toBe(false);
    });

    it("should reject external origin with path", () => {
      expect(isAllowedOrigin("https://example.com/callback", SELF)).toBe(false);
    });

    it("should reject IP address that is not loopback", () => {
      expect(isAllowedOrigin("http://192.168.1.1:3000", SELF)).toBe(false);
    });

    it("should reject 0.0.0.0", () => {
      expect(isAllowedOrigin("http://0.0.0.0:3000", SELF)).toBe(false);
    });

    it("should reject private network IPs", () => {
      expect(isAllowedOrigin("http://10.0.0.1:3000", SELF)).toBe(false);
      expect(isAllowedOrigin("http://172.16.0.1:3000", SELF)).toBe(false);
    });
  });

  describe("malformed origins", () => {
    it("should reject non-URL strings", () => {
      expect(isAllowedOrigin("not-a-url", SELF)).toBe(false);
    });

    it("should reject origin with only protocol", () => {
      expect(isAllowedOrigin("http://", SELF)).toBe(false);
    });

    it("should reject origin with spaces", () => {
      expect(isAllowedOrigin("http://local host", SELF)).toBe(false);
    });

    it("should reject random garbage", () => {
      expect(isAllowedOrigin("!!!@@@###", SELF)).toBe(false);
    });
  });

  describe("custom allowedHosts (an explicit operator decision)", () => {
    it("should accept hostname in allowed list", () => {
      expect(isAllowedOrigin("https://myapp.local", { selfPort: 3000, allowedHosts: ["myapp.local"] })).toBe(true);
    });

    it("should accept host:port in allowed list", () => {
      expect(
        isAllowedOrigin("https://myapp.local:3100", { selfPort: 3000, allowedHosts: ["myapp.local:3100"] }),
      ).toBe(true);
    });

    it("a bare hostname in the list trusts that host on ANY port (the operator said so)", () => {
      expect(
        isAllowedOrigin("https://myapp.local:3100", { selfPort: 3000, allowedHosts: ["myapp.local"] }),
      ).toBe(true);
    });

    it("a host:port entry does NOT trust the same host on another port", () => {
      expect(
        isAllowedOrigin("https://myapp.local:9999", { selfPort: 3000, allowedHosts: ["myapp.local:3100"] }),
      ).toBe(false);
    });

    it("should reject origin not in custom allowed list", () => {
      expect(isAllowedOrigin("https://evil.com", { selfPort: 3000, allowedHosts: ["myapp.local"] })).toBe(false);
    });

    it("a custom list does not open other loopback ports", () => {
      expect(isAllowedOrigin("http://localhost:9999", { selfPort: 3000, allowedHosts: ["myapp.local"] })).toBe(false);
    });

    it("the server's own origin stays trusted alongside a custom list", () => {
      expect(isAllowedOrigin("http://localhost:3000", { selfPort: 3000, allowedHosts: ["myapp.local"] })).toBe(true);
    });

    it("should handle multiple allowed hostnames", () => {
      const allowedHosts = ["app1.local", "app2.local", "staging.example.com"];
      expect(isAllowedOrigin("https://app1.local", { selfPort: 3000, allowedHosts })).toBe(true);
      expect(isAllowedOrigin("https://app2.local", { selfPort: 3000, allowedHosts })).toBe(true);
      expect(isAllowedOrigin("https://staging.example.com", { selfPort: 3000, allowedHosts })).toBe(true);
      expect(isAllowedOrigin("https://prod.example.com", { selfPort: 3000, allowedHosts })).toBe(false);
    });

    it("should handle empty allowed list (falls back to the self-origin rule)", () => {
      expect(isAllowedOrigin("http://localhost:3000", { selfPort: 3000, allowedHosts: [] })).toBe(true);
      expect(isAllowedOrigin("http://localhost:9999", { selfPort: 3000, allowedHosts: [] })).toBe(false);
      expect(isAllowedOrigin("https://example.com", { selfPort: 3000, allowedHosts: [] })).toBe(false);
    });
  });

  // ── Round 10 #19: trustedOrigins — the deployment's own COMPLETE origins ──
  describe("trustedOrigins (a proxy in front of the server)", () => {
    const DEV = { selfPort: 3000, trustedOrigins: ["http://localhost:5173"] } as const;

    it("accepts the configured dev-proxy origin and the bound port", () => {
      expect(isAllowedOrigin("http://localhost:5173", DEV)).toBe(true);
      expect(isAllowedOrigin("http://localhost:3000", DEV)).toBe(true);
    });

    it("treats an implicit default port as the port the browser sends", () => {
      const options = { selfPort: 3000, trustedOrigins: ["https://portal.example"] } as const;
      expect(isAllowedOrigin("https://portal.example", options)).toBe(true);
      expect(isAllowedOrigin("https://portal.example:443", options)).toBe(true);
      expect(isAllowedOrigin("https://portal.example:8443", options)).toBe(false);
    });

    it("matches the COMPLETE origin: scheme, host and port all count", () => {
      expect(isAllowedOrigin("https://localhost:5173", DEV)).toBe(false);
      expect(isAllowedOrigin("http://localhost:5174", DEV)).toBe(false);
      expect(isAllowedOrigin("http://127.0.0.1:5173", DEV)).toBe(false);
      expect(isAllowedOrigin("http://evil.example:5173", DEV)).toBe(false);
    });

    it("does not turn an unrelated loopback port into a trusted one", () => {
      expect(isAllowedOrigin("http://localhost:9999", DEV)).toBe(false);
      expect(isAllowedOrigin("http://localhost", DEV)).toBe(false);
    });

    it("ignores a malformed entry instead of widening the rule", () => {
      const options = { selfPort: 3000, trustedOrigins: ["localhost:5173", "", "not a url"] } as const;
      expect(isAllowedOrigin("http://localhost:5173", options)).toBe(false);
      expect(isAllowedOrigin("http://localhost:3000", options)).toBe(true);
    });

    it("normalizeOrigin states the one comparable form, or nothing", () => {
      expect(normalizeOrigin("http://LocalHost:5173")).toBe("http://localhost:5173");
      expect(normalizeOrigin("https://portal.example/monitor?x=1")).toBe("https://portal.example:443");
      expect(normalizeOrigin("ws://127.0.0.1")).toBe("ws://127.0.0.1:80");
      expect(normalizeOrigin("localhost:5173")).toBeUndefined();
      expect(normalizeOrigin("not a url")).toBeUndefined();
      expect(normalizeOrigin("file:///etc/passwd")).toBeUndefined();
    });
  });
});
