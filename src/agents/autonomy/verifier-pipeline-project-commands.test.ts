import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { measureProjectCommands, RECOGNISED_MANIFESTS } from "./verifier-pipeline-project-commands.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project root holding these files (relative path → content). */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "strada-project-commands-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const pkg = (scripts?: Record<string, string>): string => JSON.stringify({ name: "p", version: "1.0.0", scripts });
const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

describe("measureProjectCommands", () => {
  it("a package.json test script is a command", () => {
    const record = measureProjectCommands(project({ "package.json": pkg({ test: "vitest run" }), "src/a.ts": "" }));
    expect(record.verdict).toBe("commands");
    expect(record.manifests).toEqual(["package.json: scripts.test"]);
    expect(record.rootSource).toBe("the project's source root, not a workspace lease");
  });

  it("a build script is a command, and so is a namespaced test script", () => {
    expect(measureProjectCommands(project({ "package.json": pkg({ build: "tsc" }) })).manifests)
      .toEqual(["package.json: scripts.build"]);
    expect(measureProjectCommands(project({ "package.json": pkg({ "test:unit": "node --test" }) })).verdict)
      .toBe("commands");
  });

  it("npm's placeholder test script is not a test", () => {
    const record = measureProjectCommands(project({
      "package.json": pkg({ test: NPM_PLACEHOLDER, start: "node index.js" }),
      "index.js": "console.log(1)\n",
    }));
    expect(record.verdict).toBe("none");
    expect(record.manifests).toEqual(["package.json: no build or test script (scripts.test is npm's placeholder)"]);
  });

  it("a package.json with no scripts declares nothing", () => {
    expect(measureProjectCommands(project({ "package.json": pkg(), "index.js": "" })).verdict).toBe("none");
  });

  it("a project of notes and no manifest has no command (golden run 4's project)", () => {
    const record = measureProjectCommands(project({ "README.md": "# notes\n", "notes/a.txt": "A\n" }));
    expect(record).toMatchObject({ verdict: "none", manifests: [] });
  });

  it("an unreadable or missing root is unknown, never none", () => {
    expect(measureProjectCommands(undefined).verdict).toBe("unknown");
    expect(measureProjectCommands(join(tmpdir(), "strada-no-such-project-root")).verdict).toBe("unknown");
  });

  it("a package.json that does not parse is unknown", () => {
    expect(measureProjectCommands(project({ "package.json": "{ not json" })).verdict).toBe("unknown");
  });

  it("source code of a project type with no manifest is unknown: the gate does not relax on what it cannot read", () => {
    expect(measureProjectCommands(project({ "src/main.rs": "fn main() {}\n" }))).toMatchObject({
      verdict: "unknown",
      reason: "src/main.rs is source code of a project type with no manifest read here",
    });
    expect(measureProjectCommands(project({ "app/index.ts": "" })).verdict).toBe("unknown");
    expect(measureProjectCommands(project({ "tool.py": "" })).verdict).toBe("unknown");
  });

  it("code is found below the root, at any depth", () => {
    expect(measureProjectCommands(project({ "a/b/c/d/e/f/main.c": "int main(){}\n" })).verdict).toBe("unknown");
  });

  it("dependencies are not walked", () => {
    const record = measureProjectCommands(project({
      "package.json": pkg({ test: NPM_PLACEHOLDER }),
      "node_modules/dep/lib.rs": "",
      "node_modules/dep/test_x.py": "",
    }));
    expect(record.verdict).toBe("none");
  });

  it("Python: a test file or a pytest configuration is a command; a manifest without either is not", () => {
    expect(measureProjectCommands(project({ "pyproject.toml": "[project]\nname='p'\n", "tests/test_a.py": "" })))
      .toMatchObject({ verdict: "commands", manifests: ["pyproject.toml: no test configuration", "tests/test_a.py: a pytest test file"] });
    expect(measureProjectCommands(project({ "pyproject.toml": "[tool.pytest.ini_options]\n", "p/a.py": "" })).verdict)
      .toBe("commands");
    expect(measureProjectCommands(project({ "setup.cfg": "[tool:pytest]\n" })).verdict).toBe("commands");
    expect(measureProjectCommands(project({ "pyproject.toml": "[project]\nname='p'\n", "p/a.py": "" })).verdict)
      .toBe("none");
  });

  it("build systems carry their own commands", () => {
    for (const file of ["Cargo.toml", "go.mod", "Makefile", "pom.xml", "CMakeLists.txt", "tsconfig.json"]) {
      expect(measureProjectCommands(project({ [file]: "" })), file).toMatchObject({
        verdict: "commands",
        manifests: [`${file}: build system`],
      });
    }
    expect(measureProjectCommands(project({ "App.csproj": "<Project/>" })).manifests).toEqual(["*.sln/*.csproj: dotnet build"]);
    expect(measureProjectCommands(project({ "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n" })).verdict)
      .toBe("commands");
  });

  it("names the manifests it recognises", () => {
    expect(RECOGNISED_MANIFESTS).toEqual(expect.arrayContaining([
      "package.json", "pyproject.toml", "Makefile", "*.csproj", "*.sln", "Cargo.toml", "go.mod",
    ]));
  });
});
