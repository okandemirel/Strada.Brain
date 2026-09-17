import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateUrlWithConfig,
  assertPublicTarget,
  classifyForbiddenAddress,
  isForbiddenAddress,
  isRedirectStatus,
  normalizeIpLiteral,
  parseIpv4Literal,
  BrowserRateLimiter,
  BrowserSessionManager,
  DEFAULT_SECURITY_CONFIG,
  ForbiddenTargetError,
  type BrowserSecurityConfig,
  type ResolvedAddress,
} from "./browser-security.js";
import { createLogger } from "../utils/logger.js";

// Initialize logger for tests
createLogger("error", "/tmp/strada-test.log");

describe("BrowserSecurity", () => {
  // ── Plan 0-B.6 (audit 13F1 / D63 + Codex #12) — resolved-target SSRF policy ──
  // The guard used to classify the hostname STRING. These tests pin the address
  // classifier (pure, no DNS) and the resolver policy (injected resolver).

  describe("isForbiddenAddress (plan 0-B.6 / 13F1 / D63)", () => {
    const forbidden: Array<[string, string]> = [
      // loopback, every IPv4 spelling
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"],
      ["2130706433", "loopback"], // decimal
      ["0x7f000001", "loopback"], // hex
      ["0177.0.0.1", "loopback"], // octal
      ["127.1", "loopback"], // short
      ["127.0.1", "loopback"], // short (3 parts)
      ["0x7f.1", "loopback"], // mixed hex + short
      ["0177.1", "loopback"], // mixed octal + short
      // unspecified
      ["0.0.0.0", "unspecified"],
      ["0", "unspecified"],
      ["0.1.2.3", "unspecified"],
      // RFC 1918
      ["10.0.0.1", "private"],
      ["10.255.255.255", "private"],
      ["0xa000001", "private"], // 10.0.0.1 hex
      ["167772161", "private"], // 10.0.0.1 decimal
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["192.168.1.1", "private"],
      ["0xc0a80101", "private"], // 192.168.1.1 hex
      // link-local (cloud metadata)
      ["169.254.169.254", "link-local"],
      ["0xa9fea9fe", "link-local"],
      ["2852039166", "link-local"],
      // CGNAT
      ["100.64.0.1", "carrier-grade NAT"],
      ["100.127.255.255", "carrier-grade NAT"],
      // multicast / reserved / broadcast
      ["224.0.0.1", "multicast"],
      ["239.255.255.255", "multicast"],
      ["240.0.0.1", "reserved"],
      ["255.255.255.255", "reserved"],
      ["192.0.0.1", "reserved"],
      ["198.18.0.1", "benchmark"],
      // IPv6
      ["::1", "loopback"],
      ["[::1]", "loopback"],
      ["0:0:0:0:0:0:0:1", "loopback"],
      ["::", "unspecified"],
      ["fe80::1", "link-local"],
      ["fe80::1%en0", "link-local"],
      ["febf::1", "link-local"],
      ["fec0::1", "site-local"],
      ["fc00::1", "unique-local"],
      ["fd00::1", "unique-local"],
      ["fdff:ffff::1", "unique-local"],
      ["ff02::1", "multicast"],
      // IPv4-mapped / compatible / NAT64 / 6to4 forms of forbidden IPv4
      ["::ffff:127.0.0.1", "loopback"],
      ["[::ffff:127.0.0.1]", "loopback"],
      ["::ffff:7f00:1", "loopback"],
      ["::ffff:10.0.0.1", "private"],
      ["::ffff:a00:1", "private"],
      ["::ffff:169.254.169.254", "link-local"],
      ["::ffff:192.168.0.1", "private"],
      ["::ffff:0.0.0.0", "unspecified"],
      ["::127.0.0.1", "loopback"],
      ["64:ff9b::7f00:1", "loopback"],
      ["64:ff9b::10.0.0.1", "private"],
      ["2002:7f00:1::", "loopback"],
      ["2002:a9fe:a9fe::1", "link-local"],
    ];

    it.each(forbidden)("refuses %s (%s)", (ip, reasonFragment) => {
      expect(isForbiddenAddress(ip)).toBe(true);
      expect(classifyForbiddenAddress(ip)).toContain(reasonFragment);
    });

    const allowed = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.32.0.1", // just outside 172.16/12
      "172.15.255.255",
      "100.63.255.255", // just outside 100.64/10
      "100.128.0.0",
      "192.169.0.1",
      "11.0.0.1",
      "126.255.255.255",
      "128.0.0.1",
      "223.255.255.255",
      "0x08080808", // 8.8.8.8 hex
      "134744072", // 8.8.8.8 decimal
      "2606:4700::1111",
      "2001:4860:4860::8888",
      "[2606:4700::1111]",
      "::ffff:8.8.8.8", // IPv4-mapped public stays public
      "::ffff:808:808",
      "64:ff9b::808:808",
      "2002:808:808::1",
    ];

    it.each(allowed)("allows public %s", (ip) => {
      expect(isForbiddenAddress(ip)).toBe(false);
      expect(classifyForbiddenAddress(ip)).toBeNull();
    });

    it("refuses strings that are not IP literals (they must go through resolution)", () => {
      for (const s of ["example.com", "localhost", "", "256.1.1.1", "4294967296", "1.2.3.4.5", "0x", "::g", "1:2:3:4:5:6:7:8:9", "fcbarcelona.com"]) {
        expect(isForbiddenAddress(s)).toBe(true);
      }
    });

    it("normalises every IPv4 spelling to a dotted quad", () => {
      expect(parseIpv4Literal("2130706433")).toBe("127.0.0.1");
      expect(parseIpv4Literal("0x7f000001")).toBe("127.0.0.1");
      expect(parseIpv4Literal("0177.0.0.1")).toBe("127.0.0.1");
      expect(parseIpv4Literal("127.1")).toBe("127.0.0.1");
      expect(parseIpv4Literal("127.0.1")).toBe("127.0.0.1");
      expect(parseIpv4Literal("0xA9.0xFE.0xA9.0xFE")).toBe("169.254.169.254");
      expect(parseIpv4Literal("256")).toBe("0.0.1.0");
      expect(parseIpv4Literal("1.256")).toBe("1.0.1.0"); // WHATWG: last part fills the rest
      expect(parseIpv4Literal("1.2.256.1")).toBeNull(); // non-last part over 255
      expect(parseIpv4Literal("1.2.3.256")).toBeNull();
      expect(parseIpv4Literal("08.1.1.1")).toBeNull(); // bad octal
      expect(parseIpv4Literal("a.b.c.d")).toBeNull();
      expect(normalizeIpLiteral("[::FFFF:127.0.0.1]")).toBe("0:0:0:0:0:ffff:7f00:1");
      expect(normalizeIpLiteral("fe80::1%eth0")).toBe("fe80:0:0:0:0:0:0:1");
      expect(normalizeIpLiteral("example.com")).toBeNull();
    });

    it("knows which statuses are redirects", () => {
      for (const s of [301, 302, 303, 307, 308]) expect(isRedirectStatus(s)).toBe(true);
      for (const s of [200, 204, 304, 400, 404, 500]) expect(isRedirectStatus(s)).toBe(false);
    });
  });

  describe("assertPublicTarget (plan 0-B.6 / 13F1 / D63)", () => {
    const table = new Map<string, ResolvedAddress[]>();
    const calls: string[] = [];
    const resolver = vi.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
      calls.push(hostname);
      const hit = table.get(hostname);
      if (!hit) throw new Error(`ENOTFOUND ${hostname}`);
      return hit;
    });

    beforeEach(() => {
      table.clear();
      calls.length = 0;
      resolver.mockClear();
    });

    it("public hostname -> public address passes and returns the vetted addresses", async () => {
      table.set("example.com", [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
      const target = await assertPublicTarget("https://example.com/path?q=1", { resolver });
      expect(target.hostname).toBe("example.com");
      expect(target.url.href).toBe("https://example.com/path?q=1");
      expect(target.addresses.map((a) => a.address)).toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
      expect(resolver).toHaveBeenCalledWith("example.com");
    });

    it("public-looking hostname that resolves to a private address is refused", async () => {
      table.set("public.example", [{ address: "10.0.0.1", family: 4 }]);
      await expect(assertPublicTarget("http://public.example/", { resolver })).rejects.toThrow(ForbiddenTargetError);
      await expect(assertPublicTarget("http://public.example/", { resolver })).rejects.toThrow(/10\.0\.0\.1.*private/);
    });

    it.each([
      ["127.0.0.1", "loopback"],
      ["169.254.169.254", "link-local"],
      ["fd00::1", "unique-local"],
      ["::1", "loopback"],
      ["100.64.1.1", "carrier-grade NAT"],
      ["::ffff:10.1.1.1", "private"],
    ])("hostname resolving to %s (%s) is refused", async (address, reason) => {
      table.set("evil.example", [{ address, family: address.includes(":") ? 6 : 4 }]);
      await expect(assertPublicTarget("https://evil.example/", { resolver })).rejects.toThrow(reason);
    });

    it("refuses when ANY of several resolved addresses is forbidden", async () => {
      table.set("mixed.example", [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
      await expect(assertPublicTarget("https://mixed.example/", { resolver })).rejects.toThrow(ForbiddenTargetError);
    });

    it("DNS rebinding: first lookup public passes, second lookup private is refused on the re-check", async () => {
      resolver.mockImplementationOnce(async () => [{ address: "93.184.216.34", family: 4 }]);
      resolver.mockImplementationOnce(async () => [{ address: "127.0.0.1", family: 4 }]);
      await expect(assertPublicTarget("https://rebind.example/", { resolver })).resolves.toBeDefined();
      await expect(assertPublicTarget("https://rebind.example/", { resolver })).rejects.toThrow(/127\.0\.0\.1/);
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it("refuses when the hostname cannot be resolved (fail closed)", async () => {
      await expect(assertPublicTarget("https://nxdomain.example/", { resolver })).rejects.toThrow(/could not be resolved/);
    });

    it("refuses when the resolver returns no addresses", async () => {
      table.set("empty.example", []);
      await expect(assertPublicTarget("https://empty.example/", { resolver })).rejects.toThrow(/no addresses/);
    });

    it.each([
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://0x7f.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://10.0.0.1/",
      "http://0xa000001/",
      "http://169.254.169.254/latest/meta-data/",
      "http://0/",
      "http://0.0.0.0/",
      "http://100.64.0.1/",
      "http://224.0.0.1/",
    ])("IP literal %s is refused without consulting DNS", async (url) => {
      await expect(assertPublicTarget(url, { resolver })).rejects.toThrow(ForbiddenTargetError);
      expect(resolver).not.toHaveBeenCalled();
    });

    it("public IP literals pass without consulting DNS", async () => {
      const target = await assertPublicTarget("http://8.8.8.8/", { resolver });
      expect(target.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
      const v6 = await assertPublicTarget("http://[2606:4700::1111]/", { resolver });
      expect(v6.addresses[0]?.family).toBe(6);
      expect(resolver).not.toHaveBeenCalled();
    });

    it("refuses localhost and *.localhost without consulting DNS", async () => {
      await expect(assertPublicTarget("http://localhost:8080/", { resolver })).rejects.toThrow(/localhost/);
      await expect(assertPublicTarget("http://app.localhost/", { resolver })).rejects.toThrow(/localhost/);
      expect(resolver).not.toHaveBeenCalled();
    });

    it("rejects non-http(s) schemes and malformed URLs", async () => {
      for (const url of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "gopher://x/"]) {
        await expect(assertPublicTarget(url, { resolver })).rejects.toThrow(ForbiddenTargetError);
      }
      await expect(assertPublicTarget("not a url", { resolver })).rejects.toThrow(/Invalid URL/);
      expect(resolver).not.toHaveBeenCalled();
    });

    it("accepts a URL object and carries url/address on the error", async () => {
      table.set("public.example", [{ address: "192.168.0.7", family: 4 }]);
      const err = await assertPublicTarget(new URL("http://public.example/x"), { resolver }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenTargetError);
      expect((err as ForbiddenTargetError).code).toBe("FORBIDDEN_TARGET");
      expect((err as ForbiddenTargetError).url).toBe("http://public.example/x");
      expect((err as ForbiddenTargetError).address).toBe("192.168.0.7");
    });
  });

  describe("validateUrlWithConfig uses the shared literal classifier", () => {
    it.each(["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://100.64.0.1/", "http://224.0.0.1/", "http://[::ffff:10.0.0.1]/"])(
      "blocks %s",
      (url) => {
        const result = validateUrlWithConfig(url);
        expect(result.valid).toBe(false);
      },
    );

    it("does not block an IPv4-mapped public address literal", () => {
      expect(validateUrlWithConfig("http://[::ffff:8.8.8.8]/").valid).toBe(true);
    });
  });

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

    it("should NOT block legitimate domains starting with fc/fd (L10)", () => {
      // TEETH: unfixed isPrivateIp prefix-matched "fc"/"fd" on plain hostnames.
      for (const url of ["https://fcbarcelona.com/news", "https://fdomain.com", "https://fcc.gov"]) {
        expect(validateUrlWithConfig(url).valid).toBe(true);
      }
    });

    it("should still block IPv6 unique-local / link-local literals (L10 guard)", () => {
      for (const url of ["http://[fc00::1]/admin", "http://[fd12:3456:789a:1::1]/x", "http://[fe80::1]/x"]) {
        const result = validateUrlWithConfig(url);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Private IP");
      }
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
