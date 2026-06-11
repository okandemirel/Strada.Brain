import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to test the actual logger module, but it has a singleton.
// Reset the module between tests.
describe("logger", () => {
  beforeEach(async () => {
    vi.resetModules();
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

  it("sanitizes secrets in ring-buffer entries at write time once the sanitizer is registered", async () => {
    const { createLogger, getLogRingBuffer, setLogRingBufferSanitizer } = await import("./logger.js");
    const { sanitizeSecrets } = await import("../security/secret-sanitizer.js");
    // bootstrap.ts performs this registration at startup; mirror it here.
    setLogRingBufferSanitizer(sanitizeSecrets);
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
});
