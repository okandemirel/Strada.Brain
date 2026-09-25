import { describe, it, expect } from "vitest";
import path from "node:path";
import { normalizeToolPathInput } from "./path-guard.js";

describe("normalizeToolPathInput is separator-agnostic (SEC-17 / TLS-15)", () => {
  it("maps an absolute in-project Windows path to a project-relative one, in any case", () => {
    const root = "C:\\proj";
    expect(normalizeToolPathInput(root, "C:\\proj\\Game.csproj", path.win32)).toEqual({ ok: true, relativePath: "Game.csproj" });
    expect(normalizeToolPathInput(root, "c:\\Proj\\src\\Game.csproj", path.win32)).toEqual({ ok: true, relativePath: "src\\Game.csproj" });
    expect(normalizeToolPathInput(root, "C:/proj/src/Game.csproj", path.win32)).toEqual({ ok: true, relativePath: "src\\Game.csproj" });
    expect(normalizeToolPathInput(`${root}\\`, "C:\\proj", path.win32)).toEqual({ ok: true, relativePath: "." });
  });

  it("still refuses an absolute path outside the project, including a sibling sharing its prefix", () => {
    for (const outside of ["C:\\proj-evil\\x.csproj", "D:\\proj\\x.csproj", "C:\\x.csproj"]) {
      expect(normalizeToolPathInput("C:\\proj", outside, path.win32).ok, outside).toBe(false);
    }
    for (const outside of ["/proj-evil/x.csproj", "/x.csproj"]) {
      expect(normalizeToolPathInput("/proj", outside, path.posix).ok, outside).toBe(false);
    }
  });

  it("keeps the POSIX behaviour", () => {
    expect(normalizeToolPathInput("/proj", "/proj/src/Game.csproj", path.posix)).toEqual({ ok: true, relativePath: "src/Game.csproj" });
    expect(normalizeToolPathInput("/proj/", "/proj", path.posix)).toEqual({ ok: true, relativePath: "." });
    expect(normalizeToolPathInput("/proj", "./src//Game.csproj", path.posix)).toEqual({ ok: true, relativePath: "src/Game.csproj" });
    // A relative path is left for validatePath to confine.
    expect(normalizeToolPathInput("/proj", "../x", path.posix)).toEqual({ ok: true, relativePath: "../x" });
  });
});
