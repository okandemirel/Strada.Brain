/**
 * Detector for docs/contracts/fix-needs-a-red-test.md, rule fix-has-a-red-test.
 *
 * The rule's gate is scripts/ci/check-fix-guarded.mjs, which scripts/ci/gates.mjs
 * runs over the branch: every fix commit's source files are put back one at a
 * time, as the parent had them, in a temporary worktree, and the test files the
 * commit touched run each time. This file pins that script's decision on a
 * fixture repository with real git and a real child vitest: a fix whose test
 * turns red passes, a test that does not depend on the fix (board task #38's
 * shape) is named, a two-file fix whose test covers one file (#56's shape)
 * names the other, a fix with no test is named, and the exemptions hold.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO, "scripts/ci/check-fix-guarded.mjs");
/** Each case below runs a child vitest per reverted file; a loaded machine makes that slow. */
const CHILD_RUNS_TIMEOUT_MS = 300_000;

interface Change {
  status: string;
  path: string;
  oldPath: string;
  codeChanged?: boolean;
}
interface Verdict {
  judged: boolean;
  why?: string;
  findings: string[];
}
interface Guard {
  FIX_SUBJECT: RegExp;
  UNGUARDED_TRAILER: RegExp;
  classifyPath(file: string): string;
  childEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
  emittedCode(text: string | null, file: string): Promise<string>;
  planFixCommit(commit: { subject: string; message: string; changes: Change[] }): {
    judged: boolean;
    why?: string;
    finding?: string;
    tests?: string[];
  };
  judgeFixCommit(options: { repo: string; sha: string; nodeModules: string }): Promise<Verdict>;
}
const guard = (await import(pathToFileURL(SCRIPT).href)) as Guard;

/** git with no inherited GIT_* (a hook's GIT_DIR would aim it at this repository) and a fixed identity. */
function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let fixture = "";
function commit(files: Record<string, string | null>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    const full = join(fixture, file);
    if (text === null) rmSync(full);
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  git(fixture, ["add", "-A", "--", "."]);
  git(fixture, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(fixture, ["rev-parse", "HEAD"]);
}

const judge = (sha: string) => guard.judgeFixCommit({ repo: fixture, sha, nodeModules: join(REPO, "node_modules") });
const testOf = (body: string) => `import { expect, it } from "vitest";\n${body}\n`;

const shas: Record<string, string> = {};

beforeAll(() => {
  fixture = realpathSync.native(mkdtempSync(join(tmpdir(), "fix-guarded-fixture-")));
  git(fixture, ["init", "-q", "-b", "main"]);
  writeFileSync(join(fixture, ".gitignore"), "node_modules\n");
  symlinkSync(join(REPO, "node_modules"), join(fixture, "node_modules"), "junction");
  commit(
    {
      "package.json": `{ "type": "module" }\n`,
      "src/add.ts": "export const add = (a: number, b: number): number => a - b;\n",
      "src/shout.ts": "export const shout = (s: string): string => s;\n",
      "src/left.ts": "export const left = (s: string): string => s;\n",
      "src/right.ts": "export const right = (s: string): string => s;\n",
      "src/broken.ts": "export const half = (n: number): number => n;\n",
    },
    "chore: the buggy start",
  );
  shas.guarded = commit(
    {
      "src/add.ts": "export const add = (a: number, b: number): number => a + b;\n",
      "src/add.test.ts": testOf(`import { add } from "./add.js";\nit("adds", () => { expect(add(2, 3)).toBe(5); });`),
    },
    "fix(add): add adds",
  );
  // #38: the test the fix came with passes on the old code as well.
  shas.testNotOnFix = commit(
    {
      "src/shout.ts": "export const shout = (s: string): string => s.toUpperCase();\n",
      "src/shout.test.ts": testOf(`import { shout } from "./shout.js";\nit("exists", () => { expect(typeof shout).toBe("function"); });`),
    },
    "fix(shout): shout upper-cases",
  );
  // #56: two files fixed, one tested.
  shas.oneOfTwo = commit(
    {
      "src/left.ts": "export const left = (s: string): string => `<${s}`;\n",
      "src/right.ts": "export const right = (s: string): string => `${s}>`;\n",
      "src/left.test.ts": testOf(`import { left } from "./left.js";\nit("marks the left", () => { expect(left("a")).toBe("<a"); });`),
    },
    "fix(sides): both sides are marked",
  );
  shas.noTest = commit({ "src/add.ts": "export const add = (a: number, b: number): number => b + a;\n" }, "fix: add is symmetric");
  shas.redWithFix = commit(
    {
      "src/broken.ts": "export const half = (n: number): number => n / 3;\n",
      "src/broken.test.ts": testOf(`import { half } from "./broken.js";\nit("halves", () => { expect(half(4)).toBe(2); });`),
    },
    "fix(broken): half halves",
  );
  shas.typeOnly = commit(
    { "src/add.ts": "/** Sum. */\nexport const add = (a: number, b: number): number => b + a;\nexport type Sum = number;\n" },
    "fix(types): add names its result",
  );
  shas.docsOnly = commit({ "docs/notes.md": "# notes\n" }, "fix(docs): the notes say what add does");
  shas.configOnly = commit({ "settings.json": "{}\n" }, "fix(config): settings exist");
  shas.testOnly = commit(
    { "src/add.test.ts": testOf(`import { add } from "./add.js";\nit("adds", () => { expect(add(2, 3)).toBe(5); });\nit("adds zero", () => { expect(add(2, 0)).toBe(2); });`) },
    "fix(test): add has a zero case",
  );
  shas.saidWhy = commit(
    { "src/shout.ts": "export const shout = (s: string): string => s.toLocaleUpperCase();\n" },
    "fix(shout): locale-aware\n\nFix-Unguarded: the test machine runs one locale, where both spellings give the same text.\n",
  );
  shas.saidAWord = commit(
    { "src/shout.ts": "export const shout = (s: string): string => s.toUpperCase();\n" },
    "fix(shout): back to plain\n\nFix-Unguarded: ok\n",
  );
  shas.notFix = commit({ "src/add.ts": "export const add = (a: number, b: number): number => a + b;\n" }, "feat(add): add is plain again");
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe("a fix commit carries a test that turns red when the fix is undone (docs/contracts/fix-needs-a-red-test.md)", () => {
  it("reads every conventional spelling of a fix subject, and nothing else", () => {
    for (const subject of ["fix: a", "fix(scope): a", "fix(a, b): a", "fix!: a", "fix(x)!: a", "Fix(x): a", "FIX: a", "fix (x): a", "fix(x) : a", " fix: a"]) {
      expect(guard.FIX_SUBJECT.test(subject), subject).toBe(true);
    }
    for (const subject of ["fixup! fix(x): a", "Fix the setup wizard", "feat(fix): a", "fix(x) a", "Revert \"fix(x): a\"", "fixes: a", "hotfix: a", "chore: bump version"]) {
      expect(guard.FIX_SUBJECT.test(subject), subject).toBe(false);
    }
  });

  it("sorts paths into tests, source, docs and config, and leaves the web portal to its own runner", () => {
    expect(
      Object.fromEntries(
        [
          "src/a.test.ts",
          "web-portal/src/a.test.tsx",
          "src/a.ts",
          "scripts/ci/gates.mjs",
          "scripts/backup.sh",
          "docs/a.md",
          "README.md",
          "package.json",
          "docs/architecture/repo_map.yaml",
          "vitest.config.ts",
          ".gitignore",
          ".github/workflows/ci.yml",
          "web-portal/src/App.tsx",
          "assets/logo.png",
        ].map((p) => [p, guard.classifyPath(p)]),
      ),
    ).toEqual({
      "src/a.test.ts": "test",
      "web-portal/src/a.test.tsx": "test",
      "src/a.ts": "source",
      "scripts/ci/gates.mjs": "source",
      "scripts/backup.sh": "source",
      "docs/a.md": "doc",
      "README.md": "doc",
      "package.json": "config",
      "docs/architecture/repo_map.yaml": "doc",
      "vitest.config.ts": "config",
      ".gitignore": "config",
      ".github/workflows/ci.yml": "config",
      "web-portal/src/App.tsx": "other",
      "assets/logo.png": "other",
    });
  });

  it("asks a fix whose only test is the web portal's for a test vitest runs, and counts a deleted test as no test", () => {
    const plan = (changes: Change[]) => guard.planFixCommit({ subject: "fix: a", message: "fix: a\n", changes });
    const src = { status: "M", path: "src/a.ts", oldPath: "src/a.ts" };
    expect(plan([src, { status: "M", path: "web-portal/src/a.test.tsx", oldPath: "web-portal/src/a.test.tsx" }]).finding).toMatch(
      /touches no test file vitest runs/,
    );
    expect(plan([src, { status: "D", path: "src/a.test.ts", oldPath: "src/a.test.ts" }]).finding).toMatch(/touches no test file/);
    expect(plan([src, { status: "R090", path: "src/b.test.ts", oldPath: "src/a.test.ts" }]).tests).toEqual(["src/b.test.ts"]);
  });

  it("does not revert a deleted source file, whose return alone restores a module nothing imports", () => {
    const test = { status: "M", path: "src/a.test.ts", oldPath: "src/a.test.ts" };
    const gone = { status: "D", path: "src/old-helper.ts", oldPath: "src/old-helper.ts" };
    const kept = { status: "M", path: "src/a.ts", oldPath: "src/a.ts" };
    const both = guard.planFixCommit({ subject: "fix: a", message: "fix: a\n", changes: [test, gone, kept] }) as {
      sources: Array<{ path: string }>;
      skipped: Array<{ path: string; why: string }>;
    };
    expect(both.sources.map((s) => s.path)).toEqual(["src/a.ts"]);
    expect(both.skipped).toEqual([{ path: "src/old-helper.ts", why: "deleted" }]);
    expect(guard.planFixCommit({ subject: "fix: a", message: "fix: a\n", changes: [gone] }).why).toMatch(
      /^exempt: no source file changes its code \(source; src\/old-helper\.ts deleted\)/,
    );
  });

  it("sees through types and comments: the same emitted code is no change a test could see", async () => {
    const a = await guard.emittedCode("import type { T } from './t.js';\nexport const f = (x: number): number => x + 1;\n", "a.ts");
    const b = await guard.emittedCode("// why\nexport interface I { y: string }\nexport const f = (x: number) => x + 1;\n", "a.ts");
    const c = await guard.emittedCode("export const f = (x: number) => x + 2;\n", "a.ts");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await guard.emittedCode("export type Only = string;\n", "t.ts")).toBe(await guard.emittedCode(null, "t.ts"));
  });

  it("hands the child vitest the CPU budget and no git or parent-vitest variables", () => {
    expect(
      guard.childEnv({ VITEST_MAX_WORKERS: "2", VITEST_WORKER_ID: "3", VITEST: "true", GIT_DIR: "/x/.git", PATH: "/bin" }),
    ).toEqual({ VITEST_MAX_WORKERS: "2", PATH: "/bin" });
  });

  it(
    "passes a fix whose test turns red when the fix is put back",
    async () => {
      expect(await judge(shas.guarded!)).toMatchObject({ judged: true, findings: [] });
    },
    CHILD_RUNS_TIMEOUT_MS,
  );

  it(
    "names the file when the commit's test stays green with the fix undone (#38)",
    async () => {
      const verdict = await judge(shas.testNotOnFix!);
      expect(verdict.judged).toBe(true);
      expect(verdict.findings).toEqual([expect.stringMatching(/^src\/shout\.ts: reverting it leaves src\/shout\.test\.ts green/)]);
    },
    CHILD_RUNS_TIMEOUT_MS,
  );

  it(
    "reverts file by file: of two fixed files, names only the one no test depends on (#56)",
    async () => {
      const verdict = await judge(shas.oneOfTwo!);
      expect(verdict.findings).toHaveLength(1);
      expect(verdict.findings[0]).toMatch(/^src\/right\.ts: reverting it leaves src\/left\.test\.ts green/);
    },
    CHILD_RUNS_TIMEOUT_MS,
  );

  it("names a fix that touches no test file", async () => {
    expect((await judge(shas.noTest!)).findings).toEqual([
      "changes src/add.ts and touches no test file vitest runs (src/ or tests/)",
    ]);
  });

  it(
    "names a fix whose own test fails with the fix in place, since no revert can then be judged",
    async () => {
      expect((await judge(shas.redWithFix!)).findings).toEqual([
        expect.stringMatching(/^its tests \(src\/broken\.test\.ts\) fail with the fix in place/),
      ]);
    },
    CHILD_RUNS_TIMEOUT_MS,
  );

  it("exempts by rule a fix that changes no source code: types or comments only, docs only, config only, tests only", async () => {
    for (const name of ["typeOnly", "docsOnly", "configOnly", "testOnly"]) {
      const verdict = await judge(shas[name]!);
      expect(verdict, name).toMatchObject({ judged: false, findings: [] });
      expect(verdict.why, name).toMatch(/^exempt: no source file changes its code/);
    }
  });

  it("exempts a fix that says why in a Fix-Unguarded: sentence, and not one that says a word", async () => {
    expect(await judge(shas.saidWhy!)).toMatchObject({ judged: false, why: expect.stringMatching(/^exempt: Fix-Unguarded: the test machine/) });
    expect((await judge(shas.saidAWord!)).findings).toEqual([expect.stringMatching(/touches no test file/)]);
  });

  it("does not judge a commit that is not a fix", async () => {
    expect(await judge(shas.notFix!)).toMatchObject({ judged: false, why: "not a fix commit" });
  });

  it("fails the command over a range with an unguarded fix, naming it, and passes a range with none", () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const run = (base: string, head: string) =>
      spawnSync(process.execPath, [SCRIPT, "--base", base, "--head", head], { cwd: fixture, env, encoding: "utf8" });
    const red = run(`${shas.noTest}~1`, shas.noTest!);
    expect(red.status).toBe(1);
    expect(red.stderr).toContain("changes src/add.ts and touches no test file");
    expect(red.stderr).toContain("docs/contracts/fix-needs-a-red-test.md");
    const green = run(`${shas.typeOnly}~1`, shas.saidWhy!);
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout).toContain("5 fix commit(s), 0 unguarded");
  });

  it("gates.mjs runs this script over the branch, and a change to the script is governed", async () => {
    const gates = readFileSync(join(REPO, "scripts/ci/gates.mjs"), "utf8");
    expect(gates).toContain('"scripts/ci/check-fix-guarded.mjs", "--base", base');
    const integrity = (await import(pathToFileURL(join(REPO, "scripts/ci/check-test-integrity.mjs")).href)) as {
      governedChanges(paths: string[]): string[];
    };
    expect(integrity.governedChanges(["scripts/ci/check-fix-guarded.mjs"])).toEqual(["scripts/ci/check-fix-guarded.mjs"]);
  });
});
