#!/usr/bin/env node
/**
 * prepublishOnly guard: refuse `npm publish` when package.json carries
 * `overrides` that the published package would silently drop.
 *
 * npm applies `overrides` only to the root project of an install. Installed
 * from a source checkout (the supported flow today) they hold; installed as a
 * published package (`npm install -g strada-brain`), the consumer's tree is
 * resolved without them, so the uuid pins for the botbuilder chain and the
 * esbuild/undici/protobufjs/sharp floors would all be lost with no error. An
 * `npm-shrinkwrap.json` is the one lockfile a published package carries into
 * its consumers' installs, so a publish needs one that matches this release.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decide whether a publish may go ahead.
 *
 * @param {{ packageJson: { name?: string; version?: string; overrides?: Record<string, unknown> };
 *           shrinkwrap: { name?: string; version?: string } | null }} input
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function checkPublishLock({ packageJson, shrinkwrap }) {
  const overrides = Object.keys(packageJson.overrides ?? {});
  if (overrides.length === 0) return { ok: true };

  if (shrinkwrap === null) {
    return {
      ok: false,
      message:
        `package.json has overrides (${overrides.join(", ")}) that npm does not apply to a published package's ` +
        "dependencies. Run `npm shrinkwrap` (it turns the overrides-resolved package-lock.json into " +
        "npm-shrinkwrap.json, which ships with the package) and publish again.",
    };
  }

  if (shrinkwrap.name !== packageJson.name || shrinkwrap.version !== packageJson.version) {
    return {
      ok: false,
      message:
        `npm-shrinkwrap.json is for ${String(shrinkwrap.name)}@${String(shrinkwrap.version)}, not ` +
        `${String(packageJson.name)}@${String(packageJson.version)}: it is stale. Regenerate it with ` +
        "`npm shrinkwrap` and publish again.",
    };
  }

  return { ok: true };
}

/* c8 ignore start — CLI wiring; the decision is unit-tested */
const invokedDirectly =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const verdict = checkPublishLock({
    packageJson: readJson("package.json"),
    shrinkwrap: existsSync(path.join(root, "npm-shrinkwrap.json")) ? readJson("npm-shrinkwrap.json") : null,
  });
  if (!verdict.ok) {
    console.error(`check-publish-lock: ${verdict.message}`);
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
