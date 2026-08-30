import { describe, it, expect } from "vitest";

describe("shouldEnableDaemonMode", () => {
  it("daemon autonomy is DEFAULT-ON, cli included (it is the product, not a mode)", async () => {
    const { shouldEnableDaemonMode } = await import("../../core/daemon-mode.js");

    expect(shouldEnableDaemonMode("cli", false, {})).toBe(true);
    expect(shouldEnableDaemonMode("cli", false, { STRADA_DAEMON_ENABLED: "true" })).toBe(true);
    expect(shouldEnableDaemonMode("web", false, {})).toBe(true);
  });

  it("STRADA_DAEMON_ENABLED=false is the explicit opt-out", async () => {
    const { shouldEnableDaemonMode } = await import("../../core/daemon-mode.js");

    expect(shouldEnableDaemonMode("cli", false, { STRADA_DAEMON_ENABLED: "false" })).toBe(false);
    expect(shouldEnableDaemonMode("web", false, { STRADA_DAEMON_ENABLED: "false" })).toBe(false);
  });

  it("explicit --daemon flag overrides even the opt-out", async () => {
    const { shouldEnableDaemonMode } = await import("../../core/daemon-mode.js");

    expect(shouldEnableDaemonMode("cli", true, { STRADA_DAEMON_ENABLED: "false" })).toBe(true);
  });
});
