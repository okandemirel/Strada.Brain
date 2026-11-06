/**
 * The workspace lease manager a bootstrap stage builds: the background
 * executor's (stage-runtime.ts) and the delegation manager's (stage-agents.ts).
 * Both read the same two settings from the environment:
 *
 * - WORKSPACE_COPY_EXCLUDES: comma-separated directory names a temp-copy lease
 *   leaves out. Unset, DEFAULT_WORKSPACE_COPY_EXCLUDES.
 * - WORKSPACE_LEASE_ROOT: the absolute directory leases are made in. Unset,
 *   the manager's default under os.tmpdir(), which every Strada.Brain on the
 *   machine shares. Under vitest the manager refuses that default, because a
 *   test once salvaged a live daemon's running lease. A test that boots the
 *   real bootstrap (the golden runs) sets this to a folder of its own. Before
 *   this setting existed it could not, and the executor ran with no lease.
 *
 * Throws what the manager throws, and on a relative WORKSPACE_LEASE_ROOT,
 * which would resolve against whatever directory the process started in. The
 * caller logs the error and runs without isolation.
 */

import { isAbsolute } from "node:path";
import { WorkspaceLeaseManager, DEFAULT_WORKSPACE_COPY_EXCLUDES } from "../../agents/multi/workspace-lease-manager.js";

export function createWorkspaceLeaseManager(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceLeaseManager {
  const envExcludes = env["WORKSPACE_COPY_EXCLUDES"];
  const additionalExcludes = envExcludes
    ? envExcludes.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_WORKSPACE_COPY_EXCLUDES];
  const leaseRoot = env["WORKSPACE_LEASE_ROOT"]?.trim() || undefined;
  if (leaseRoot !== undefined && !isAbsolute(leaseRoot)) {
    throw new Error(`WORKSPACE_LEASE_ROOT must be an absolute path, got "${leaseRoot}"`);
  }
  return new WorkspaceLeaseManager({ projectRoot, additionalExcludes, ...(leaseRoot ? { leaseRoot } : {}) });
}
