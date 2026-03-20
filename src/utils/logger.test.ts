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
});
