/**
 * Daemon mode resolution for interactive startup commands.
 *
 * CLI sessions are treated as an operator-facing surface: they should only
 * start daemon autonomy when the caller explicitly passes `--daemon`.
 * Non-CLI channels may still opt into daemon mode through environment config.
 */
export function shouldEnableDaemonMode(
  channelType: string,
  daemonFlag: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (daemonFlag) {
    return true;
  }

  if (env["STRADA_DAEMON_ENABLED"] !== "true") {
    return false;
  }

  return channelType !== "cli";
}
