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

  it("combines several quick-launch flags into one multi-channel start (2026-09-09)", () => {
    expect(resolveQuickLaunchAction({ web: true, telegram: true, daemon: true })).toEqual({
      kind: "start",
      channelType: "web,telegram",
      daemonMode: true,
    });
    // --terminal and --cli are the same channel; it is not started twice.
    expect(resolveQuickLaunchAction({ terminal: true, cli: true })?.channelType).toBe("cli");
  });

  it("accepts a multi-channel DEFAULT_CHANNEL and labels it in the menu", async () => {
    const { getConfiguredDefaultChannel, buildLauncherMenu } = await import("./launcher.js");
    expect(getConfiguredDefaultChannel({ DEFAULT_CHANNEL: "web, telegram" } as NodeJS.ProcessEnv)).toBe("web,telegram");
    expect(getConfiguredDefaultChannel({ DEFAULT_CHANNEL: "web,whatsapp" } as NodeJS.ProcessEnv)).toBe("web");
    const menu = buildLauncherMenu({ defaultChannel: "web,telegram", webPort: 3000, dashboardPort: 3001 });
    expect(menu[0]?.label).toContain("Web dashboard + Telegram bot");
    expect(menu[0]?.detail).toContain("http://127.0.0.1:3000");
    // web is already part of the default, so no separate "open web" entry; the CLI entry stays.
    expect(menu.map((e) => e.label)).not.toContain("Open local web dashboard");
    expect(menu.map((e) => e.label)).toContain("Start interactive CLI chat");
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
