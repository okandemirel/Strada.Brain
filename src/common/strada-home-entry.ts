import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStradaHome } from "./runtime-paths.js";
import { getLogger } from "../utils/logger.js";

/**
 * `<app home>/<segments>`: where the runtime keeps per-user state — installed
 * skills and their trust records, skills.json, the Unity link, downloaded
 * models, clone caches.
 *
 * Until 2026-10-11 a dozen modules built `homedir()/.strada/...` themselves,
 * so STRADA_HOME never reached them: every test run wrote the developer's own
 * home, and a deployment with its own home shared the user's files. Where the
 * app home is somewhere else (STRADA_HOME, or the Windows default), an entry
 * that exists only at the old place is still used THERE: an upgrade must not
 * drop installed skills, approvals or the Unity link, nor quietly re-enable a
 * skill the user disabled (SEC-15). A notice names both paths, once, so the
 * operator can move it; nothing is moved for them.
 */
export function resolveStradaHomeEntry(...segments: string[]): string {
  // homedir() is passed, not left to resolveStradaHome's default: a test that
  // mocks node:os with only `homedir` has no default export to read it from.
  const home = homedir();
  const target = join(resolveStradaHome(process.env, home), ...segments);
  const legacy = join(home, ".strada", ...segments);
  if (legacy === target || present(target) || !present(legacy)) return target;
  noticeLegacy(legacy, target);
  return legacy;
}

/**
 * Whether something is at `path`. Only "not there" counts as absent: an
 * entry that cannot be inspected is reported present, so the caller's own
 * read of it fails (and fails closed) instead of falling through to a fresh,
 * empty location.
 */
function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

const noticed = new Set<string>();

function noticeLegacy(legacy: string, target: string): void {
  if (noticed.has(legacy)) return;
  noticed.add(legacy);
  const message =
    `Using ${legacy}, left from before Strada kept this under its app home; ` +
    `move it to ${target} to keep it with the rest of this installation's state.`;
  // A CLI command runs without the runtime's logger; the operator still has to see this.
  try {
    getLogger().warn(message, { legacy, target });
  } catch {
    // eslint-disable-next-line no-console -- see above: no logger exists yet
    console.warn(message);
  }
}
