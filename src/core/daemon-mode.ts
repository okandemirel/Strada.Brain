/**
 * Daemon mode resolution for interactive startup commands.
 *
 * Daemon autonomy (heartbeat, triggers, Agent Core OODA, memory
 * consolidation, deployment stage) is DEFAULT-ON: it is the product, not a
 * mode. The old rule — CLI only with an explicit `--daemon` — meant every
 * CLI deployment silently ran without the subsystems the README promises
 * (audited 2026-08-30: zero OODA/trigger/consolidation initializations in
 * 39k log lines because campaigns run through the CLI channel).
 *
 * Opt OUT with STRADA_DAEMON_ENABLED=false; an explicit `--daemon` flag
 * still forces it on regardless of environment.
 */
export function shouldEnableDaemonMode(
  _channelType: string,
  daemonFlag: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (daemonFlag) {
    return true;
  }
  return env["STRADA_DAEMON_ENABLED"] !== "false";
}
