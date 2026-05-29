import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dirHasBuiltAssets, resolveWebStaticDir } from "./web-static-dir.js";

describe("web-static-dir resolution", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "strada-static-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeDir(name: string, opts: { indexHtml?: boolean; assets?: "js" | "css" | "empty" | "none" }): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.indexHtml !== false) {
      fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
    }
    if (opts.assets && opts.assets !== "none") {
      fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
      if (opts.assets === "js") {
        fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
      } else if (opts.assets === "css") {
        fs.writeFileSync(path.join(dir, "assets", "index-abc123.css"), "body{}");
      }
      // "empty" => assets dir exists but holds no js/css
    }
    return dir;
  }

  describe("dirHasBuiltAssets", () => {
    it("returns false for a placeholder dir (index.html only, no assets dir)", () => {
      expect(dirHasBuiltAssets(makeDir("placeholder", {}))).toBe(false);
    });

    it("returns false when assets dir exists but holds no js/css", () => {
      expect(dirHasBuiltAssets(makeDir("empty-assets", { assets: "empty" }))).toBe(false);
    });

    it("returns false when index.html is missing even if assets exist", () => {
      expect(dirHasBuiltAssets(makeDir("no-index", { indexHtml: false, assets: "js" }))).toBe(false);
    });

    it("returns false for a non-existent directory", () => {
      expect(dirHasBuiltAssets(path.join(tmpRoot, "does-not-exist"))).toBe(false);
    });

    it("returns true for a dir with index.html and a built js asset", () => {
      expect(dirHasBuiltAssets(makeDir("built-js", { assets: "js" }))).toBe(true);
    });

    it("returns true for a dir with index.html and a built css asset", () => {
      expect(dirHasBuiltAssets(makeDir("built-css", { assets: "css" }))).toBe(true);
    });
  });

  describe("resolveWebStaticDir", () => {
    it("falls back to a built dir when the packaged dir only has a placeholder index.html (source checkout)", () => {
      // Reproduces the blank-page bug: the packaged (src) dir has no built assets,
      // so the server must serve the dist mirror that the build populates instead.
      const packaged = makeDir("packaged", {});
      const distMirror = makeDir("dist-mirror", { assets: "js" });
      const portalBuild = makeDir("portal", { assets: "js" });

      expect(resolveWebStaticDir([packaged, distMirror, portalBuild])).toBe(distMirror);
    });

    it("prefers the packaged dir when it has built assets so a stale portal build cannot shadow it", () => {
      const packaged = makeDir("packaged", { assets: "js" });
      const distMirror = makeDir("dist-mirror", { assets: "js" });

      expect(resolveWebStaticDir([packaged, distMirror])).toBe(packaged);
    });

    it("returns the first candidate when nothing is built yet (preserves placeholder/404 behavior)", () => {
      const packaged = makeDir("packaged", {});
      const distMirror = makeDir("dist-mirror", {});

      expect(resolveWebStaticDir([packaged, distMirror])).toBe(packaged);
    });
  });
});
