import * as dotenv from "dotenv";

/**
 * Keys the setup wizard owns whose ABSENCE from the freshly written .env means
 * "back to the default". dotenv's override reload can overwrite a value that
 * the new file names, but it can never delete one it does not — so a value
 * inherited from the pre-setup process (an older .env, the shell) would
 * survive the reload and win over the user's new choice. STRADA_DAEMON_ENABLED
 * is the audited case: a false→true reconfiguration never applied because the
 * old "false" stayed in process.env (audit 10.1 / 10.6 / D25).
 */
export const SETUP_OWNED_ENV_KEYS = ["STRADA_DAEMON_ENABLED"] as const;

/**
 * Reload the .env the wizard just wrote into `env` (process.env by default):
 * drop the stale setup-owned keys first, then let dotenv override the rest.
 *
 * `removedKeys` are the keys the save deleted from the file (a de-selected
 * provider's API key, a switched-off channel's token). Without dropping them
 * the handed-off runtime kept using a credential the person had just removed
 * (COR-14).
 */
export function reloadEnvAfterSetup(options: {
  path: string;
  env?: NodeJS.ProcessEnv;
  removedKeys?: readonly string[];
}): void {
  const env = options.env ?? process.env;
  for (const key of [...SETUP_OWNED_ENV_KEYS, ...(options.removedKeys ?? [])]) {
    delete env[key];
  }
  // dotenv types its target as { [k]: string }; process.env is { [k]: string | undefined }.
  dotenv.config({ path: options.path, override: true, processEnv: env as Record<string, string> });
}
