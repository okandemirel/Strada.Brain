/* eslint-disable no-console -- launcher is a user-facing terminal entrypoint */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CHANNEL_DEFAULTS, type SupportedChannelType } from "../common/constants.js";
import { describeChannelSpec, formatChannelSpec, isValidChannelSpec, parseChannelSpec } from "../channels/channel-spec.js";

/** A channel type, or several joined by commas: "web,telegram". */
export type ChannelSpec = string;

export interface RootLaunchOptions {
  readonly daemon?: boolean;
  readonly web?: boolean;
  readonly terminal?: boolean;
  readonly cli?: boolean;
  readonly telegram?: boolean;
  readonly discord?: boolean;
  readonly slack?: boolean;
  readonly teams?: boolean;
}

export interface LauncherMenuContext {
  readonly defaultChannel: ChannelSpec;
  readonly webPort: number;
  readonly dashboardPort: number;
}

export type LauncherAction =
  | { readonly kind: "start"; readonly channelType: ChannelSpec; readonly daemonMode: boolean }
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
  { option: "terminal", channelType: "cli" },
  { option: "cli", channelType: "cli" },
  { option: "telegram", channelType: "telegram" },
  { option: "discord", channelType: "discord" },
  { option: "slack", channelType: "slack" },
  { option: "teams", channelType: "teams" },
];

export function getConfiguredDefaultChannel(
  env: NodeJS.ProcessEnv = process.env,
): ChannelSpec {
  const raw = env["DEFAULT_CHANNEL"]?.trim().toLowerCase();
  if (!raw) {
    return CHANNEL_DEFAULTS.DEFAULT_TYPE;
  }

  // "web,telegram" is a valid default: both channels boot behind one hub.
  if (isValidChannelSpec(raw)) {
    return formatChannelSpec(parseChannelSpec(raw));
  }

  return CHANNEL_DEFAULTS.DEFAULT_TYPE;
}

export function resolveQuickLaunchAction(
  options: RootLaunchOptions,
): LauncherAction | null {
  const selectedChannels = QUICK_LAUNCH_FLAGS
    .filter(({ option }) => options[option])
    .map(({ channelType }) => channelType);

  // Several flags at once ("--web --telegram") start every named channel
  // behind one hub, in the order given.
  if (selectedChannels.length >= 1) {
    return {
      kind: "start",
      channelType: formatChannelSpec([...new Set(selectedChannels)]),
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

  const defaultMembers = parseChannelSpec(context.defaultChannel);
  appendEntry({
    label: `Open configured default channel (${describeChannelSpec(context.defaultChannel)})`,
    detail: defaultMembers.includes("web")
      ? `Starts Strada on http://127.0.0.1:${context.webPort}`
      : "Uses the DEFAULT_CHANNEL from your saved setup",
    action: { kind: "start", channelType: context.defaultChannel, daemonMode: false },
  });

  if (!defaultMembers.includes("web")) {
    appendEntry({
      label: "Open local web dashboard",
      detail: `Starts local web access on http://127.0.0.1:${context.webPort} (dashboard ${context.dashboardPort})`,
      action: { kind: "start", channelType: "web", daemonMode: false },
    });
  }

  if (!defaultMembers.includes("cli")) {
    appendEntry({
      label: "Start interactive CLI chat",
      detail: "Best choice when you want to stay in the terminal",
      action: { kind: "start", channelType: "cli", daemonMode: false },
    });
  }

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
    console.log(`Default channel: ${describeChannelSpec(context.defaultChannel)}`);
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
