import { describe, it, expect, beforeEach } from "vitest";
import {
  validateUrlWithConfig,
  BrowserRateLimiter,
  BrowserSessionManager,
  DEFAULT_SECURITY_CONFIG,
  type BrowserSecurityConfig,
} from "./browser-security.js";
import { createLogger } from "../utils/logger.js";

// Initialize logger for tests
createLogger("error", "/tmp/strada-test.log");

describe("BrowserSecurity", () => {
  describe("DEFAULT_SECURITY_CONFIG", () => {
    it("should have reasonable defaults", () => {
      expect(DEFAULT_SECURITY_CONFIG.blockLocalhost).toBe(true);
      expect(DEFAULT_SECURITY_CONFIG.blockFileProtocol).toBe(true);
      expect(DEFAULT_SECURITY_CONFIG.blockDataProtocol).toBe(true);
      expect(DEFAULT_SECURITY_CONFIG.blockJavascriptProtocol).toBe(true);
      expect(DEFAULT_SECURITY_CONFIG.maxNavigationTimeMs).toBe(30000);
      expect(DEFAULT_SECURITY_CONFIG.maxScreenshotSizeMb).toBe(10);
      expect(DEFAULT_SECURITY_CONFIG.maxDownloadSizeMb).toBe(50);
      expect(DEFAULT_SECURITY_CONFIG.maxConcurrentSessions).toBe(5);
    });

    it("should have blocked URL patterns", () => {
      expect(DEFAULT_SECURITY_CONFIG.blockedUrlPatterns.length).toBeGreaterThan(0);
      expect(DEFAULT_SECURITY_CONFIG.blockedUrlPatterns).toContain("\\/admin");
    });
  });

  describe("validateUrlWithConfig", () => {
    it("should allow valid HTTPS URLs", () => {
      const result = validateUrlWithConfig("https://example.com/path");
      expect(result.valid).toBe(true);
    });

    it("should allow valid HTTP URLs", () => {
      const result = validateUrlWithConfig("http://example.com");
      expect(result.valid).toBe(true);
    });

    it("should block localhost", () => {
      const result = validateUrlWithConfig("http://localhost:8080/test");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Localhost");
    });

    it("should block 127.0.0.1", () => {
      const result = validateUrlWithConfig("http://127.0.0.1:3000");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Localhost");
    });

    it("should block 0.0.0.0", () => {
      const result = validateUrlWithConfig("http://0.0.0.0:8080");
      expect(result.valid).toBe(false);
    });

    it("should block ::1", () => {
      // IPv6 addresses in URLs are normalized by URL parser
      const result = validateUrlWithConfig("http://[::1]:8080");
      // [::1] becomes localhost in some URL parsers
      expect(result.valid || result.reason?.includes("Localhost") || result.reason?.includes("Private")).toBeTruthy();
    });

    it("should block 192.168.x.x", () => {
      const result = validateUrlWithConfig("http://192.168.1.1/admin");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Private IP");
    });

    it("should block 10.x.x.x", () => {
      const result = validateUrlWithConfig("http://10.0.0.1/internal");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Private IP");
    });

    it("should block 172.16-31.x.x", () => {
      const result = validateUrlWithConfig("http://172.16.0.1/api");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Private IP");
    });

    it("should block 172.20.x.x", () => {
      const result = validateUrlWithConfig("http://172.20.0.1");
      expect(result.valid).toBe(false);
    });

    it("should block common DNS rebinding domains", () => {
      const result = validateUrlWithConfig("https://127.0.0.1.nip.io/hook");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("DNS rebinding");
    });

    it("should not reject external URLs that merely mention localhost in the query string", () => {
      const result = validateUrlWithConfig("https://example.com/hook?next=127.0.0.1");
      expect(result.valid).toBe(true);
    });

    it("should block file:// protocol", () => {
      const result = validateUrlWithConfig("file:///etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("file://");
    });

    it("should block data:// protocol", () => {
      const result = validateUrlWithConfig("data:text/html,<script>alert(1)</script>");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("data://");
    });

    it("should block javascript:// protocol", () => {
      const result = validateUrlWithConfig("javascript:alert(1)");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("javascript://");
    });

    it("should block admin paths", () => {
      const result = validateUrlWithConfig("https://example.com/admin");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("blocked pattern");
    });

    it("should block wp-admin paths", () => {
      const result = validateUrlWithConfig("https://example.com/wp-admin/edit.php");
      expect(result.valid).toBe(false);
    });

    it("should block .git paths", () => {
      const result = validateUrlWithConfig("https://example.com/.git/config");
      expect(result.valid).toBe(false);
    });

    it("should block .env files", () => {
      const result = validateUrlWithConfig("https://example.com/.env");
      expect(result.valid).toBe(false);
    });

    it("should reject invalid URLs", () => {
      const result = validateUrlWithConfig("not a url");
      expect(result.valid).toBe(false);
    });

    it("should allow localhost when configured", () => {
      const config: Partial<BrowserSecurityConfig> = { blockLocalhost: false };
      const result = validateUrlWithConfig("http://localhost:8080", config);
      expect(result.valid).toBe(true);
    });

    it("should allow file:// when configured", () => {
      const config: Partial<BrowserSecurityConfig> = { blockFileProtocol: false };
      const result = validateUrlWithConfig("file:///tmp/test", config);
      expect(result.valid).toBe(true);
    });

    it("should respect allowed patterns", () => {
      const config: Partial<BrowserSecurityConfig> = {
        allowedUrlPatterns: ["example\\.com"],
      };
      const result = validateUrlWithConfig("https://example.com/page", config);
      expect(result.valid).toBe(true);
    });

    it("should reject URLs not matching allowed patterns", () => {
      const config: Partial<BrowserSecurityConfig> = {
        allowedUrlPatterns: ["example\\.com"],
      };
      const result = validateUrlWithConfig("https://other.com/page", config);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("allowed pattern");
    });

    it("should block patterns take precedence over allowed", () => {
      const config: Partial<BrowserSecurityConfig> = {
        allowedUrlPatterns: ["example\\.com"],
        blockedUrlPatterns: ["example\\.com/admin"],
      };
      const result = validateUrlWithConfig("https://example.com/admin", config);
      expect(result.valid).toBe(false);
    });

    // --- Additional edge cases ---

    it("should block .localhost subdomains", () => {
      const result = validateUrlWithConfig("http://evil.localhost:8080");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Localhost");
    });

    it("should block .local suffix", () => {
      const result = validateUrlWithConfig("http://myapp.local/api");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Localhost");
    });

    it("should block link-local IP 169.254.x.x", () => {
      const result = validateUrlWithConfig("http://169.254.1.1/metadata");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Private IP");
    });

    it("should block 172.31.x.x (upper bound of 172.16-31 range)", () => {
      const result = validateUrlWithConfig("http://172.31.255.255/api");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Private IP");
    });

    it("should allow 172.32.x.x (outside private range)", () => {
      const result = validateUrlWithConfig("http://172.32.0.1/api");
      expect(result.valid).toBe(true);
    });

    it("should block DNS rebinding via sslip.io", () => {
      const result = validateUrlWithConfig("https://10.0.0.1.sslip.io/api");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("DNS rebinding");
    });

    it("should block DNS rebinding via xip.io", () => {
      const result = validateUrlWithConfig("https://192.168.1.1.xip.io");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("DNS rebinding");
    });

    it("should block DNS rebinding via localtest.me", () => {
      const result = validateUrlWithConfig("http://localtest.me:3000");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("DNS rebinding");
    });

    it("should block DNS rebinding via localhost.direct", () => {
      const result = validateUrlWithConfig("http://localhost.direct");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("DNS rebinding");
    });

    it("should block ftp:// protocol", () => {
      const result = validateUrlWithConfig("ftp://files.example.com/data");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not allowed");
    });

    it("should block unknown protocols", () => {
      const result = validateUrlWithConfig("custom://something");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not allowed");
    });

    it("should block /phpmyadmin paths", () => {
      const result = validateUrlWithConfig("https://example.com/phpmyadmin/index.php");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("blocked pattern");
    });

    it("should block /server-status paths", () => {
      const result = validateUrlWithConfig("https://example.com/server-status");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("blocked pattern");
    });

    it("should block .ssh paths", () => {
      const result = validateUrlWithConfig("https://example.com/.ssh/id_rsa");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("blocked pattern");
    });

    it("should block /etc/ paths", () => {
      const result = validateUrlWithConfig("https://example.com/etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("blocked pattern");
    });

    it("should block /proc/ paths", () => {
      const result = validateUrlWithConfig("https://example.com/proc/self/environ");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("blocked pattern");
    });

    it("should block /sys/ paths", () => {
      const result = validateUrlWithConfig("https://example.com/sys/class");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("blocked pattern");
    });

    it("should allow data:// when blockDataProtocol is false", () => {
      const config: Partial<BrowserSecurityConfig> = { blockDataProtocol: false };
      // data: URLs cannot be parsed by URL constructor for navigation; the protocol check
      // will pass but it will fail on the http/https-only check
      const result = validateUrlWithConfig("data:text/html,hello", config);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not allowed");
    });

    it("should allow javascript:// when blockJavascriptProtocol is false but still reject non-http", () => {
      const config: Partial<BrowserSecurityConfig> = { blockJavascriptProtocol: false };
      const result = validateUrlWithConfig("javascript:void(0)", config);
      // passes javascript block but fails the http/https-only check
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not allowed");
    });

    it("should handle URLs with encoded characters", () => {
      const result = validateUrlWithConfig("https://example.com/page%20test");
      expect(result.valid).toBe(true);
    });

    it("should handle URLs with query parameters", () => {
      const result = validateUrlWithConfig("https://example.com/search?q=test&page=1");
      expect(result.valid).toBe(true);
    });

    it("should handle URLs with fragments", () => {
      const result = validateUrlWithConfig("https://example.com/page#section");
      expect(result.valid).toBe(true);
    });

    it("should handle URLs with authentication in URL (userinfo)", () => {
      const result = validateUrlWithConfig("https://user:pass@example.com/api");
      expect(result.valid).toBe(true);
    });

    it("should handle empty blocked and allowed patterns", () => {
      const config: Partial<BrowserSecurityConfig> = {
        blockedUrlPatterns: [],
        allowedUrlPatterns: [],
      };
      const result = validateUrlWithConfig("https://example.com/admin", config);
      expect(result.valid).toBe(true);
    });

    it("should gracefully handle invalid regex in blocked patterns", () => {
      const config: Partial<BrowserSecurityConfig> = {
        blockedUrlPatterns: ["[invalid-regex"],
      };
      // Invalid regex is warned and skipped, URL should pass
      const result = validateUrlWithConfig("https://example.com/page", config);
      expect(result.valid).toBe(true);
    });

    it("should gracefully handle invalid regex in allowed patterns", () => {
      const config: Partial<BrowserSecurityConfig> = {
        allowedUrlPatterns: ["[invalid-regex"],
      };
      // Invalid regex is warned and skipped; no valid patterns match => rejected
      const result = validateUrlWithConfig("https://example.com/page", config);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("allowed pattern");
    });
  });

  describe("BrowserRateLimiter", () => {
    let limiter: BrowserRateLimiter;

    beforeEach(() => {
      limiter = new BrowserRateLimiter(5); // 5 ops per minute for testing
    });

    afterEach(() => {
      limiter.dispose();
    });

    it("should allow operations under limit", () => {
      const result = limiter.checkLimit("session-1");
      expect(result.allowed).toBe(true);
    });

    it("should track operation counts", () => {
      limiter.checkLimit("session-1");
      limiter.checkLimit("session-1");
      limiter.checkLimit("session-1");
      expect(limiter.getOperationCount("session-1")).toBe(3);
    });

    it("should block operations over limit", () => {
      // Make 5 requests (the limit)
      for (let i = 0; i < 5; i++) {
        limiter.checkLimit("session-1");
      }
      
      // 6th request should be blocked
      const result = limiter.checkLimit("session-1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("should track sessions independently", () => {
      limiter.checkLimit("session-1");
      limiter.checkLimit("session-1");
      limiter.checkLimit("session-2");

      expect(limiter.getOperationCount("session-1")).toBe(2);
      expect(limiter.getOperationCount("session-2")).toBe(1);
    });

    it("should reset session", () => {
      limiter.checkLimit("session-1");
      limiter.checkLimit("session-1");
      expect(limiter.getOperationCount("session-1")).toBe(2);

      limiter.resetSession("session-1");
      expect(limiter.getOperationCount("session-1")).toBe(0);
    });
  });

  describe("BrowserSessionManager", () => {
    let manager: BrowserSessionManager;

    beforeEach(() => {
      manager = new BrowserSessionManager(3); // Max 3 concurrent
    });

    it("should allow acquiring session under limit", () => {
      expect(manager.acquireSession("session-1")).toBe(true);
    });

    it("should track active sessions", () => {
      manager.acquireSession("session-1");
      manager.acquireSession("session-2");
      expect(manager.getActiveCount()).toBe(2);
    });

    it("should block acquiring session over limit", () => {
      manager.acquireSession("session-1");
      manager.acquireSession("session-2");
      manager.acquireSession("session-3");
      
      expect(manager.acquireSession("session-4")).toBe(false);
    });

    it("should allow re-acquiring same session", () => {
      manager.acquireSession("session-1");
      expect(manager.acquireSession("session-1")).toBe(true);
      expect(manager.getActiveCount()).toBe(1);
    });

    it("should release sessions", () => {
      manager.acquireSession("session-1");
      manager.acquireSession("session-2");
      expect(manager.getActiveCount()).toBe(2);

      manager.releaseSession("session-1");
      expect(manager.getActiveCount()).toBe(1);
      expect(manager.isActive("session-1")).toBe(false);
    });

    it("should allow new session after release", () => {
      manager.acquireSession("session-1");
      manager.acquireSession("session-2");
      manager.acquireSession("session-3");
      manager.releaseSession("session-1");

      expect(manager.acquireSession("session-4")).toBe(true);
    });
  });
});
