import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The prepublishOnly guard (scripts/ci/check-publish-lock.mjs): npm drops a
 * published package's `overrides`, so a publish must carry a matching
 * npm-shrinkwrap.json. Loaded through a non-literal specifier, like the other
 * .mjs CI scripts, so the type checker does not resolve the JavaScript file.
 */
interface PackageShape {
  name?: string;
  version?: string;
  overrides?: Record<string, unknown>;
  scripts?: Record<string, string>;
}

interface PublishLockModule {
  checkPublishLock: (input: {
    packageJson: PackageShape;
    shrinkwrap: { name?: string; version?: string } | null;
  }) => { ok: true } | { ok: false; message: string };
}

const modulePath = pathToFileURL(
  path.join(process.cwd(), "scripts", "ci", "check-publish-lock.mjs"),
).href;
const { checkPublishLock } = (await import(modulePath)) as PublishLockModule;

const pkg = (overrides?: Record<string, unknown>): PackageShape => ({
  name: "strada-brain",
  version: "1.2.3",
  ...(overrides ? { overrides } : {}),
});

describe("checkPublishLock", () => {
  it("lets a package without overrides publish with no shrinkwrap", () => {
    expect(checkPublishLock({ packageJson: pkg(), shrinkwrap: null })).toEqual({ ok: true });
    expect(checkPublishLock({ packageJson: pkg({}), shrinkwrap: null })).toEqual({ ok: true });
  });

  it("refuses to publish overrides without an npm-shrinkwrap.json and names them", () => {
    const verdict = checkPublishLock({
      packageJson: pkg({ botbuilder: { uuid: "^11.1.1" }, undici: "^6.27.0" }),
      shrinkwrap: null,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toContain("botbuilder, undici");
      expect(verdict.message).toContain("npm shrinkwrap");
    }
  });

  it("refuses a shrinkwrap written for another version", () => {
    const verdict = checkPublishLock({
      packageJson: pkg({ undici: "^6.27.0" }),
      shrinkwrap: { name: "strada-brain", version: "1.2.2" },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("stale");
  });

  it("accepts a shrinkwrap that matches this release", () => {
    expect(checkPublishLock({
      packageJson: pkg({ undici: "^6.27.0" }),
      shrinkwrap: { name: "strada-brain", version: "1.2.3" },
    })).toEqual({ ok: true });
  });

  it("is wired as this package's prepublishOnly step", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as PackageShape;
    expect(manifest.scripts?.["prepublishOnly"]).toBe("node scripts/ci/check-publish-lock.mjs");
  });
});
