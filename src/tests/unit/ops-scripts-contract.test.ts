/**
 * Ops scripts under scripts/ must be runnable as shipped (OPS-21, OPS-22).
 *
 * - scripts/backup-scheduler.js used CommonJS `require()` in a `"type":
 *   "module"` package, so `node scripts/backup-scheduler.js` died with a
 *   ReferenceError on its first line. Nothing referenced it; it was removed.
 * - scripts/setup-alerts.sh rewrote .env with unanchored `sed s|KEY=.*|…|`
 *   edits: they also match commented and prefixed lines, and its Telegram
 *   branch replaced the CHANNEL's bot token with an alert bot's. It configured
 *   an alerting system the application does not have; it was removed.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptsDir = path.join(repoRoot, "scripts");

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...filesUnder(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe("scripts/", () => {
  it("contains no CommonJS require() in ES-module scripts (the package is type: module)", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { type?: string };
    expect(pkg.type).toBe("module");
    const offenders = filesUnder(scriptsDir, [".js", ".mjs"]).filter((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .some((line) => !/^\s*(\/\/|\*)/.test(line) && /(^|[^.\w])require\(/.test(line)),
    );
    expect(offenders.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });

  it("never rewrites a .env key with an unanchored sed substitution", () => {
    // `s|KEY=.*|…|` also rewrites `# KEY=` and `OTHER_KEY=` lines; `^KEY=` does not.
    const offenders: string[] = [];
    for (const file of filesUnder(scriptsDir, [".sh"])) {
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (/\bsed\b[^\n]*["']s(.)(?!\^)[A-Z][A-Z0-9_]*=/.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
