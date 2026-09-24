/**
 * How a portal "verify" check runs `npm run build|test` (CHN-9).
 *
 * Two defects in the original inline spawn:
 *   - `spawn("npm", …, { shell: false })` can never work on Windows: npm is
 *     `npm.cmd` there, and Node 22+ refuses to spawn a `.cmd` without a shell
 *     (CVE-2024-27980), so every check answered "spawn error";
 *   - it ran in `process.cwd()`, the daemon's launch directory, not the
 *     configured project — so it ran whatever project the daemon happened to be
 *     started from (often Strada.Brain's own scripts), never the user's.
 */

import { getCachedConfig } from "../config/config.js";

export type NpmCheckType = "build" | "test";

export interface NpmCheckInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

/**
 * The spawn arguments for `npm run <checkType>` on `platform`.
 *
 * On Windows the whole command is one fixed literal handed to the shell — the
 * check type is one of two constants, never request input — so the shell is
 * given nothing to interpret, and no argument array is concatenated into it.
 */
export function npmCheckInvocation(
  checkType: NpmCheckType,
  platform: NodeJS.Platform = process.platform,
): NpmCheckInvocation {
  const script = checkType === "build" ? "build" : "test";
  return platform === "win32"
    ? { command: `npm.cmd run ${script}`, args: [], shell: true }
    : { command: "npm", args: ["run", script], shell: false };
}

/**
 * The directory a verify check runs in: the configured project. The daemon's
 * cwd is used only when no configuration is loaded at all (a bare channel in a
 * test), which is what the check always did before.
 */
export function npmCheckCwd(): string {
  return getCachedConfig()?.unityProjectPath ?? process.cwd();
}
