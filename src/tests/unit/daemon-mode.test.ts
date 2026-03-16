import { describe, it, expect } from "vitest";

describe("shouldEnableDaemonMode", () => {
  it("does not enable daemon for cli sessions from env alone", async () => {
    const { shouldEnableDaemonMode } = await import("../../core/daemon-mode.js");

    expect(
      shouldEnableDaemonMode("cli", false, {
        STRADA_DAEMON_ENABLED: "true",
      }),
    ).toBe(false);
  });

  it("keeps explicit daemon flag authoritative for cli sessions", async () => {
    const { shouldEnableDaemonMode } = await import("../../core/daemon-mode.js");

    expect(
      shouldEnableDaemonMode("cli", true, {
        STRADA_DAEMON_ENABLED: "false",
      }),
    ).toBe(true);
  });

  it("allows configured daemon mode for non-cli channels", async () => {
    const { shouldEnableDaemonMode } = await import("../../core/daemon-mode.js");

    expect(
      shouldEnableDaemonMode("web", false, {
        STRADA_DAEMON_ENABLED: "true",
      }),
    ).toBe(true);
  });
});
