import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * No tracked file carries a live credential.
 *
 * Measured 2026-08-22: .env.bak.191546 and .env.backup-loglevel were tracked
 * and pushed with a real 72-character KIMI_API_KEY in them, across three
 * commits and onto the remote. The ignore rule was ".env" — one exact
 * filename — and a backup copy made while debugging config is never called
 * that. Two `git add -A` commits swept them in, both mine.
 *
 * A wider ignore rule fixes the case that happened. This fails the build on
 * the next one, whatever it is called.
 */

const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["OpenAI-style key", /\bsk-[A-Za-z0-9](?:[A-Za-z0-9_-]{24,})/u],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/u],
];

/** Placeholders and fixtures: a test needs a key-shaped string to test with. */
const ALLOWED = /(?:test|example|placeholder|dummy|fake|sample|xxx|your[_-]?key|<[^>]+>)/iu;

/**
 * Test sources are exempt from the shape scan and only from that.
 *
 * A sanitiser cannot be tested without realistic keys to sanitise, and this
 * repository has several such fixtures. The env rule below covers them anyway:
 * what leaked was a config file, and a config file is what this guards.
 */
const IS_TEST_SOURCE = /(?:\.test\.[cm]?[jt]sx?$|__tests__\/|\/fixtures\/)/u;

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f !== "");
}

describe("nothing tracked carries a credential", () => {
  it("finds no live-looking key in any tracked file", () => {
    // One `git ls-files`, then read with fs and match with the real regex.
    //
    // Two earlier versions of this were useless. Spawning `git show` per file
    // took thirty seconds and timed out under the full suite; handing these
    // JavaScript patterns to `git grep` matched nothing at all, because its
    // engine has no \b and no (?:...) — and the failure was silent, so the
    // check passed while seeing nothing. Both passed a staged, key-bearing
    // file straight through.
    const offenders: string[] = [];

    for (const file of trackedFiles()) {
      if (IS_TEST_SOURCE.test(file)) continue;
      let body: string;
      try {
        body = readFileSync(file, "utf8");
      } catch {
        continue; // binary, deleted, or unreadable in the working tree
      }
      if (body.length > 2_000_000) continue;

      for (const [name, shape] of SECRET_SHAPES) {
        for (const line of body.split("\n")) {
          if (!shape.test(line) || ALLOWED.test(line)) continue;
          offenders.push(`${file}: ${name}`);
          break;
        }
      }
    }

    expect([...new Set(offenders)], `tracked files carry credentials:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("tracks no env file except the example", () => {
    // The rule that actually failed. .gitignore matched ".env" exactly, so
    // .env.bak.191546 and .env.backup-loglevel were tracked and pushed with a
    // live key. Names of backups are unpredictable; the count is not.
    const envFiles = trackedFiles().filter((f) => /(?:^|\/)\.env(?:$|\.)/u.test(f));

    expect(envFiles, `tracked env files: ${envFiles.join(", ")}`).toEqual([".env.example"]);
  });

  it("would have caught the backups that leaked", () => {
    // The shape has to match the key that actually escaped, or this test is
    // decoration. 72 characters, sk-kimi- prefix, hyphen inside the body.
    const leaked = `KIMI_API_KEY="sk-kimi-${"a1B2c3D4e5".repeat(5)}"`;

    expect(SECRET_SHAPES.some(([, shape]) => shape.test(leaked))).toBe(true);
    expect(ALLOWED.test(leaked)).toBe(false);
  });

  it("does not fail on a fixture that needs a key-shaped string", () => {
    const fixture = "providerKeys={{ kimi: 'sk-kimi-test' }}";

    expect(ALLOWED.test(fixture)).toBe(true);
  });
});
