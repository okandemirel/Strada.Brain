import { afterEach, describe, expect, it, vi } from "vitest";
import { setupGlobalErrorHandlers } from "./errors.js";

// The unhandled-rejection handler printed the raw Error with console.error,
// past the logger's redaction format, so a key in a rejection's message or
// stack reached stderr (and container / CI logs) in clear text.
describe("setupGlobalErrorHandlers", () => {
  const before = process.listeners("unhandledRejection");

  afterEach(() => {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!before.includes(listener)) process.off("unhandledRejection", listener);
    }
    vi.restoreAllMocks();
  });

  it("redacts secrets from what it prints, and still hands the error on", () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    setupGlobalErrorHandlers(onError);
    const secret = "sk-ant-api03-CANARYSECRETVALUE1234567890abcdefXYZ";

    process.emit("unhandledRejection", new Error(`provider rejected key ${secret}`), Promise.resolve());

    const output = printed.mock.calls.flat().map(String).join(" ");
    expect(output).toContain("Unhandled Rejection");
    expect(output).toContain("provider rejected key");
    expect(output).not.toContain("CANARYSECRETVALUE1234567890abcdefXYZ");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
