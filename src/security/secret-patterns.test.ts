import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SECRET_PATTERNS,
  MAX_OUTPUT_LENGTH,
  applySecretPatterns,
  sanitizeSecrets,
  sanitizeSecretsQuiet,
  setSanitizationCallback,
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
