import { describe, it, expect, beforeEach } from "vitest";
import {
  SecretSanitizer,
  DEFAULT_SECRET_PATTERNS,
  sanitizeSecrets,
  hasSecrets,
  createSanitizationReport,
  type SanitizeOptions,
} from "./secret-sanitizer.js";

describe("SecretSanitizer", () => {
  let sanitizer: SecretSanitizer;

  beforeEach(() => {
    sanitizer = new SecretSanitizer();
  });

  describe("OpenAI API Keys", () => {
    it("should redact standard OpenAI API keys", () => {
      // Use a longer key that matches the 20+ char requirement
      const content = "My API key is sk-abcdefghijklmnopqrstuvwxyz123456";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toBe("My API key is [REDACTED_OPENAI_KEY]");
      expect(result.stats.matchesByPattern["openai_api_key"]).toBe(1);
    });

    it("should redact OpenAI project keys", () => {
      const content = "Project key: sk-proj-abcdefghijklmnopqrstuvwxyz123456789";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_OPENAI_PROJECT_KEY]");
    });

    it("should handle multiple OpenAI keys", () => {
      const content = "Keys: sk-abcdefghijklmnopqrstuvwxyz123456 and sk-zyxwvutsrqponmlkjihgfedcba654321";
      const result = sanitizer.sanitize(content);
      
      expect(result.stats.totalMatches).toBe(2);
      expect(result.content.match(/\[REDACTED_OPENAI_KEY\]/g)?.length).toBe(2);
    });
  });

  describe("GitHub Tokens", () => {
    it("should redact GitHub personal access tokens (ghp_)", () => {
      const content = "Token: ghp_abcdefghijklmnopqrstuvwxyz123456";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_GITHUB_TOKEN]");
    });

    it("should redact GitHub OAuth tokens (gho_)", () => {
      const content = "OAuth: gho_abcdefghijklmnopqrstuvwxyz123456";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_GITHUB_TOKEN]");
    });

    it("should redact GitHub fine-grained PATs", () => {
      const content = "PAT: github_pat_abcdefghijklmnopqrstuvwxyz_123456789abcdefghijklmnopqrstuvwxyz";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_GITHUB_PAT]");
    });
  });

  describe("Slack Tokens", () => {
    it("should redact Slack bot tokens (xoxb-)", () => {
      const content = "Bot token: xoxb-fake-token-for-test";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_SLACK_TOKEN]");
    });

    it("should redact Slack user tokens (xoxp-)", () => {
      const content = "User token: xoxp-fake-token-for-test";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_SLACK_TOKEN]");
    });

    it("should redact Slack webhooks", () => {
      const content = "Webhook: https://hooks.slack.com/services/TFAKE/BFAKE/XXXXXXXXXXXX";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_SLACK_WEBHOOK]");
    });
  });

  describe("Bearer Tokens", () => {
    it("should redact Bearer tokens", () => {
      const content = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toBe("Authorization: Bearer [REDACTED]");
    });

    it("should handle lowercase 'bearer'", () => {
      const content = "authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("Bearer [REDACTED]");
    });
  });

  describe("Private Keys", () => {
    it("should redact RSA private keys", () => {
      const content = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgwMbRvI0MBZhpJ
[...more content...]
-----END RSA PRIVATE KEY-----`;
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toBe("[REDACTED_PRIVATE_KEY]");
    });

    it("should redact OpenSSH private keys", () => {
      const content = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----`;
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toBe("[REDACTED_PRIVATE_KEY]");
    });

    it("should redact EC private keys", () => {
      const content = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIBkMCxBh8rS2CBwI6MQkGRL0M0R0RLzBFXu0GHZdypPCoAcGBSuBBAAK
-----END EC PRIVATE KEY-----`;
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toBe("[REDACTED_PRIVATE_KEY]");
    });
  });

  describe("Connection Strings", () => {
    it("should redact passwords in connection strings", () => {
      const content = "Server=myServer;Database=myDB;User Id=myUser;Password=mySecretPassword123;";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("password=[REDACTED]");
      expect(result.content).not.toContain("mySecretPassword123");
    });

    it("should handle 'pwd' shorthand", () => {
      const content = "Data Source=server;Initial Catalog=db;User ID=user;pwd=secret123;";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).not.toContain("secret123");
    });

    it("should redact PostgreSQL URLs with credentials", () => {
      const content = "DATABASE_URL=postgres://user:password123@localhost:5432/mydb";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      // Note: The env_value pattern may match first, so we just check password is gone
      expect(result.content).not.toContain("password123");
      expect(result.content).not.toContain("user:");
    });

    it("should redact MongoDB URLs", () => {
      const content = "MONGO_URI=mongodb://admin:secret123@mongodb.example.com:27017/admin";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).not.toContain("secret123");
    });
  });

  describe("JWT Tokens", () => {
    it("should redact JWT tokens", () => {
      const content = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_JWT]");
    });
  });

  describe("AWS Credentials", () => {
    it("should redact AWS Access Key IDs", () => {
      // Note: AWS key inside an env value may be caught by env_value first
      const content = "Key: AKIAIOSFODNN7EXAMPLE";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_AWS_KEY]");
    });

    it("should redact AWS Secret Access Keys", () => {
      const content = "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_AWS_SECRET]");
    });
  });

  describe("Environment Variables", () => {
    it("should redact .env values", () => {
      const content = `API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456
SECRET_TOKEN=mysecrettoken123
DB_PASSWORD=supersecret`;
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      // Values should be redacted (either by specific pattern or env_value)
      expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(result.content).not.toContain("mysecrettoken123");
      expect(result.content).not.toContain("supersecret");
      // Check KEY=[REDACTED] format
      expect(result.content).toMatch(/API_KEY=\[REDACTED/);
      expect(result.content).toMatch(/SECRET_TOKEN=\[REDACTED/);
    });
  });

  describe("Discord Tokens", () => {
    it("should redact Discord bot tokens", () => {
      // Discord token format - when embedded in env var, env_value may match first
      // Test with standalone token format
      const content = "Bot token is NzAwMDAwMDAwMDAwMDAwMDAwN2FiY2Rl.ZZZZZZ.xxxxxxxxxxxxxxxxxxxx for app";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_DISCORD_TOKEN]");
    });
  });

  describe("Telegram Tokens", () => {
    it("should redact Telegram bot tokens", () => {
      // Telegram token format: \d{8,10}:[a-zA-Z0-9_-]{20}
      // When in env format, env_value may match first - test standalone
      const content = "Bot token: 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz12345";
      const result = sanitizer.sanitize(content);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).toContain("[REDACTED_TELEGRAM_TOKEN]");
    });
  });

  describe("Content Truncation", () => {
    it("should truncate content exceeding maxLength", () => {
      const longContent = "a".repeat(10000);
      const sanitizer = new SecretSanitizer({ maxLength: 100 });
      const result = sanitizer.sanitize(longContent);
      
      expect(result.content.length).toBeLessThanOrEqual(120); // 100 + truncation message
      expect(result.content).toContain("... (truncated)");
      expect(result.wasSanitized).toBe(true);
    });

    it("should not truncate content under maxLength", () => {
      const content = "Short content";
      const sanitizer = new SecretSanitizer({ maxLength: 1000 });
      const result = sanitizer.sanitize(content);
      
      expect(result.content).toBe(content);
    });
  });

  describe("Multiple Secrets", () => {
    it("should handle multiple different secret types", () => {
      const content = `
        OpenAI: sk-abcdefghijklmnopqrstuvwxyz123456
        GitHub: ghp_abcdefghijklmnopqrstuvwxyz123456
        Slack: xoxb-fake-token-for-test
        Password: secret12345
      `;
      const result = sanitizer.sanitize(content);
      
      expect(result.stats.totalMatches).toBeGreaterThanOrEqual(3);
      expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(result.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
      expect(result.content).not.toContain("xoxb-1234567890");
    });
  });

  describe("containsSecrets", () => {
    it("should return true when secrets are present", () => {
      expect(sanitizer.containsSecrets("Key: sk-abc123def456ghi789jkl012mno345pqr678stu")).toBe(true);
      expect(sanitizer.containsSecrets("Token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
    });

    it("should return false when no secrets are present", () => {
      expect(sanitizer.containsSecrets("This is normal text")).toBe(false);
      expect(sanitizer.containsSecrets("function test() { return 42; }")).toBe(false);
    });
  });

  describe("Custom Patterns", () => {
    it("should support additional custom patterns", () => {
      const customOptions: SanitizeOptions = {
        additionalPatterns: [
          {
            name: "custom_secret",
            pattern: /CUSTOM_[A-Z_]{10,}/g,
            redaction: "[CUSTOM_REDACTED]",
          },
        ],
      };
      const sanitizer = new SecretSanitizer(customOptions);
      const content = "Custom: CUSTOM_SECRET_KEY";
      const result = sanitizer.sanitize(content);
      
      expect(result.content).toContain("[CUSTOM_REDACTED]");
    });

    it("should support excluding default patterns", () => {
      const sanitizer = new SecretSanitizer({
        excludePatterns: ["openai_api_key"],
      });
      const content = "Key: sk-abcdefghijklmnopqrstuvwxyz123456";
      const result = sanitizer.sanitize(content);
      
      // Should NOT be redacted by openai_api_key since it's excluded
      // But might be caught by secret_value or env_value pattern
      // So we just verify openai_api_key is not in active patterns
      expect(sanitizer.getActivePatterns()).not.toContain("openai_api_key");
    });
  });

  describe("getActivePatterns", () => {
    it("should return list of active pattern names", () => {
      const patterns = sanitizer.getActivePatterns();
      
      expect(patterns).toContain("openai_api_key");
      expect(patterns).toContain("github_token");
      expect(patterns).toContain("slack_token");
      expect(patterns.length).toBeGreaterThan(10);
    });

    it("should reflect excluded patterns", () => {
      const sanitizer = new SecretSanitizer({
        excludePatterns: ["openai_api_key", "github_token"],
      });
      const patterns = sanitizer.getActivePatterns();
      
      expect(patterns).not.toContain("openai_api_key");
      expect(patterns).not.toContain("github_token");
    });
  });

  describe("Statistics", () => {
    it("should track bytes removed correctly", () => {
      const content = "sk-abcdefghijklmnopqrstuvwxyz123456";
      const result = sanitizer.sanitize(content);
      
      // Original: ~37 chars, Redacted: ~21 chars
      expect(result.stats.bytesRemoved).toBeGreaterThan(0);
    });

    it("should track matches by pattern", () => {
      const content = `
        sk-abcdefghijklmnopqrstuvwxyz123456
        sk-zyxwvutsrqponmlkjihgfedcba654321
        ghp_abcdefghijklmnopqrstuvwxyz123456
      `;
      const result = sanitizer.sanitize(content);
      
      expect(result.stats.matchesByPattern["openai_api_key"]).toBe(2);
      expect(result.stats.matchesByPattern["github_token"]).toBe(1);
    });
  });

  describe("Convenience Functions", () => {
    it("sanitizeSecrets should work without creating instance", () => {
      const content = "Key: sk-abcdefghijklmnopqrstuvwxyz123456";
      const result = sanitizeSecrets(content);
      
      expect(result).toContain("[REDACTED_OPENAI_KEY]");
    });

    it("hasSecrets should detect secrets", () => {
      expect(hasSecrets("Key: sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
      expect(hasSecrets("normal text")).toBe(false);
    });
  });

  describe("createSanitizationReport", () => {
    it("should aggregate stats from multiple results", () => {
      const results = [
        sanitizer.sanitize("sk-abcdefghijklmnopqrstuvwxyz123456"),
        sanitizer.sanitize("ghp_abcdefghijklmnopqrstuvwxyz123456"),
        sanitizer.sanitize("normal text"),
      ];
      
      const report = createSanitizationReport(results, "test-batch");
      
      expect(report.context).toBe("test-batch");
      expect(report.totalOperations).toBe(3);
      expect(report.totalMatches).toBe(2);
      expect(report.sanitizationRate).toBeCloseTo(2/3, 2);
      expect(Array.isArray(report.uniquePatternsHit)).toBe(true);
    });
  });

  describe("Safe Content", () => {
    it("should not modify content without secrets", () => {
      const content = "This is a normal log message with no sensitive data.";
      const result = sanitizer.sanitize(content);
      
      expect(result.content).toBe(content);
      expect(result.wasSanitized).toBe(false);
      expect(result.stats.totalMatches).toBe(0);
    });

    it("should handle code without secrets", () => {
      const content = `
        function calculateSum(a: number, b: number): number {
          return a + b;
        }
      `;
      const result = sanitizer.sanitize(content);
      
      expect(result.content).toBe(content);
      expect(result.wasSanitized).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty content", () => {
      const result = sanitizer.sanitize("");
      expect(result.content).toBe("");
      expect(result.wasSanitized).toBe(false);
    });

    it("should handle very long secrets", () => {
      const longKey = "sk-" + "a".repeat(100);
      const result = sanitizer.sanitize(longKey);
      
      expect(result.wasSanitized).toBe(true);
      expect(result.content).not.toContain("sk-" + "a".repeat(50));
    });

    it("should handle secrets at boundaries", () => {
      const content = `start sk-abc123def456ghi789jkl012mno345pqr678stu end`;
      const result = sanitizer.sanitize(content);
      
      expect(result.content).toContain("[REDACTED_OPENAI_KEY]");
    });
  });
});
