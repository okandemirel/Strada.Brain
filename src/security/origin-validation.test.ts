import { describe, it, expect } from "vitest";
import { isAllowedOrigin } from "./origin-validation.js";

describe("isAllowedOrigin", () => {
  describe("absent origin (non-browser clients)", () => {
    it("should accept undefined origin", () => {
      expect(isAllowedOrigin(undefined)).toBe(true);
    });

    it("should accept undefined origin with custom allowed list", () => {
      expect(isAllowedOrigin(undefined, ["example.com"])).toBe(true);
    });
  });

  describe("suspicious browser origins", () => {
    it("should reject empty string origin", () => {
      expect(isAllowedOrigin("")).toBe(false);
    });

    it("should reject 'null' string origin", () => {
      expect(isAllowedOrigin("null")).toBe(false);
    });
  });

  describe("localhost variants (default allowed)", () => {
    it("should accept http://localhost", () => {
      expect(isAllowedOrigin("http://localhost")).toBe(true);
    });

    it("should accept https://localhost", () => {
      expect(isAllowedOrigin("https://localhost")).toBe(true);
    });

    it("should accept http://localhost with port", () => {
      expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    });

    it("should accept http://localhost with high port", () => {
      expect(isAllowedOrigin("http://localhost:49152")).toBe(true);
    });

    it("should accept http://127.0.0.1", () => {
      expect(isAllowedOrigin("http://127.0.0.1")).toBe(true);
    });

    it("should accept https://127.0.0.1", () => {
      expect(isAllowedOrigin("https://127.0.0.1")).toBe(true);
    });

    it("should accept http://127.0.0.1 with port", () => {
      expect(isAllowedOrigin("http://127.0.0.1:8080")).toBe(true);
    });
  });

  describe("blocked external origins (default mode)", () => {
    it("should reject external HTTPS origin", () => {
      expect(isAllowedOrigin("https://example.com")).toBe(false);
    });

    it("should reject external HTTP origin", () => {
      expect(isAllowedOrigin("http://evil.com")).toBe(false);
    });

    it("should reject external origin with port", () => {
      expect(isAllowedOrigin("https://attacker.io:443")).toBe(false);
    });

    it("should reject external origin with path", () => {
      expect(isAllowedOrigin("https://example.com/callback")).toBe(false);
    });

    it("should reject IP address that is not 127.0.0.1", () => {
      expect(isAllowedOrigin("http://192.168.1.1")).toBe(false);
    });

    it("should reject 0.0.0.0", () => {
      expect(isAllowedOrigin("http://0.0.0.0")).toBe(false);
    });

    it("should reject private network IPs", () => {
      expect(isAllowedOrigin("http://10.0.0.1")).toBe(false);
    });

    it("should reject 172.16.x.x range", () => {
      expect(isAllowedOrigin("http://172.16.0.1")).toBe(false);
    });
  });

  describe("malformed origins", () => {
    it("should reject non-URL strings", () => {
      expect(isAllowedOrigin("not-a-url")).toBe(false);
    });

    it("should reject origin with only protocol", () => {
      expect(isAllowedOrigin("http://")).toBe(false);
    });

    it("should reject origin with spaces", () => {
      expect(isAllowedOrigin("http://local host")).toBe(false);
    });

    it("should reject random garbage", () => {
      expect(isAllowedOrigin("!!!@@@###")).toBe(false);
    });
  });

  describe("custom allowedHostnames", () => {
    it("should accept hostname in allowed list", () => {
      expect(isAllowedOrigin("https://myapp.local", ["myapp.local"])).toBe(true);
    });

    it("should accept host:port in allowed list", () => {
      expect(
        isAllowedOrigin("https://myapp.local:3100", ["myapp.local:3100"]),
      ).toBe(true);
    });

    it("should accept bare hostname when origin has a port", () => {
      // URL("https://myapp.local:3100").hostname === "myapp.local"
      expect(
        isAllowedOrigin("https://myapp.local:3100", ["myapp.local"]),
      ).toBe(true);
    });

    it("should reject origin not in custom allowed list", () => {
      expect(
        isAllowedOrigin("https://evil.com", ["myapp.local"]),
      ).toBe(false);
    });

    it("should reject localhost when custom list does not include it", () => {
      // When allowedHostnames is provided, ONLY those hostnames are allowed
      expect(
        isAllowedOrigin("http://localhost", ["myapp.local"]),
      ).toBe(false);
    });

    it("should accept localhost when explicitly in custom list", () => {
      expect(
        isAllowedOrigin("http://localhost:3000", ["localhost"]),
      ).toBe(true);
    });

    it("should handle multiple allowed hostnames", () => {
      const allowed = ["app1.local", "app2.local", "staging.example.com"];
      expect(isAllowedOrigin("https://app1.local", allowed)).toBe(true);
      expect(isAllowedOrigin("https://app2.local", allowed)).toBe(true);
      expect(isAllowedOrigin("https://staging.example.com", allowed)).toBe(true);
      expect(isAllowedOrigin("https://prod.example.com", allowed)).toBe(false);
    });

    it("should handle empty allowed list (falls back to default localhost check)", () => {
      expect(isAllowedOrigin("http://localhost", [])).toBe(true);
      expect(isAllowedOrigin("https://example.com", [])).toBe(false);
    });
  });

  describe("edge cases with ports and protocols", () => {
    it("should accept localhost on standard HTTPS port", () => {
      expect(isAllowedOrigin("https://localhost:443")).toBe(true);
    });

    it("should accept 127.0.0.1 on standard HTTP port", () => {
      expect(isAllowedOrigin("http://127.0.0.1:80")).toBe(true);
    });

    it("should handle ws:// protocol for localhost", () => {
      expect(isAllowedOrigin("ws://localhost:8080")).toBe(true);
    });

    it("should handle wss:// protocol for localhost", () => {
      expect(isAllowedOrigin("wss://127.0.0.1:443")).toBe(true);
    });

    it("should reject ws:// protocol for external host", () => {
      expect(isAllowedOrigin("ws://evil.com:8080")).toBe(false);
    });
  });
});
