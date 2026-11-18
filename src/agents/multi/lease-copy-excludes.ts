/**
 * The directory names a lease leaves out: WORKSPACE_COPY_EXCLUDES when set,
 * else DEFAULT_WORKSPACE_COPY_EXCLUDES. One reading for every caller, so the
 * manager that seeds a lease and anything that cleans one agree on the list.
 */
import { DEFAULT_WORKSPACE_COPY_EXCLUDES } from "./workspace-lease-manager.js";

export function workspaceCopyExcludes(env: NodeJS.ProcessEnv = process.env): string[] {
  const envExcludes = env["WORKSPACE_COPY_EXCLUDES"];
  return envExcludes
    ? envExcludes.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_WORKSPACE_COPY_EXCLUDES];
}
