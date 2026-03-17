import { describe, expect, it } from "vitest";
import { webhookUrlSchema } from "./schemas.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/tmp/strada-validation-test.log");

describe("webhookUrlSchema", () => {
  it("accepts external HTTPS webhook URLs", () => {
    expect(() => webhookUrlSchema.parse("https://hooks.example.com/notify")).not.toThrow();
  });

  it("rejects non-HTTPS URLs", () => {
    expect(() => webhookUrlSchema.parse("http://hooks.example.com/notify")).toThrow(/HTTPS/);
  });

  it("rejects localhost and private-network targets", () => {
    expect(() => webhookUrlSchema.parse("https://localhost:3000/webhook")).toThrow(/private\/internal/i);
    expect(() => webhookUrlSchema.parse("https://169.254.169.254/latest/meta-data")).toThrow(/private\/internal/i);
  });

  it("rejects common DNS rebinding hostnames", () => {
    expect(() => webhookUrlSchema.parse("https://127.0.0.1.nip.io/webhook")).toThrow(/private\/internal/i);
  });

  it("does not reject safe external URLs that mention localhost-like strings outside the host", () => {
    expect(() => webhookUrlSchema.parse("https://example.com/webhook?next=127.0.0.1")).not.toThrow();
  });
});
