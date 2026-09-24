import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to test the actual logger module, but it has a singleton.
// Reset the module between tests.
describe("logger", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("redacts secrets on the FILE transport, not just the ring buffer", async () => {
    // Redaction used to run only inside RingBufferTransport, so a value the
    // dashboard showed as [REDACTED] was written in clear text to the rotating
    // log file and to stdout — where container log collectors and CI job logs
    // pick it up.
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "strada-logredact-"));
    const logFile = join(dir, "redact.log");

    const { createLogger } = await import("./logger.js");
    const logger = createLogger("info", logFile);

    const canary = "sk-ant-api03-CANARYSECRETVALUE1234567890abcdefXYZ";
    logger.info("provider configured", { apiKey: canary, nested: { inner: canary } });
    logger.info(`bare message containing ${canary} inline`);

    // Winston's File transport writes asynchronously.
    await new Promise((r) => setTimeout(r, 600));

    expect(existsSync(logFile)).toBe(true);
    const onDisk = readFileSync(logFile, "utf8");
    expect(onDisk.length).toBeGreaterThan(0);
    // The secret must appear nowhere: not in meta, not nested, not inline.
    expect(onDisk).not.toContain("CANARYSECRETVALUE1234567890abcdefXYZ");
    expect(onDisk).toMatch(/REDACTED/i);
  });

  it("getLogger throws before createLogger is called", async () => {
    const { getLogger } = await import("./logger.js");
    expect(() => getLogger()).toThrow("Logger not initialized");
  });

  it("createLogger returns a logger", async () => {
    const { createLogger } = await import("./logger.js");
    const logger = createLogger("info", "/tmp/test-strada.log");
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
  });

  it("getLogger returns logger after createLogger", async () => {
    const { createLogger, getLogger } = await import("./logger.js");
    createLogger("debug", "/tmp/test-strada.log");
    const logger = getLogger();
    expect(logger).toBeDefined();
  });

  it("getLoggerSafe returns a no-op logger before createLogger", async () => {
    const { getLoggerSafe } = await import("./logger.js");
    const logger = getLoggerSafe();

    expect(logger).toBeDefined();
    expect(() => logger.debug("debug")).not.toThrow();
    expect(() => logger.info("info")).not.toThrow();
    expect(() => logger.warn("warn")).not.toThrow();
    expect(() => logger.error("error")).not.toThrow();
  });

  it("getLoggerSafe returns the initialized logger after createLogger", async () => {
    const { createLogger, getLoggerSafe } = await import("./logger.js");
    const created = createLogger("debug", "/tmp/test-strada.log");
    const logger = getLoggerSafe();

    expect(logger).toBe(created);
  });

  it("createLogger returns same instance on second call", async () => {
    const { createLogger } = await import("./logger.js");
    const logger1 = createLogger("info", "/tmp/test-strada.log");
    const logger2 = createLogger("debug", "/tmp/test-strada-2.log");
    expect(logger1).toBe(logger2);
  });

  it("sanitizes secrets in ring-buffer entries at write time", async () => {
    const { createLogger, getLogRingBuffer } = await import("./logger.js");
    const logger = createLogger("info", "/tmp/test-strada.log");
    const secret = "abc123def456ghi789jkl012";

    logger.info(`auth header was Authorization: Bearer ${secret}`);
    logger.info("meta-entry", { header: `Authorization: Bearer ${secret}` });
    await new Promise((resolve) => setImmediate(resolve));

    const entries = getLogRingBuffer();
    const messageEntry = entries.find((e) => e.message.includes("auth header was"));
    expect(messageEntry).toBeDefined();
    expect(messageEntry!.message).toContain("[REDACTED]");
    expect(messageEntry!.message).not.toContain(secret);

    const metaEntry = entries.find((e) => e.message === "meta-entry");
    expect(metaEntry).toBeDefined();
    const serializedMeta = JSON.stringify(metaEntry!.meta);
    expect(serializedMeta).toContain("[REDACTED]");
    expect(serializedMeta).not.toContain(secret);
  });

  it("preserves meta structure when sanitizing credential-bearing fields (Bug 2)", async () => {
    // Patterns whose char classes admit JSON delimiters ('"', '}', ';') used to
    // corrupt the serialized JSON → JSON.parse failed → the WHOLE meta collapsed
    // to {_sanitizeFailed:true}, dropping chatId and every other diagnostic field.
    const { createLogger, getLogRingBuffer } = await import("./logger.js");
    const logger = createLogger("info", "/tmp/test-strada.log");

    logger.info("conn-meta", {
      chatId: "chat-1234",
      conn: "host=db.internal password=hunter22longvalue",
    });
    logger.info("env-meta", {
      chatId: "chat-5678",
      OPENAI_API_KEY: "sk-abcdef0123456789abcdef0123",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const entries = getLogRingBuffer();

    const connEntry = entries.find((e) => e.message === "conn-meta");
    expect(connEntry).toBeDefined();
    expect(connEntry!.meta).not.toHaveProperty("_sanitizeFailed");
    // Structure + sibling keys survive.
    expect(connEntry!.meta!.chatId).toBe("chat-1234");
    expect(connEntry!.meta).toHaveProperty("conn");
    const connStr = JSON.stringify(connEntry!.meta);
    expect(connStr).toContain("[REDACTED]");
    expect(connStr).not.toContain("hunter22longvalue");

    const envEntry = entries.find((e) => e.message === "env-meta");
    expect(envEntry).toBeDefined();
    expect(envEntry!.meta).not.toHaveProperty("_sanitizeFailed");
    expect(envEntry!.meta!.chatId).toBe("chat-5678");
    expect(envEntry!.meta).toHaveProperty("OPENAI_API_KEY");
    const envStr = JSON.stringify(envEntry!.meta);
    expect(envStr).not.toContain("sk-abcdef0123456789abcdef0123");
  });

  // The shared redaction format walked meta as plain JSON: a cycle overflowed
  // the stack and threw into the caller, and Date/Error/Map values came out as
  // {} in every transport — every `{ error }` log line lost its reason.
  it("survives circular meta instead of throwing into the caller", async () => {
    const { createLogger, getLogRingBuffer } = await import("./logger.js");
    const logger = createLogger("info", "/tmp/test-strada.log");
    const circ: Record<string, unknown> = { name: "loop" };
    circ["self"] = circ;
    const shared = { k: "v" };

    expect(() => logger.info("circ-meta", { circ, a: shared, b: shared })).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    const entry = getLogRingBuffer().find((e) => e.message === "circ-meta");
    expect(entry).toBeDefined();
    expect(entry!.meta!["circ"]).toEqual({ name: "loop", self: "[Circular]" });
    // A value referenced twice is shared, not circular.
    expect(entry!.meta!["b"]).toEqual({ k: "v" });
  });

  it("keeps Dates, Errors and Maps instead of logging {}", async () => {
    const { createLogger, getLogRingBuffer } = await import("./logger.js");
    const logger = createLogger("info", "/tmp/test-strada.log");

    const error = Object.assign(new Error("boom"), { code: "EBOOM" });
    logger.info("typed-meta", { at: new Date(0), error, m: new Map([["k", "v"]]) });
    await new Promise((resolve) => setImmediate(resolve));

    const meta = getLogRingBuffer().find((e) => e.message === "typed-meta")!.meta!;
    expect(meta["at"]).toBe("1970-01-01T00:00:00.000Z");
    expect(meta["error"]).toMatchObject({ name: "Error", message: "boom", code: "EBOOM" });
    expect(String((meta["error"] as { stack?: string }).stack)).toContain("boom");
    expect(meta["m"]).toEqual({ k: "v" });
  });

  it("does not silently cut long values at the tool-output cap", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const logFile = join(mkdtempSync(join(tmpdir(), "strada-loglong-")), "long.log");
    const { createLogger } = await import("./logger.js");
    const logger = createLogger("info", logFile);

    logger.info("long-meta", { body: `${"a".repeat(20_000)}END-OF-BODY` });
    await new Promise((r) => setTimeout(r, 600));

    const onDisk = readFileSync(logFile, "utf8");
    expect(onDisk).toContain("END-OF-BODY");
    expect(onDisk).not.toContain("(truncated)");
  });

  it("does not walk or redact meta for a level that is filtered out", async () => {
    // Formats run before the transports' level filter: every suppressed
    // debug() line still paid for a full regex pass over its meta.
    const { createLogger } = await import("./logger.js");
    const logger = createLogger("info", "/tmp/test-strada.log");
    let reads = 0;
    // Nested: winston copies the top level itself; only the format walks deeper.
    const meta = (): Record<string, unknown> => ({
      nested: {
        get detail(): string {
          reads++;
          return "token=abcdefghijklmnopqrstuvwxyz";
        },
      },
    });

    logger.debug("suppressed", meta());
    expect(reads, "a filtered-out line was still sanitized").toBe(0);

    logger.info("kept", meta());
    expect(reads).toBeGreaterThan(0);
  });

  it("does NOT fire the sanitization metric callback from the ring-buffer path (Bug 3)", async () => {
    // Ring-buffer redaction is defense-in-depth, not a distinct exposure event,
    // so it must not inflate the user-facing "Secrets Sanitized" metric.
    const { createLogger, getLogRingBuffer } = await import("./logger.js");
    const { setSanitizationCallback } = await import("../security/secret-patterns.js");

    const callback = vi.fn();
    setSanitizationCallback(callback);
    try {
      const logger = createLogger("info", "/tmp/test-strada.log");
      const secret = "abc123def456ghi789jkl012";
      logger.info(`ringbuffer Authorization: Bearer ${secret}`);
      await new Promise((resolve) => setImmediate(resolve));

      // Redaction still happened...
      const entry = getLogRingBuffer().find((e) => e.message.includes("ringbuffer"));
      expect(entry).toBeDefined();
      expect(entry!.message).toContain("[REDACTED]");
      expect(entry!.message).not.toContain(secret);
      // ...but the metric callback was never fired from this path.
      expect(callback).not.toHaveBeenCalled();
    } finally {
      setSanitizationCallback(null);
    }
  });
});
