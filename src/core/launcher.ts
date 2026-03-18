/* eslint-disable no-console -- launcher is a user-facing terminal entrypoint */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CHANNEL_DEFAULTS, type SupportedChannelType } from "../common/constants.js";

export interface RootLaunchOptions {
  readonly daemon?: boolean;
  readonly web?: boolean;
  readonly cli?: boolean;
  readonly telegram?: boolean;
  readonly discord?: boolean;
  readonly slack?: boolean;
  readonly whatsapp?: boolean;
  readonly matrix?: boolean;
  readonly irc?: boolean;
  readonly teams?: boolean;
}

export interface LauncherMenuContext {
  readonly defaultChannel: SupportedChannelType;
  readonly webPort: number;
  readonly dashboardPort: number;
}

export type LauncherAction =
  | { readonly kind: "start"; readonly channelType: SupportedChannelType; readonly daemonMode: boolean }
  | { readonly kind: "setup" }
  | { readonly kind: "doctor" }
  | { readonly kind: "exit" };

interface LauncherMenuEntry {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly action: LauncherAction;
}

const QUICK_LAUNCH_FLAGS: ReadonlyArray<{
  readonly option: keyof RootLaunchOptions;
  readonly channelType: SupportedChannelType;
}> = [
  { option: "web", channelType: "web" },
  { option: "cli", channelType: "cli" },
  { option: "telegram", channelType: "telegram" },
  { option: "discord", channelType: "discord" },
  { option: "slack", channelType: "slack" },
  { option: "whatsapp", channelType: "whatsapp" },
  { option: "matrix", channelType: "matrix" },
  { option: "irc", channelType: "irc" },
  { option: "teams", channelType: "teams" },
];

const CHANNEL_LABELS: Record<SupportedChannelType, string> = {
  web: "Web dashboard",
  cli: "Interactive CLI",
  telegram: "Telegram bot",
  discord: "Discord bot",
  whatsapp: "WhatsApp",
  slack: "Slack",
  matrix: "Matrix",
  irc: "IRC",
  teams: "Microsoft Teams",
};

export function getConfiguredDefaultChannel(
  env: NodeJS.ProcessEnv = process.env,
): SupportedChannelType {
  const raw = env["DEFAULT_CHANNEL"]?.trim().toLowerCase();
  if (!raw) {
    return CHANNEL_DEFAULTS.DEFAULT_TYPE;
  }

  if ((CHANNEL_DEFAULTS.SUPPORTED_TYPES as readonly string[]).includes(raw)) {
    return raw as SupportedChannelType;
  }

  return CHANNEL_DEFAULTS.DEFAULT_TYPE;
}

export function resolveQuickLaunchAction(
  options: RootLaunchOptions,
): LauncherAction | null {
  const selectedChannels = QUICK_LAUNCH_FLAGS
    .filter(({ option }) => options[option])
    .map(({ channelType }) => channelType);

  if (selectedChannels.length > 1) {
    throw new Error("Choose only one quick launch flag at a time.");
  }

  if (selectedChannels.length === 1) {
    return {
      kind: "start",
      channelType: selectedChannels[0]!,
      daemonMode: options.daemon ?? false,
    };
  }

  return null;
}

export function buildLauncherMenu(context: LauncherMenuContext): readonly LauncherMenuEntry[] {
  const entries: LauncherMenuEntry[] = [];
  const appendEntry = (entry: Omit<LauncherMenuEntry, "key">): void => {
    entries.push({ key: String(entries.length + 1), ...entry });
  };

  appendEntry({
    label: `Open configured default channel (${CHANNEL_LABELS[context.defaultChannel]})`,
    detail: context.defaultChannel === "web"
      ? `Starts Strada on http://127.0.0.1:${context.webPort}`
      : "Uses the DEFAULT_CHANNEL from your saved setup",
    action: { kind: "start", channelType: context.defaultChannel, daemonMode: false },
  });

  if (context.defaultChannel !== "web") {
    appendEntry({
      label: "Open local web dashboard",
      detail: `Starts local web access on http://127.0.0.1:${context.webPort} (dashboard ${context.dashboardPort})`,
      action: { kind: "start", channelType: "web", daemonMode: false },
    });
  }

  if (context.defaultChannel !== "cli") {
    appendEntry({
      label: "Start interactive CLI chat",
      detail: "Best choice when you want to stay in the terminal",
      action: { kind: "start", channelType: "cli", daemonMode: false },
    });
  }

  appendEntry({
    label: "Run configured default channel in daemon mode",
    detail: "Keeps Strada active with background monitoring and triggers",
    action: { kind: "start", channelType: context.defaultChannel, daemonMode: true },
  });
  appendEntry({
    label: "Open setup / reconfigure",
    detail: "Launch the setup chooser again",
    action: { kind: "setup" },
  });
  appendEntry({
    label: "Run doctor",
    detail: "Verify build artifacts, config validity, and embedding readiness",
    action: { kind: "doctor" },
  });
  appendEntry({
    label: "Exit",
    action: { kind: "exit" },
  });

  return entries;
}

export async function promptLauncherAction(
  context: LauncherMenuContext,
): Promise<LauncherAction> {
  const entries = buildLauncherMenu(context);
  const entryMap = new Map(entries.map((entry) => [entry.key, entry]));
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log("\nStrada Launcher");
    console.log("===============");
    console.log(`Default channel: ${CHANNEL_LABELS[context.defaultChannel]}`);
    console.log("Choose how you want to open Strada on this machine:\n");

    for (const entry of entries) {
      console.log(`${entry.key}) ${entry.label}`);
      if (entry.detail) {
        console.log(`   ${entry.detail}`);
      }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await rl.question(`\nChoose [1-${entries.length}] (default: 1): `)).trim();
      const selectedKey = answer || "1";
      const selected = entryMap.get(selectedKey);
      if (selected) {
        console.log("");
        return selected.action;
      }
      console.log("Please choose one of the listed options.");
    }

    throw new Error("Maximum launcher retries exceeded.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") {
      console.log("");
      return { kind: "exit" };
    }
    throw error;
  } finally {
    rl.close();
  }
}
