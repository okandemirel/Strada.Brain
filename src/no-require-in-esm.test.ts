/**
 * This package is ESM ("type": "module"): a bare `require(` in source code is
 * a ReferenceError at run time. Inside a try/catch it is a silent false.
 *
 * Measured 2026-09-07: sprite-generate.ts answered "no local model" for a
 * whole campaign, and spec-scope.ts never found the GDD, for exactly this
 * reason — while every test passed, because the test runner shims require.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no bare require() in ESM source", () => {
  it("every src/**/*.ts is free of require( outside comments and createRequire", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(new URL(".", import.meta.url).pathname)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/createRequire|_require\(|\brequire\.(resolve|cache)/.test(line)) return;
        if (/\brequire\(/.test(line)) offenders.push(`${file.replace(/.*\/src\//, "src/")}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
