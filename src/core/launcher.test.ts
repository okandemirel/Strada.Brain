import { describe, expect, it } from "vitest";
import {
  buildLauncherMenu,
  getConfiguredDefaultChannel,
  resolveQuickLaunchAction,
} from "./launcher.js";

describe("launcher", () => {
  it("uses DEFAULT_CHANNEL when it is valid", () => {
    expect(getConfiguredDefaultChannel({ DEFAULT_CHANNEL: "cli" })).toBe("cli");
    expect(getConfiguredDefaultChannel({ DEFAULT_CHANNEL: "teams" })).toBe("teams");
  });

  it("falls back to web when DEFAULT_CHANNEL is missing or invalid", () => {
    expect(getConfiguredDefaultChannel({})).toBe("web");
    expect(getConfiguredDefaultChannel({ DEFAULT_CHANNEL: "desktop" })).toBe("web");
  });

  it("resolves a single quick-launch flag into a start action", () => {
    expect(resolveQuickLaunchAction({ web: true })).toEqual({
      kind: "start",
      channelType: "web",
      daemonMode: false,
    });
    expect(resolveQuickLaunchAction({ terminal: true })).toEqual({
      kind: "start",
      channelType: "cli",
      daemonMode: false,
    });
    expect(resolveQuickLaunchAction({ cli: true, daemon: true })).toEqual({
      kind: "start",
      channelType: "cli",
      daemonMode: true,
    });
  });

  it("rejects multiple quick-launch flags at once", () => {
    expect(() => resolveQuickLaunchAction({ web: true, cli: true })).toThrow(
      "Choose only one quick launch flag at a time.",
    );
  });

  it("builds a launcher menu that includes default, setup, and doctor actions", () => {
    const entries = buildLauncherMenu({
      defaultChannel: "web",
      webPort: 3000,
      dashboardPort: 3100,
    });

    expect(entries[0]).toMatchObject({
      key: "1",
      action: { kind: "start", channelType: "web", daemonMode: false },
    });
    expect(entries.some((entry) => entry.action.kind === "doctor")).toBe(true);
    expect(entries.some((entry) => entry.action.kind === "setup")).toBe(true);
  });
});
