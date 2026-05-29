/**
 * Shared resolution for the directory that holds the built web portal.
 *
 * Both the setup wizard and the web channel serve their UI from a `static/`
 * directory that sits next to their compiled module. In a published package that
 * resolves to `dist/channels/web/static`, which ships the built portal. In a
 * source checkout it resolves to `src/channels/web/static`, which only holds a
 * placeholder `index.html` — the built `assets/` are git-ignored there and the
 * build only populates the dist mirror.
 *
 * Callers therefore pass the packaged dir first (so a stale `web-portal/dist`
 * can never shadow a valid packaged build) followed by build-output fallbacks,
 * and {@link resolveWebStaticDir} serves the first directory that actually
 * contains a built portal. This keeps the UI usable no matter where or how
 * Strada is installed, and lives in one place so the two servers cannot drift.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** True when `dir` contains a built portal (index.html + assets/*.js|*.css). */
export function dirHasBuiltAssets(dir: string): boolean {
  try {
    if (!existsSync(join(dir, "index.html")) || !existsSync(join(dir, "assets"))) {
      return false;
    }
    return readdirSync(join(dir, "assets")).some(
      (entry) => entry.endsWith(".js") || entry.endsWith(".css"),
    );
  } catch {
    return false;
  }
}

/**
 * Returns the first candidate that actually contains a built portal. When none
 * are built yet the first candidate is returned so the previous placeholder/404
 * behavior is preserved instead of throwing.
 */
export function resolveWebStaticDir(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (dirHasBuiltAssets(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? "";
}
