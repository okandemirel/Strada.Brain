import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SECRET_PATTERNS,
  MAX_OUTPUT_LENGTH,
  applySecretPatterns,
  redactSecrets,
  redactSecretsDeep,
  sanitizeSecrets,
  sanitizeSecretsQuiet,
  setSanitizationCallback,
  stringifyRedacted,
} from "./secret-patterns.js";

afterEach(() => {
  setSanitizationCallback(null);
});

describe("applySecretPatterns — multi-match function redactions (Bug 1)", () => {
  it("redacts each match from its OWN text (no cross-record host stamping)", () => {
    // Two DIFFERENT database URLs. The function redaction keeps scheme+host.
    // The old code computed the replacement ONCE from matches[0] and stamped it
    // over BOTH, leaking host-a onto host-b's record. Each must keep its own host.
    const input =
      "primary postgres://user:pass1@host-a.example:5432/db " +
      "replica postgres://user:pass2@host-b.example:5432/db";

    const { content } = applySecretPatterns(input, DEFAULT_SECRET_PATTERNS, MAX_OUTPUT_LENGTH);

    expect(content).toContain("@host-a.example:5432/db");
    expect(content).toContain("@host-b.example:5432/db");
    // Credentials are gone for both.
    expect(content).not.toContain("pass1");
    expect(content).not.toContain("pass2");
    expect(content.match(/\[REDACTED_CREDENTIALS\]/g)?.length).toBe(2);
  });

  it("does not $-expand function-redaction output (password containing $&)", () => {
    // The redaction return value must NOT be passed as the String.replace
    // pattern string, otherwise "$&" re-inserts the entire matched secret.
    const input = "db postgres://user:p$&ss-word@host-c.example:5432/db";

    const { content } = applySecretPatterns(input, DEFAULT_SECRET_PATTERNS, MAX_OUTPUT_LENGTH);

    // Output is not corrupted and does not contain the original credentials.
    expect(content).toContain("@host-c.example:5432/db");
    expect(content).not.toContain("p$&ss-word");
    expect(content).toContain("[REDACTED_CREDENTIALS]");
  });

  it("preserves group-ref ($1) string redactions for env_value", () => {
    // The STRING-redaction path must keep $1 group expansion intact.
    const input = "MY_SECRET_TOKEN=supersecretvalue1234567890";

    const { content } = applySecretPatterns(input, DEFAULT_SECRET_PATTERNS, MAX_OUTPUT_LENGTH);

    expect(content).toContain("MY_SECRET_TOKEN=[REDACTED]");
    expect(content).not.toContain("supersecretvalue1234567890");
  });

  it("does not flag the 'sk-' inside a workspace-lease path segment ('task-<hex>')", () => {
    const input = "/var/folders/xx/T/strada-workspaces/task-2b4261e9f03c17f4abcd/Assets";

    const { content } = applySecretPatterns(input, DEFAULT_SECRET_PATTERNS, MAX_OUTPUT_LENGTH);

    expect(content).toBe(input);
  });

  it("still flags a real OpenAI key at a word boundary", () => {
    const input = "key: sk-2b4261e9f03c17f4abcdefgh";

    const { content } = applySecretPatterns(input, DEFAULT_SECRET_PATTERNS, MAX_OUTPUT_LENGTH);

    expect(content).toContain("[REDACTED_OPENAI_KEY]");
    expect(content).not.toContain("sk-2b4261e9f03c17f4abcdefgh");
  });
});

describe("sanitizeSecretsQuiet vs sanitizeSecrets metric emission (Bug 3)", () => {
  it("sanitizeSecretsQuiet redacts but does NOT fire the sanitization callback", () => {
    const callback = vi.fn();
    setSanitizationCallback(callback);

    const out = sanitizeSecretsQuiet("Authorization: Bearer abc123def456ghi789jkl012");

    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abc123def456ghi789jkl012");
    expect(callback).not.toHaveBeenCalled();
  });

  it("sanitizeSecrets still fires the callback (emitting variant unchanged)", () => {
    const callback = vi.fn();
    setSanitizationCallback(callback);

    const out = sanitizeSecrets("Authorization: Bearer abc123def456ghi789jkl012");

    expect(out).toContain("[REDACTED]");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.any(Number));
  });

  it("does not fire the callback when there is nothing to redact", () => {
    const callback = vi.fn();
    setSanitizationCallback(callback);

    sanitizeSecrets("just a plain log line with no secrets");

    expect(callback).not.toHaveBeenCalled();
  });
});

// SEC-3: storage paths redact without the display cap, and structured data is
// redacted per value so the stored JSON still parses.
describe("redaction for stored data (SEC-3)", () => {
  const key = "sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu901VWX234";

  it("redactSecrets redacts but never truncates", () => {
    const long = `${"x".repeat(20_000)} ${key}`;
    const out = redactSecrets(long);
    expect(out).not.toContain(key);
    expect(out.startsWith("x".repeat(20_000))).toBe(true);
    expect(out).not.toContain("(truncated)");
    // The display path keeps its cap.
    expect(sanitizeSecrets(long).length).toBeLessThan(MAX_OUTPUT_LENGTH + 100);
  });

  it("stringifyRedacted keeps JSON valid where regexes over the serialized form broke it", () => {
    const value = { token: "abcdefghijklmnopqrstuvwxyz", note: "keep me" };
    // The old storage form: redaction ate the key/value quotes.
    expect(() => JSON.parse(sanitizeSecrets(JSON.stringify(value)))).toThrow();
    const parsed = JSON.parse(stringifyRedacted(value)) as Record<string, string>;
    expect(parsed.token).toBe("[REDACTED_SECRET]");
    expect(parsed.note).toBe("keep me");
  });

  it("round-trips a structure larger than the display cap", () => {
    const steps = [{ toolName: "file_read", output: "line\n".repeat(4000), input: { path: "a.cs", auth: `Bearer ${key}` } }];
    const parsed = JSON.parse(stringifyRedacted(steps)) as typeof steps;
    expect(parsed[0]!.output).toBe(steps[0]!.output);
    expect(parsed[0]!.input.auth).not.toContain(key);
  });

  it("redactSecretsDeep redacts nested leaves and secret-bearing keys, and survives cycles", () => {
    const cyclic: Record<string, unknown> = { list: [`use ${key}`], nested: { [key]: 1 } };
    cyclic.self = cyclic;
    const out = redactSecretsDeep(cyclic);
    expect(JSON.stringify(out)).not.toContain(key);
    expect(out.self).toBe("[Circular]");
    expect(Object.keys(out.nested as object)[0]).toContain("REDACTED");
  });
});

// SEC-9: code was redacted as secrets (so stored C# stopped compiling), while
// partial or encrypted private keys and "@"-bearing DB passwords got through.
describe("pattern precision (SEC-9)", () => {
  const redact = (s: string): string =>
    applySecretPatterns(s, DEFAULT_SECRET_PATTERNS, Number.POSITIVE_INFINITY).content;

  it.each([
    "var cacheKey = BuildCacheKeyForPlayerProfile(profile);",
    "using MonoBehaviourExtensions.Runtime.PlayerControllerComponents;",
    "string token = tokenProvider.GetAccessTokenForCurrentUser();",
  ])("leaves code alone: %s", (code) => {
    expect(redact(code)).toBe(code);
  });

  it.each([
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAw5f0partial", "MIIEowIBAAKCAQEAw5f0partial"],
    ["-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0w\n-----END ENCRYPTED PRIVATE KEY-----", "MIIFHDBOBgkqhkiG9w0BBQ0w"],
    ["postgres://admin:p@ss@db.internal:5432/app", "ss@db"],
    ['password = "hunter2hunter2hunter2hunter2"', "hunter2hunter2"],
    ["Bot token is NzAwMDAwMDAwMDAwMDAwMDAwN2FiY2Rl.ZZZZZZ.xxxxxxxxxxxxxxxxxxxx for app", "NzAwMDAw"],
  ])("redacts key material: %s", (input, secretPart) => {
    expect(redact(input)).not.toContain(secretPart);
  });

  it("keeps the host of a DB URL whose password contains '@'", () => {
    expect(redact("postgres://admin:p@ss@db.internal:5432/app")).toBe(
      "postgres://[REDACTED_CREDENTIALS]@db.internal:5432/app",
    );
  });
});
