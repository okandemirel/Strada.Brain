import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createLogger: vi.fn(),
}));

import { decryptEnvValue, encryptEnvValue, KeyManager } from "./data-protection.js";

describe("data-protection", () => {
  afterEach(() => {
    delete process.env["ENCRYPTION_KEY"];
  });

  it("initializes a key manager with a master key", () => {
    const keyManager = new KeyManager("test-master-key");
    expect(keyManager.getCurrentKey()).toBeDefined();
    keyManager.destroy();
  });

  it("derives the same key material from the same master key", () => {
    const first = new KeyManager("test-master-key");
    const second = new KeyManager("test-master-key");

    expect(first.getCurrentKey()?.key.equals(second.getCurrentKey()?.key ?? Buffer.alloc(0))).toBe(true);

    first.destroy();
    second.destroy();
  });

  it("round-trips env values when an explicit key is provided", () => {
    const encrypted = encryptEnvValue("secret-value", "test-master-key");
    const decrypted = decryptEnvValue(encrypted, "test-master-key");

    expect(decrypted).toBe("secret-value");
  });

  it("round-trips env values from ENCRYPTION_KEY", () => {
    process.env["ENCRYPTION_KEY"] = "env-master-key";

    const encrypted = encryptEnvValue("secret-from-env");
    const decrypted = decryptEnvValue(encrypted);

    expect(decrypted).toBe("secret-from-env");
  });
});
