import { describe, it, expect } from "vitest";
import { shutdownExitCode } from "./shutdown-exit-code.js";

describe("shutdownExitCode (audit 14F5 / D74)", () => {
  it("a fatal error exits non-zero even when cleanup succeeded, so Restart=on-failure restarts the unit", () => {
    expect(shutdownExitCode("uncaughtException", true)).toBe(1);
    expect(shutdownExitCode("unhandled-rejection-storm", true)).toBe(1);
  });

  it("an ordinary signal shutdown still exits clean; a failed cleanup is 1 either way (guard)", () => {
    expect(shutdownExitCode("SIGTERM", true)).toBe(0);
    expect(shutdownExitCode("SIGINT", true)).toBe(0);
    expect(shutdownExitCode("SIGHUP", true)).toBe(0);
    expect(shutdownExitCode("SIGTERM", false)).toBe(1);
  });
});
