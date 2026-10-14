/**
 * The system's acceptance files.
 *
 * A milestone is green only when checks the system owns pass. These tests pin
 * what makes those checks the system's and not the worker's: the GDD's numbers
 * are asserted by code, never by the model; a body that cannot fail is refused
 * before it runs; the files on disk are the stored bytes and nothing else; and
 * the test assembly sees the game's runtime code, never its tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACCEPTANCE_ASMDEF_PATH,
  ACCEPTANCE_FIXTURE_PATH,
  ACCEPTANCE_FIXTURE_SOURCE,
  ACCEPTANCE_HARNESS_MEMBERS,
  acceptanceFilePath,
  acceptanceGuid,
  acceptanceIdent,
  checkBodySha,
  detectInputInjection,
  harnessApiDoc,
  harnessFaultOf,
  lintAcceptanceBody,
  materialize,
  planAcceptanceAssembly,
  publicSurfaceDigest,
  removeEphemeral,
  renderAcceptanceAsmdef,
  renderAcceptanceFile,
  restoreAcceptance,
  scanForeignAcceptanceNamespace,
  unrootedNames,
  type AcceptanceHarness,
} from "./acceptance-files.js";
import { ACCEPTANCE_DIR, isAcceptanceTestName, type AcceptanceCheckBody, type AcceptanceSource, type RequirementRow } from "./scope-types.js";
import { requirementTokens } from "./campaign-planner.js";

function row(over: Partial<RequirementRow> = {}): RequirementRow {
  return {
    rid: "req-007-a1b2c3d4e5f6",
    encoded: "The player must reach the exit within 90 seconds.",
    text: "The player must reach the exit within 90 seconds.",
    section: "Core loop",
    line: 12,
    span: { start: 100, end: 150 },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [],
    gddSha256: "f".repeat(64),
    gddRevision: 1,
    ...over,
  };
}

const constantRow = (): RequirementRow =>
  row({
    rid: "req-012-0123456789ab",
    text: "Coyote time is 0.14–0.22 s.",
    kind: "range",
    bounds: { kind: "range", lo: 0.14, hi: 0.22, unit: "s" },
    span: { start: 300, end: 330 },
  });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BASE_MANIFEST = JSON.stringify({ dependencies: { "com.strada.core": "file:Submodules/Strada.Core", "com.unity.test-framework": "1.6.0" } });

/** A Unity project built on Strada.Core, with no game code yet. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "strada-acceptance-"));
  roots.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  mkdirSync(join(root, "ProjectSettings"), { recursive: true });
  put(root, "Packages/manifest.json", BASE_MANIFEST);
  return root;
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function asmdef(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, references: ["Strada.Core"], includePlatforms: [], ...extra }, null, 4);
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** C# bearing the stamp the system puts on what it writes. */
const stampedLike = (body: string): string => `// strada-acceptance ${sha256(body).slice(0, 16)}\n${body}`;

function storedSource(mid: string, tests: Array<{ row: RequirementRow; check: AcceptanceCheckBody }>): AcceptanceSource {
  const rendered = renderAcceptanceFile(mid, tests);
  return {
    milestoneId: mid,
    path: rendered.path,
    sha256: rendered.sha256,
    source: rendered.source,
    writer: { provider: "stub", model: "stub-1", independence: "different-model" },
    revisions: 1,
    tests: rendered.tests,
  };
}

/** NUnit's and Strada.Core's names as a check spells them: from the root. */
const NUNIT = "global::NUnit.Framework";
const OUTCOME = "global::Strada.Core.Play.PlaythroughOutcome";
/** The assertion a tamper test weakens. */
const WON = `${NUNIT}.Is.EqualTo(${OUTCOME}.Won)`;

const goodRuleCheck: AcceptanceCheckBody = {
  rid: "req-007-a1b2c3d4e5f6",
  setup: "yield return StartSessionForSetup(1);",
  body: `yield return Until(() => Driver.Outcome != ${OUTCOME}.None, 95f);\n${NUNIT}.Assert.That(Driver.Outcome, ${WON});`,
};

// =============================================================================
// RENDERING
// =============================================================================

describe("renderAcceptanceFile", () => {
  it("renders the exact file: the system's namespace, class, category, names, attributes and Boot()", () => {
    const rendered = renderAcceptanceFile("m1", [{ row: row(), check: goodRuleCheck }]);
    expect(rendered.path).toBe("Assets/StradaAcceptance/Acceptance_M1.cs");
    // The first line stamps the rest, so a later restore can tell the system's own bytes from an edit.
    const body = rendered.source.slice(rendered.source.indexOf("\n") + 1);
    expect(rendered.source.split("\n")[0]).toBe(`// strada-acceptance ${sha256(body).slice(0, 16)}`);
    expect(body).toBe(
      [
        '// Strada acceptance checks for milestone "m1".',
        "// System-owned: Strada.Brain writes this file from the approved GDD and restores the",
        "// stored bytes before every commit and measurement. Edits are reverted and reported.",
        "// Every type is spelled from the root (global::); the file imports only LINQ's extension methods.",
        "",
        "namespace Strada.Acceptance.M1",
        "{",
        "    using static global::System.Linq.Enumerable;",
        "",
        '    [global::NUnit.Framework.TestFixture, global::NUnit.Framework.Category("StradaAcceptance")]',
        "    public sealed class Acceptance_M1 : global::Strada.Acceptance.AcceptanceFixture",
        "    {",
        "        // REQ req-007-a1b2c3d4e5f6 — The player must reach the exit within 90 seconds.",
        "        [global::UnityEngine.TestTools.UnityTest, global::NUnit.Framework.Timeout(120000)]",
        "        public global::System.Collections.IEnumerator R007_a1b2c3()",
        "        {",
        "            yield return Boot();",
        "            yield return StartSessionForSetup(1);",
        "            yield return Until(() => Driver.Outcome != global::Strada.Core.Play.PlaythroughOutcome.None, 95f);",
        "            global::NUnit.Framework.Assert.That(Driver.Outcome, global::NUnit.Framework.Is.EqualTo(global::Strada.Core.Play.PlaythroughOutcome.Won));",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    expect(rendered.sha256).toBe(sha256(rendered.source));
    expect(rendered.tests).toEqual([
      {
        rid: "req-007-a1b2c3d4e5f6",
        testName: "Strada.Acceptance.M1.Acceptance_M1.R007_a1b2c3",
        bodySha: checkBodySha(goodRuleCheck),
        // WHAT THE CHECK ITSELF NAMED, so the row's framework construct is
        // evidence rather than a claim (north-star rung 4, measured
        // 2026-10-14: no row had ever named one).
        constructs: ["Strada.Core.Play.PlaythroughOutcome.None", "Strada.Core.Play.PlaythroughOutcome.Won"],
      },
    ]);
    expect(isAcceptanceTestName(rendered.tests[0]!.testName)).toBe(true);
  });

  it("asserts a constant or range row against the row's bounds — the model supplies only the observation", () => {
    const check: AcceptanceCheckBody = {
      rid: "req-012-0123456789ab",
      setup: "yield return StartSessionForSetup(1);",
      // The model's own numbers inside its observation must not become the assertion.
      observe: "Service<global::Game.Movement.IJumpRules>().CoyoteSeconds * 1.0",
    };
    const { source } = renderAcceptanceFile("m2", [{ row: constantRow(), check }]);
    expect(source).toContain("            double observed = (double)(Service<global::Game.Movement.IJumpRules>().CoyoteSeconds * 1.0);");
    expect(source).toContain(
      '            global::NUnit.Framework.Assert.That(observed, global::NUnit.Framework.Is.InRange(0.14d, 0.22d), "req-012-0123456789ab: Coyote time is 0.14–0.22 s.");',
    );
    // Exactly one assertion, and it is the system's.
    expect(source.match(/Assert\./g)).toHaveLength(1);
  });

  it("spells every name the system writes from the root, so no type a worker declares and no game namespace can answer for a check", () => {
    // The acceptance assembly references every game runtime assembly. C# looks a bare name up in the enclosing namespaces
    // (Strada.Acceptance.M2, Strada.Acceptance, Strada, the global one) and in every using's namespace: a worker's `Assert`,
    // `Is` or `var` there would judge the row, and a game namespace named like an imported type would stop the file compiling.
    const check: AcceptanceCheckBody = {
      rid: "req-012-0123456789ab",
      // A local named after NUnit's class must not take the system's assertion over either.
      setup: "int Is = 3;",
      observe: "Service<global::Game.Movement.IJumpRules>().CoyoteSeconds",
    };
    const rule: AcceptanceCheckBody = { ...goodRuleCheck, rid: "req-020-feedfacecafe" };
    const { source } = renderAcceptanceFile("m2", [
      { row: constantRow(), check },
      { row: row({ rid: "req-020-feedfacecafe", span: { start: 900, end: 950 } }), check: rule },
    ]);
    // Walked as the compiler reads it: nothing but keywords, the file's own declarations, the harness's members and global::.
    expect(unrootedNames(source, { allowed: ACCEPTANCE_HARNESS_MEMBERS })).toEqual([]);
    // No using brings in a type name: only LINQ's extension methods, which bind here before any a worker declares outside.
    expect(source.split("\n").filter((l) => /^\s*using\b/.test(l))).toEqual(["    using static global::System.Linq.Enumerable;"]);
    // The observation is a `double`, not a `var`: a worker's `class var` cannot type it.
    expect(source).toContain("            double observed = (double)(Service<global::Game.Movement.IJumpRules>().CoyoteSeconds);");
    expect(source).toContain(
      '            global::NUnit.Framework.Assert.That(observed, global::NUnit.Framework.Is.InRange(0.14d, 0.22d), "req-012-0123456789ab: Coyote time is 0.14–0.22 s.");',
    );
    // The walk sees what a bare name would be, wherever it stands.
    const walk = (text: string) => unrootedNames(text, { allowed: ACCEPTANCE_HARNESS_MEMBERS });
    expect(walk(source.replace("global::NUnit.Framework.Assert.That(observed", "Assert.That(observed"))).toEqual(["Assert"]);
    expect(walk(source.replace("double observed", "var observed"))).toEqual(["var"]);
    expect(walk(source.replace("[global::UnityEngine.TestTools.UnityTest,", "[UnityTest,"))).toEqual(["UnityTest"]);
    expect(walk(source.replace(": global::Strada.Acceptance.AcceptanceFixture", ": AcceptanceFixture"))).toEqual(["AcceptanceFixture"]);
  });

  it("closes the observation on its own line when it ends in a comment, so the comment cannot swallow the closing parenthesis", () => {
    const commented: AcceptanceCheckBody = { rid: "req-012-0123456789ab", observe: "Service<global::Game.IJumpRules>().CoyoteSeconds // seconds" };
    expect(lintAcceptanceBody(constantRow(), commented)).toEqual({ ok: true, problems: [] });
    const { source } = renderAcceptanceFile("m2", [{ row: constantRow(), check: commented }]);
    expect(source).toContain("            double observed = (double)(Service<global::Game.IJumpRules>().CoyoteSeconds // seconds\n            );\n");
    // Read as the compiler reads it: with comments gone, the observation still closes before the system's assertion.
    const multi: AcceptanceCheckBody = { ...commented, observe: "Service<global::Game.IJumpRules>()\n    .CoyoteSeconds /* raw */ // seconds" };
    const code = renderAcceptanceFile("m2", [{ row: constantRow(), check: multi }]).source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toMatch(/double observed = \(double\)\(Service<global::Game\.IJumpRules>\(\)\s*\.CoyoteSeconds\s*\);\s*global::NUnit\.Framework\.Assert\.That\(observed,/);
    // Two slashes inside a string are not a comment: the observation stays on one line.
    const quoted: AcceptanceCheckBody = { ...commented, observe: 'Service<global::Game.ILinks>().Count("a//b")' };
    expect(renderAcceptanceFile("m2", [{ row: constantRow(), check: quoted }]).source).toContain('            double observed = (double)(Service<global::Game.ILinks>().Count("a//b"));\n');
  });

  it("writes exact values with the row's tolerance and one-sided or exclusive bounds as NUnit constraints", () => {
    const exact = row({ rid: "req-001-aaaaaaaaaaaa", kind: "constant", text: "Sonar ping interval is 4.5 s.", bounds: { kind: "exact", value: 4.5, tolerance: 0.01 } });
    const atLeast = row({ rid: "req-002-bbbbbbbbbbbb", kind: "range", text: "At least 3 divers in the crew.", bounds: { kind: "range", lo: 3 } });
    const below = row({ rid: "req-003-cccccccccccc", kind: "range", text: "Under 2 s, over 1 s.", bounds: { kind: "range", lo: 1, hi: 2, loExclusive: true, hiExclusive: true } });
    const { source } = renderAcceptanceFile("m3", [
      { row: exact, check: { rid: exact.rid, observe: "Service<global::Game.ISonar>().PingIntervalSeconds" } },
      { row: atLeast, check: { rid: atLeast.rid, observe: "Service<global::Game.ICrew>().Divers" } },
      { row: below, check: { rid: below.rid, observe: "Service<global::Game.ITimer>().Seconds" } },
    ]);
    expect(source).toContain("Is.EqualTo(4.5d).Within(0.01d)");
    expect(source).toContain("Is.GreaterThanOrEqualTo(3d)");
    expect(source).toContain("Is.GreaterThan(1d).And.LessThan(2d)");
  });

  it("keeps a GDD line break, quote or backslash inside the comment and the message string", () => {
    const tricky = row({
      rid: "req-004-dddddddddddd",
      kind: "constant",
      text: 'Speed "max" is 5\\s\nline two Assert.Pass();',
      bounds: { kind: "exact", value: 5, tolerance: 0 },
    });
    const { source } = renderAcceptanceFile("m4", [{ row: tricky, check: { rid: tricky.rid, observe: "Service<global::Game.ISpeed>().Max" } }]);
    // Every line of the verbatim text stays a comment line.
    expect(source).toContain('        // REQ req-004-dddddddddddd — Speed "max" is 5\\s\n        //     line two\n        //     Assert.Pass();');
    expect(source).toContain('"req-004-dddddddddddd: Speed \\"max\\" is 5\\\\s\\nline two\\u2028Assert.Pass();"');
    expect(source.split("\n").filter((l) => /^\s*Assert\.Pass/.test(l))).toEqual([]);
  });

  it("chooses unique names in a file and names the file after the milestone, deterministically", () => {
    const a = row({ rid: "req-010-abcdef000001", span: { start: 10, end: 20 } });
    const b = row({ rid: "req-010-abcdef000002", span: { start: 30, end: 40 } });
    const tests = [
      { row: b, check: { rid: b.rid, body: `${NUNIT}.Assert.That(Driver.IsSessionActive, ${NUNIT}.Is.False);` } },
      { row: a, check: { rid: a.rid, body: `${NUNIT}.Assert.That(Driver.IsSessionActive, ${NUNIT}.Is.False);` } },
    ];
    const first = renderAcceptanceFile("m5-tb1", tests);
    const second = renderAcceptanceFile("m5-tb1", [...tests].reverse());
    expect(first.source).toBe(second.source);
    const names = first.tests.map((t) => t.testName);
    expect(new Set(names).size).toBe(2);
    // GDD order, whatever order the writer answered in.
    expect(first.tests.map((t) => t.rid)).toEqual([a.rid, b.rid]);
    expect(acceptanceIdent("m5-tb1")).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(acceptanceIdent("m5-tb1")).not.toBe(acceptanceIdent("m5_tb1"));
    // Capitalizing is a change of spelling too: "m5" and "M5" are two milestones, two namespaces.
    expect(acceptanceIdent("m5")).toBe("M5");
    expect(acceptanceIdent("M5")).not.toBe(acceptanceIdent("m5"));
    expect(acceptanceFilePath("m5-tb1")).toBe(`${ACCEPTANCE_DIR}/Acceptance_${acceptanceIdent("m5-tb1")}.cs`);
  });

  it("refuses to render what it cannot make honest: a numeric row with no observation, a mismatched id, a duplicate", () => {
    expect(() => renderAcceptanceFile("m1", [{ row: constantRow(), check: { rid: constantRow().rid, body: `${NUNIT}.Assert.That(1, ${NUNIT}.Is.EqualTo(1));` } }])).toThrow(/observe/);
    expect(() => renderAcceptanceFile("m1", [{ row: row(), check: { ...goodRuleCheck, rid: "req-999-000000000000" } }])).toThrow(/rid/);
    expect(() => renderAcceptanceFile("m1", [{ row: row(), check: goodRuleCheck }, { row: row(), check: goodRuleCheck }])).toThrow(/twice/);
  });
});

// =============================================================================
// THE LINT
// =============================================================================

describe("lintAcceptanceBody", () => {
  /** Refused, for the reason given, and not because a name was spelled bare. */
  const refusedOnlyFor = (result: { ok: boolean; problems: string[] }, why: RegExp): void => {
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(why);
    expect(result.problems.filter((p) => /from the root/.test(p))).toEqual([]);
  };
  const lint = (body: string, over: Partial<RequirementRow> = {}, extra: Partial<AcceptanceCheckBody> = {}) =>
    lintAcceptanceBody(row(over), { rid: row(over).rid, body, ...extra });

  it("accepts a body that observes the game and asserts on it", () => {
    expect(lintAcceptanceBody(row(), goodRuleCheck)).toEqual({ ok: true, problems: [] });
  });

  it("rejects a reflection-only guardrail: an assertion on a type's shape alone", () => {
    const result = lint("Assert.That(typeof(IHull).GetProperties().Length, Is.GreaterThan(2));");
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/reflection/);
  });

  it("rejects reflection laundered through a local, a type-name comparison, and a literal-only assertion", () => {
    refusedOnlyFor(lint(`var n = typeof(global::Game.Diving.Hull).GetInterfaces().Length;\n${NUNIT}.Assert.That(n, ${NUNIT}.Is.GreaterThan(0));`), /reflection/);
    refusedOnlyFor(lint(`${NUNIT}.Assert.AreEqual("Mover", Service<global::Game.IMover>().GetType().Name);`), /reflection/);
    refusedOnlyFor(lint(`${NUNIT}.Assert.IsTrue(typeof(global::Game.IMover).IsAssignableFrom(Service<global::Game.IMover>().GetType()));`), /reflection/);
    refusedOnlyFor(lint(`${NUNIT}.Assert.That(2 + 2, ${NUNIT}.Is.EqualTo(4));`), /literal/);
    // Spelled from the root, as a check must be, the same shapes are read the same way.
    refusedOnlyFor(lint(`global::System.Int32 n = typeof(global::Game.Diving.Hull).GetInterfaces().Length;\n${NUNIT}.Assert.That(n, ${NUNIT}.Is.GreaterThan(0));`), /reflection/);
    refusedOnlyFor(lint(`var m = typeof(global::Game.Diving.Hull).GetFields().Length;\n${NUNIT}.Assert.That((global::System.Int64)m, ${NUNIT}.Is.GreaterThan(0));`), /reflection/);
    refusedOnlyFor(lint(`${NUNIT}.Assert.That(global::System.Type.GetType("Game.Mover").GetMethods().Length, ${NUNIT}.Is.GreaterThan(0));`), /reflection/);
    refusedOnlyFor(lint(`${NUNIT}.Assert.That(global::System.Int32.MaxValue - global::UnityEngine.Mathf.PI, ${NUNIT}.Is.GreaterThan(0));`), /literal/);
  });

  it.each([
    ["Assert.Pass", `${NUNIT}.Assert.Pass();`],
    ["Assert.Ignore", `${NUNIT}.Assert.Ignore("later");`],
    ["Assert.Inconclusive", `${NUNIT}.Assert.Inconclusive();`],
    ["Assume", `${NUNIT}.Assume.That(Driver.IsSessionActive);\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    ["catch", `try { ${NUNIT}.Assert.That(Driver.IsSessionActive); } catch (global::System.Exception) { }`],
    ["#if", `#if UNITY_EDITOR\n${NUNIT}.Assert.That(Driver.IsSessionActive);\n#endif`],
    ["System.IO", `global::System.IO.File.WriteAllText("x", "y");\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    ["Process", `global::System.Diagnostics.Process.Start("sh");\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    [".Act(", `Service<global::Game.IDriverLike>().Act();\n${NUNIT}.Assert.That(Driver.Outcome, ${WON});`],
    ["IPlaythroughDriver", `var d = Service<global::Strada.Core.Play.IPlaythroughDriver>();\n${NUNIT}.Assert.That(d.Phase, ${NUNIT}.Is.EqualTo("Playing"));`],
    ["[Category]", `[global::NUnit.Framework.Category("x")] void Local() { }\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    ["[Ignore]", `[global::NUnit.Framework.Ignore("x")] void Local() { }\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    ["yield break", `if (!Driver.IsSessionActive) yield break;\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    ["ignoreFailingMessages", `global::UnityEngine.TestTools.LogAssert.ignoreFailingMessages = true;\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    // What Assert.Pass and Assert.Ignore throw ends the test the same way.
    ["SuccessException", `if (Driver.IsSessionActive) throw new global::NUnit.Framework.SuccessException("ok");\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
    ["IgnoreException", `throw new global::NUnit.Framework.IgnoreException("later");`],
    ["UnityEditor", `global::UnityEditor.EditorApplication.isPlaying = false;\n${NUNIT}.Assert.That(Driver.IsSessionActive);`],
  ])("rejects %s", (_name, body) => {
    const result = lint(body);
    expect(result.ok, body).toBe(false);
    // Refused for the construct, not for a name spelled bare.
    expect(result.problems.filter((p) => /from the root/.test(p)), body).toEqual([]);
  });

  it("does not mistake a forbidden word inside a string or a comment for code", () => {
    const result = lint(`// Assert.Pass would be wrong here; catch nothing\n${NUNIT}.Assert.That(Driver.Phase, ${NUNIT}.Is.Not.EqualTo("Assert.Pass catch #if"));`);
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it("rejects a body that escapes its method or does not assert at all", () => {
    refusedOnlyFor(lint(`${NUNIT}.Assert.That(Driver.IsSessionActive); }\n[global::UnityEngine.TestTools.UnityTest] public global::System.Collections.IEnumerator Extra() { yield return null;`), /balance/);
    const none = lint("yield return Frames(3);");
    expect(none.ok).toBe(false);
    expect(none.problems.join("\n")).toMatch(/assert/i);
  });

  it("rejects a harness coroutine that is called but not yielded (it would never run)", () => {
    const result = lint(`TapViewport(0.5f, 0.5f);\n${NUNIT}.Assert.That(Driver.IsSessionActive);`, { kind: "input" });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/TapViewport.*yield return/);
  });

  it("an input row must act through the harness's Tap/Drag/Press, and must not start the session itself", () => {
    const input = { kind: "input" as const, text: "The player taps to jump." };
    const noTap = lint(`Service<global::Game.IJumper>().Jump();\nyield return Frames(2);\n${NUNIT}.Assert.That(Service<global::Game.IJumper>().Airborne);`, input);
    expect(noTap.ok).toBe(false);
    expect(noTap.problems.join("\n")).toMatch(/Tap/);
    const starts = lint(`yield return StartSessionForSetup(1);\nyield return TapViewport(0.5f, 0.5f);\n${NUNIT}.Assert.That(Service<global::Game.IJumper>().Airborne);`, input);
    expect(starts.ok).toBe(false);
    expect(starts.problems.join("\n")).toMatch(/StartSession/);
    const good = lint(`yield return TapViewport(0.5f, 0.5f);\nyield return Frames(2);\n${NUNIT}.Assert.That(Service<global::Game.IJumper>().Airborne, ${NUNIT}.Is.True);`, input);
    expect(good).toEqual({ ok: true, problems: [] });
  });

  it("a numeric row takes an observation only; its observation must read the game", () => {
    const r = constantRow();
    expect(lintAcceptanceBody(r, { rid: r.rid, observe: "Service<global::Game.IJumpRules>().CoyoteSeconds" })).toEqual({ ok: true, problems: [] });
    refusedOnlyFor(lintAcceptanceBody(r, { rid: r.rid, body: `${NUNIT}.Assert.That(Service<global::Game.IJumpRules>().CoyoteSeconds, ${NUNIT}.Is.EqualTo(0.3));` }), /observe/);
    expect(lintAcceptanceBody(r, { rid: r.rid, observe: "0.3" }).ok).toBe(false);
    expect(lintAcceptanceBody(r, { rid: r.rid, observe: `1; ${NUNIT}.Assert.Pass(); var x = (0` }).ok).toBe(false);
  });

  it("refuses a bare type or namespace — a worker's type or a game namespace could take the name — and accepts the check's own names", () => {
    // Spelled bare, each could be a type a worker declared in Strada or the global namespace.
    // A type in call shape is a type too: a constructor, a positional pattern.
    const bare = lint("Assert.That(Time.timeScale, Is.EqualTo(0f));\nvar v = new Vector2(1f, 2f);\nif (Service<global::Game.IShapes>().Last is Corner(1, 2)) { }");
    expect(bare.ok).toBe(false);
    const problem = bare.problems.find((p) => /from the root/.test(p)) ?? "";
    for (const name of ["Assert", "Is", "Time", "Vector2", "Corner"]) expect(problem).toContain(`\`${name}\``);
    // A bare call is the check's own function, a harness member, or a method every class has.
    expect(lint(`bool Lit() => Service<global::Game.IShapes>().Lit;\nyield return Until(Lit);\n${NUNIT}.Assert.That(Lit().ToString(), ${NUNIT}.Is.EqualTo(true.ToString()));`).ok).toBe(true);
    expect(lint(`${NUNIT}.Assert.That(Shapes().Count, ${NUNIT}.Is.GreaterThan(0));`).problems.join("\n")).toContain("`Shapes`");
    // As the compiler reads it: an escape or a soft hyphen inside a name does not make it another name.
    expect(lint("As\\u0073ert.That(Driver.IsSessionActive);").problems.join("\n")).toContain("`Assert`");
    expect(lint("As\u00ADsert.That(Driver.IsSessionActive);").problems.join("\n")).toContain("`Assert`");
    // Its own names are never looked up: locals, out and pattern variables, lambda, foreach and query variables,
    // named arguments, initializer members, and the harness's members.
    const own = lint(
      [
        "var hull = Service<global::Game.Diving.IHull>();",
        "int before = hull.Compartments;",
        "global::Game.Diving.Compartment first = hull.Sections.First(c => c.IsFlooded);",
        "yield return Until(() => hull.Sections.Any((global::Game.Diving.Compartment c) => c.IsDry), timeoutSeconds: 5f);",
        "foreach (var section in hull.Sections) { if (section.IsFlooded) before--; }",
        "if (hull.TryFind(3, out var found) && found is global::Game.Diving.Compartment dry) { before += dry.Load; }",
        "var loads = from c in hull.Sections where c.IsDry select c.Load;",
        "var marker = new global::Game.Diving.Marker { Depth = 1, Bearing = 2 };",
        "if (hull.TryFind(4, out _)) { before -= hull.Sections.Count(static c => c.IsDry); }",
        `string kind = Driver.Outcome switch { ${OUTCOME}.Won => "won", _ => "other" };`,
        "PlaythroughView view = Driver;",
        `${NUNIT}.Assert.That(before + loads.Count() + marker.Depth + first.Load + kind.Length, ${NUNIT}.Is.GreaterThan(BootSeconds - view.Phase.Length));`,
      ].join("\n"),
    );
    expect(own).toEqual({ ok: true, problems: [] });
  });

  it("caps a body at 80 lines", () => {
    const long = Array.from({ length: 80 }, () => "yield return Frames(1);").join("\n") + `\n${NUNIT}.Assert.That(Driver.IsSessionActive);`;
    refusedOnlyFor(lint(long), /at most 80/);
  });
});

// =============================================================================
// A GAME NAMESPACE NAMED LIKE A FRAMEWORK TYPE
// =============================================================================

describe("a game whose root namespace shares a framework type's name", () => {
  it.each(["Grid", "Input", "Physics", "Camera", "Random", "Debug", "Is", "Has"])(
    "checks a game namespace named %s: the surface prints it from the root, and nothing in the acceptance file can take the name",
    (ns) => {
      const root = project();
      put(root, `Assets/${ns}Game/${ns}Game.asmdef`, asmdef(`${ns}Game.Runtime`));
      put(root, `Assets/${ns}Game/Hull.cs`, `namespace ${ns}\n{\n    public interface IHull\n    {\n        int Compartments { get; }\n    }\n}\n`);
      const digest = publicSurfaceDigest(root, requirementTokens("The hull has nine compartments."));
      expect(digest).toContain(`public interface global::${ns}.IHull`);
      const r = constantRow();
      const check: AcceptanceCheckBody = { rid: r.rid, observe: `Service<global::${ns}.IHull>().Compartments` };
      expect(lintAcceptanceBody(r, check)).toEqual({ ok: true, problems: [] });
      // Spelled bare, the name is whatever a using imports under it, or a worker's type.
      const bare = lintAcceptanceBody(r, { rid: r.rid, observe: `Service<${ns}.IHull>().Compartments` });
      expect(bare.problems.find((p) => /from the root/.test(p))).toContain(`\`${ns}\``);
      // No using imports a type that could share the game namespace's name, so the shared assembly compiles whatever the game calls it.
      const { source } = renderAcceptanceFile("m1", [{ row: r, check }]);
      expect(source.split("\n").filter((l) => /^\s*using\b/.test(l))).toEqual(["    using static global::System.Linq.Enumerable;"]);
      expect(unrootedNames(source, { allowed: ACCEPTANCE_HARNESS_MEMBERS })).toEqual([]);
      expect(ACCEPTANCE_FIXTURE_SOURCE.split("\n").filter((l) => /^\s*using\b/.test(l))).toEqual([]);
    },
  );
});

// =============================================================================
// THE HARNESS AND ITS ASSEMBLY
// =============================================================================

describe("the harness", () => {
  it("knows no game, and offers every member the writer is told about", () => {
    for (const member of [
      "IEnumerator Boot()",
      "IEnumerator Frames(int count)",
      "IEnumerator Seconds(float seconds)",
      "PlaythroughView Driver",
      "IEnumerator StartSessionForSetup(int index)",
      "T Service<T>()",
      "bool AnyAudioPlaying()",
      "IReadOnlyList<string> ActiveScreens()",
      "string InputInjectable",
      "IEnumerator TapViewport(float x, float y)",
      "IEnumerator TapScreen(global::UnityEngine.Vector2 position)",
      "IEnumerator TapObject(global::UnityEngine.GameObject target)",
      "IEnumerator Drag(global::UnityEngine.Vector2 from, global::UnityEngine.Vector2 to, float seconds = 0.25f)",
      "IEnumerator Press(string key)",
    ]) {
      expect(ACCEPTANCE_FIXTURE_SOURCE, member).toContain(member);
      expect(harnessApiDoc(), member).toContain(member);
    }
    // The read-only driver view never offers the driver's own action.
    expect(ACCEPTANCE_FIXTURE_SOURCE).not.toMatch(/\.Act\s*\(/);
    expect(ACCEPTANCE_FIXTURE_SOURCE).toContain("global::Strada.Core.Bootstrap.GameBootstrapper.Services");
    expect(ACCEPTANCE_FIXTURE_SOURCE).toContain(
      "global::UnityEngine.SceneManagement.SceneManager.LoadSceneAsync(0, global::UnityEngine.SceneManagement.LoadSceneMode.Single)",
    );
    // What the writer may name bare is what the harness declares for it, and the writer is told each one.
    for (const member of ACCEPTANCE_HARNESS_MEMBERS) {
      expect(ACCEPTANCE_FIXTURE_SOURCE, member).toMatch(new RegExp(`\\bprotected\\b[^;{]*\\b${member}\\b`));
      expect(harnessApiDoc(), member).toMatch(new RegExp(`\\b${member}\\b`));
    }
  });

  it("every conditional symbol the harness compiles on is one its assembly defines", () => {
    const root = project();
    put(root, "Assets/Game/Game.Runtime.asmdef", asmdef("Game.Runtime"));
    const plan = planAcceptanceAssembly(root);
    const defined = new Set((JSON.parse(plan.asmdef).versionDefines as Array<{ define: string }>).map((d) => d.define));
    const used = new Set([...ACCEPTANCE_FIXTURE_SOURCE.matchAll(/\bSTRADA_ACCEPTANCE_[A-Z0-9_]+/g)].map((m) => m[0]));
    expect(used.size).toBeGreaterThan(0);
    for (const symbol of used) expect(defined.has(symbol), symbol).toBe(true);
  });

  it("routes injected input to the game though a test run has no focused Game View, and puts the project's settings back", () => {
    // Measured in a Unity 6 PlayMode run: without this every injected tap, drag and key press was dropped.
    const boot = ACCEPTANCE_FIXTURE_SOURCE.slice(ACCEPTANCE_FIXTURE_SOURCE.indexOf("protected global::System.Collections.IEnumerator Boot()"));
    expect(boot.indexOf("EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView")).toBeGreaterThan(0);
    expect(boot.indexOf("EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView")).toBeLessThan(boot.indexOf("LoadSceneAsync"));
    expect(boot).toContain("InputSettings.BackgroundBehavior.IgnoreFocus");
    // The project's settings asset is swapped for a copy, never edited.
    expect(boot).toContain("UnityEngine.Object.Instantiate(current)");
    expect(ACCEPTANCE_FIXTURE_SOURCE).toMatch(/\[global::NUnit\.Framework\.TearDown\]\s*public void RestoreHarnessState\(\)[\s\S]*InputSystem\.settings = _projectInputSettingsAsset;/);
    // A scene that never loads is the harness's fault, not a test timeout.
    expect(boot).toContain('HarnessFault("no-scene", "build scene 0 did not finish loading in "');
  });

  it("imports nothing and spells every type it names from the root, so no type outside the folder can answer for its verdicts or its data", () => {
    // The harness sits in namespace Strada.Acceptance: C# finds a type a worker declares there, in Strada or in the global
    // namespace before any using's. Its data path (GameBootstrapper.Services, the driver) and its verdicts are the checks'.
    expect(ACCEPTANCE_FIXTURE_SOURCE.split("\n").filter((l) => /^\s*using\b/.test(l))).toEqual([]);
    // Walked as the compiler reads it, every #if branch included: keywords, its own declarations and global:: only.
    expect(unrootedNames(ACCEPTANCE_FIXTURE_SOURCE)).toEqual([]);
    // The walk would see the reviewer's case: the service locator named bare.
    const bare = ACCEPTANCE_FIXTURE_SOURCE.replace(/global::Strada\.Core\.Bootstrap\.GameBootstrapper\.Services/g, "GameBootstrapper.Services");
    expect(unrootedNames(bare)).toEqual(["GameBootstrapper"]);
    expect(unrootedNames(ACCEPTANCE_FIXTURE_SOURCE.replace("[global::NUnit.Framework.TearDown]", "[TearDown]"))).toEqual(["TearDown"]);
    expect(unrootedNames(ACCEPTANCE_FIXTURE_SOURCE.replace("float deadline =", "var deadline ="))).toEqual(["var"]);
  });

  it("stamps its own bytes, so the next Brain version's restore knows them for the system's", () => {
    const body = ACCEPTANCE_FIXTURE_SOURCE.slice(ACCEPTANCE_FIXTURE_SOURCE.indexOf("\n") + 1);
    expect(ACCEPTANCE_FIXTURE_SOURCE).toBe(stampedLike(body));
  });

  it("tags its own failures so a judge can tell a harness fault from a game failure", () => {
    expect(ACCEPTANCE_FIXTURE_SOURCE).toContain('"[strada-acceptance:" + code + "] "');
    expect(harnessFaultOf("[strada-acceptance:no-driver] the game registers no Strada.Core.Play.IPlaythroughDriver")).toBe("no-driver");
    expect(harnessFaultOf("Expected: True\n  But was: False")).toBeUndefined();
    expect(harnessFaultOf("[strada-acceptance:made-up] x")).toBeUndefined();
  });
});

describe("planAcceptanceAssembly", () => {
  it("references the game's runtime assemblies, Strada.Core and the test runner, and never an Editor or test assembly", () => {
    const root = project();
    put(root, "Assets/Modules/Movement/Movement.asmdef", asmdef("Game.Movement"));
    put(root, "Assets/Modules/Score/Score.asmdef", asmdef("Game.Score"));
    put(root, "Assets/Modules/Score/Editor/Score.Editor.asmdef", asmdef("Game.Score.Editor"));
    put(root, "Assets/Tools/EditorOnly.asmdef", asmdef("Game.Tools", { includePlatforms: ["Editor"] }));
    put(root, "Assets/Tests/Runtime/Game.Tests.asmdef", asmdef("Game.Tests", { defineConstraints: ["UNITY_INCLUDE_TESTS"] }));
    put(root, "Assets/Modules/Score/Checks/Score.Checks.asmdef", asmdef("Game.Score.Checks", { references: ["UnityEngine.TestRunner"] }));
    put(root, "Assets/Modules/Movement/Specs/Specs.asmdef", asmdef("Game.Movement.Specs", { precompiledReferences: ["nunit.framework.dll"] }));
    // Only its define constraint says this one is a test assembly.
    put(root, "Assets/Modules/Score/Verification/Score.Verification.asmdef", asmdef("Game.Score.Verification", { defineConstraints: ["UNITY_INCLUDE_TESTS"] }));
    const plan = planAcceptanceAssembly(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.runtime.map((a) => a.name)).toEqual(["Game.Movement", "Game.Score"]);
    const json = JSON.parse(plan.asmdef);
    expect(json.name).toBe("Strada.Acceptance");
    expect(json.references).toEqual(["Strada.Core", "UnityEngine.TestRunner", "Game.Movement", "Game.Score"]);
    expect(json.precompiledReferences).toEqual(["nunit.framework.dll"]);
    expect(json.overrideReferences).toBe(true);
    expect(json.defineConstraints).toEqual(["UNITY_INCLUDE_TESTS"]);
    expect(json.includePlatforms).toEqual([]);
    expect(json.autoReferenced).toBe(false);
    for (const excluded of ["Game.Score.Editor", "Game.Tools", "Game.Tests", "Game.Score.Checks", "Game.Movement.Specs", "Game.Score.Verification"]) {
      expect(json.references).not.toContain(excluded);
      expect(plan.excluded.map((e) => e.name)).toContain(excluded);
    }
  });

  it("adds the Input System and uGUI assemblies only when the project has those packages", () => {
    const root = project();
    put(root, "Assets/Game/Game.asmdef", asmdef("Game.Runtime"));
    expect(JSON.parse(planAcceptanceAssembly(root).asmdef).references).not.toContain("Unity.InputSystem");
    put(root, "Packages/manifest.json", JSON.stringify({ dependencies: { "com.unity.inputsystem": "1.11.2", "com.unity.ugui": "2.0.0" } }));
    const refs = JSON.parse(planAcceptanceAssembly(root).asmdef).references as string[];
    expect(refs).toContain("Unity.InputSystem");
    expect(refs).toContain("UnityEngine.UI");
  });

  it("a project without Strada.Core cannot build the harness: no-assembly; a vendored copy under Assets counts", () => {
    const root = project();
    put(root, "Assets/Game/Game.asmdef", asmdef("Game.Runtime"));
    put(root, "Packages/manifest.json", JSON.stringify({ dependencies: { "com.unity.test-framework": "1.6.0" } }));
    const plan = planAcceptanceAssembly(root);
    expect(plan.refusal?.kind).toBe("no-assembly");
    expect(plan.refusal?.detail).toMatch(/Strada\.Core/);
    put(root, "Assets/Plugins/StradaCore/Runtime/Strada.Core.asmdef", asmdef("Strada.Core", { references: [] }));
    const vendored = planAcceptanceAssembly(root);
    expect(vendored.refusal).toBeUndefined();
    // The framework is referenced by name, never as one of the game's own assemblies.
    expect(vendored.runtime.map((a) => a.name)).toEqual(["Game.Runtime"]);
  });

  it("a project whose code has no runtime assembly cannot be measured: no-assembly", () => {
    const root = project();
    put(root, "Assets/Scripts/Player.cs", "public class Player {}");
    put(root, "Assets/Tests/T.asmdef", asmdef("Game.Tests", { defineConstraints: ["UNITY_INCLUDE_TESTS"] }));
    const plan = planAcceptanceAssembly(root);
    expect(plan.refusal?.kind).toBe("no-assembly");
    expect(plan.runtime).toEqual([]);
  });
});

// =============================================================================
// THE FILES ON DISK
// =============================================================================

describe("deterministic .meta GUIDs", () => {
  it("are sha256('strada-acceptance:' + path), the same on every machine and every write", () => {
    const path = `${ACCEPTANCE_DIR}/AcceptanceFixture.cs`;
    expect(acceptanceGuid(path)).toBe(sha256(`strada-acceptance:${path}`).slice(0, 32));
    expect(acceptanceGuid(path)).toBe(acceptanceGuid(path));
    expect(acceptanceGuid(path)).not.toBe(acceptanceGuid(`${ACCEPTANCE_DIR}/Acceptance_M1.cs`));

    const root = project();
    const harness: AcceptanceHarness = { asmdef: planAcceptanceAssembly(root).asmdef };
    const source = storedSource("m1", [{ row: row(), check: goodRuleCheck }]);
    materialize(root, [source], "committed", harness);
    const meta = (rel: string) => readFileSync(join(root, `${rel}.meta`), "utf8");
    expect(meta(ACCEPTANCE_DIR)).toContain(`guid: ${acceptanceGuid(ACCEPTANCE_DIR)}`);
    expect(meta(ACCEPTANCE_DIR)).toContain("folderAsset: yes");
    expect(meta(ACCEPTANCE_FIXTURE_PATH)).toContain(`guid: ${acceptanceGuid(ACCEPTANCE_FIXTURE_PATH)}`);
    expect(meta(ACCEPTANCE_FIXTURE_PATH)).toContain("MonoImporter:");
    expect(meta(ACCEPTANCE_ASMDEF_PATH)).toContain("AssemblyDefinitionImporter:");
    expect(meta(source.path)).toContain(`guid: ${acceptanceGuid(source.path)}`);
  });
});

describe("restoreAcceptance", () => {
  function setUp(): { root: string; source: AcceptanceSource; harness: AcceptanceHarness } {
    const root = project();
    put(root, "Assets/Game/Game.asmdef", asmdef("Game.Runtime"));
    const harness: AcceptanceHarness = { asmdef: planAcceptanceAssembly(root).asmdef };
    const source = storedSource("m1", [{ row: row(), check: goodRuleCheck }]);
    const first = materialize(root, [source], "committed", harness);
    expect(first.tamper).toEqual([]);
    return { root, source, harness };
  }

  it("finds nothing to restore when the folder holds exactly the stored bytes", () => {
    const { root, source, harness } = setUp();
    expect(restoreAcceptance(root, [source], "committed", harness)).toEqual({ tamper: [], written: [], deleted: [] });
  });

  it("restores a tampered file and reports it", () => {
    const { root, source, harness } = setUp();
    writeFileSync(join(root, source.path), source.source.replace(WON, `${NUNIT}.Is.Not.Null`));
    writeFileSync(join(root, ACCEPTANCE_FIXTURE_PATH), "// emptied by a worker\n");
    const result = restoreAcceptance(root, [source], "committed", harness);
    expect(result.tamper.sort()).toEqual([ACCEPTANCE_FIXTURE_PATH, source.path].sort());
    expect(readFileSync(join(root, source.path), "utf8")).toBe(source.source);
    expect(readFileSync(join(root, ACCEPTANCE_FIXTURE_PATH), "utf8")).toBe(ACCEPTANCE_FIXTURE_SOURCE);
  });

  it("deletes a foreign file in the folder, and a whole foreign subfolder, and reports them", () => {
    const { root, source, harness } = setUp();
    put(root, `${ACCEPTANCE_DIR}/Extra.cs`, "namespace Strada.Acceptance.M1 { }");
    put(root, `${ACCEPTANCE_DIR}/Sub/More.cs`, "class More {}");
    const result = restoreAcceptance(root, [source], "committed", harness);
    expect(result.tamper).toEqual(expect.arrayContaining([`${ACCEPTANCE_DIR}/Extra.cs`, `${ACCEPTANCE_DIR}/Sub/More.cs`]));
    expect(existsSync(join(root, ACCEPTANCE_DIR, "Extra.cs"))).toBe(false);
    expect(existsSync(join(root, ACCEPTANCE_DIR, "Sub"))).toBe(false);
  });

  it("a deleted check is tamper when the checks are committed, and an expected absence when they are ephemeral", () => {
    const { root, source, harness } = setUp();
    rmSync(join(root, source.path));
    expect(restoreAcceptance(root, [source], "committed", harness).tamper).toEqual([source.path]);
    rmSync(join(root, source.path));
    expect(restoreAcceptance(root, [source], "ephemeral", harness).tamper).toEqual([]);
    expect(readFileSync(join(root, source.path), "utf8")).toBe(source.source);
  });

  it("replaces a folder swapped for a symlink without writing through it", () => {
    const { root, source, harness } = setUp();
    const elsewhere = mkdtempSync(join(tmpdir(), "strada-acceptance-elsewhere-"));
    roots.push(elsewhere);
    rmSync(join(root, ACCEPTANCE_DIR), { recursive: true });
    symlinkSync(elsewhere, join(root, ACCEPTANCE_DIR));
    const result = restoreAcceptance(root, [source], "committed", harness);
    expect(result.tamper).toContain(ACCEPTANCE_DIR);
    expect(readFileSync(join(root, source.path), "utf8")).toBe(source.source);
    expect(existsSync(join(elsewhere, "Acceptance_M1.cs"))).toBe(false);
  });

  it("refreshes what the system itself wrote before — an older harness, a check before its regeneration, an older plan — without calling it tamper", () => {
    const { root, source, harness } = setUp();
    // A harness from another Brain version: stamped, so the system's own.
    writeFileSync(join(root, ACCEPTANCE_FIXTURE_PATH), stampedLike("// an older harness\nnamespace Strada.Acceptance { public abstract class AcceptanceFixture { } }\n"));
    // The check as it was rendered before a regeneration.
    const before = storedSource("m1", [{ row: row(), check: { ...goodRuleCheck, body: `${NUNIT}.Assert.That(Driver.Outcome, ${NUNIT}.Is.Not.EqualTo(${OUTCOME}.Lost));` } }]);
    writeFileSync(join(root, source.path), before.source);
    // The assembly as planned before the game gained a module.
    writeFileSync(join(root, ACCEPTANCE_ASMDEF_PATH), renderAcceptanceAsmdef(["Strada.Core", "UnityEngine.TestRunner"]));
    // A check the store no longer holds (its milestone was waived).
    const waived = storedSource("m9", [{ row: row({ rid: "req-090-999999999999" }), check: { ...goodRuleCheck, rid: "req-090-999999999999" } }]);
    writeFileSync(join(root, waived.path), waived.source);

    const result = restoreAcceptance(root, [source], "committed", harness);
    expect(result.tamper).toEqual([]);
    expect(result.written).toEqual(expect.arrayContaining([ACCEPTANCE_FIXTURE_PATH, ACCEPTANCE_ASMDEF_PATH, source.path]));
    expect(result.deleted).toEqual([waived.path]);
    expect(readFileSync(join(root, source.path), "utf8")).toBe(source.source);
    expect(readFileSync(join(root, ACCEPTANCE_ASMDEF_PATH), "utf8")).toBe(harness.asmdef);
  });

  it("does not call a checkout's line endings tamper: CRLF copies of the system's bytes are rewritten, not reported", () => {
    const { root, source, harness } = setUp();
    const crlf = (text: string): string => text.replace(/\n/g, "\r\n");
    // Git for Windows checks text out with CRLF (core.autocrlf=true): the stored check, the harness and the plan.
    for (const rel of [source.path, ACCEPTANCE_FIXTURE_PATH, ACCEPTANCE_ASMDEF_PATH]) writeFileSync(join(root, rel), crlf(readFileSync(join(root, rel), "utf8")));
    const current = restoreAcceptance(root, [source], "committed", harness);
    expect(current.tamper).toEqual([]);
    expect(current.written).toEqual([ACCEPTANCE_ASMDEF_PATH, ACCEPTANCE_FIXTURE_PATH, source.path].sort());
    expect(readFileSync(join(root, source.path), "utf8")).toBe(source.source);

    // The system's own older bytes, checked out the same way: an older harness, an older plan, a waived check.
    writeFileSync(join(root, ACCEPTANCE_FIXTURE_PATH), crlf(stampedLike("// an older harness\nnamespace Strada.Acceptance { public abstract class AcceptanceFixture { } }\n")));
    writeFileSync(join(root, ACCEPTANCE_ASMDEF_PATH), crlf(renderAcceptanceAsmdef(["Strada.Core", "UnityEngine.TestRunner"])));
    const waived = storedSource("m9", [{ row: row({ rid: "req-090-999999999999" }), check: { ...goodRuleCheck, rid: "req-090-999999999999" } }]);
    writeFileSync(join(root, waived.path), crlf(waived.source));
    const older = restoreAcceptance(root, [source], "committed", harness);
    expect(older.tamper).toEqual([]);
    expect(older.deleted).toEqual([waived.path]);

    // An edit is tamper whatever its line endings.
    writeFileSync(join(root, source.path), crlf(source.source.replace(WON, `${NUNIT}.Is.Not.Null`)));
    expect(restoreAcceptance(root, [source], "committed", harness).tamper).toEqual([source.path]);
  });

  it("still calls an edit tamper when the editor kept the stamp line, or hand-wrote an asmdef", () => {
    const { root, source, harness } = setUp();
    // The stamp line kept, the assertion weakened under it.
    writeFileSync(join(root, source.path), source.source.replace(WON, `${NUNIT}.Is.Not.Null`));
    writeFileSync(join(root, ACCEPTANCE_ASMDEF_PATH), JSON.stringify({ name: "Strada.Acceptance", references: [], defineConstraints: ["NEVER_DEFINED"] }));
    const result = restoreAcceptance(root, [source], "committed", harness);
    expect(result.tamper).toEqual([ACCEPTANCE_ASMDEF_PATH, source.path].sort());
  });

  it("without a harness, plans the assembly from the project as it is now: a module added since is referenced, not tamper", () => {
    const root = project();
    put(root, "Assets/Game/Game.asmdef", asmdef("Game.Runtime"));
    const source = storedSource("m1", [{ row: row(), check: goodRuleCheck }]);
    materialize(root, [source], "committed");
    put(root, "Assets/Combat/Combat.asmdef", asmdef("Game.Combat"));
    const result = restoreAcceptance(root, [source], "committed");
    expect(result.tamper).toEqual([]);
    expect(result.written).toEqual([ACCEPTANCE_ASMDEF_PATH]);
    expect(JSON.parse(readFileSync(join(root, ACCEPTANCE_ASMDEF_PATH), "utf8")).references).toEqual(["Strada.Core", "UnityEngine.TestRunner", "Game.Combat", "Game.Runtime"]);
  });

  it("reports what outside the folder could answer for a check as tamper on every restore, and leaves the worker's files where they are", () => {
    const { root, source, harness } = setUp();
    // A worker's type in the harness's namespace, and an assembly reference that compiles a worker folder into the checks' assembly.
    put(root, "Assets/Game/Shadow.cs", "namespace Strada.Acceptance { public static class GameBootstrapper { } }");
    put(root, "Assets/Game/Into.asmref", JSON.stringify({ reference: "Strada.Acceptance" }));
    const first = restoreAcceptance(root, [source], "committed", harness);
    expect(first.tamper).toEqual(["Assets/Game/Into.asmref", "Assets/Game/Shadow.cs"]);
    expect(first.written).toEqual([]);
    expect(first.deleted).toEqual([]);
    expect(existsSync(join(root, "Assets/Game/Shadow.cs"))).toBe(true);
    // Restore cannot put a worker's file right, so it stays tamper, in either mode, until the worker removes it.
    expect(restoreAcceptance(root, [source], "ephemeral", harness).tamper).toEqual(["Assets/Game/Into.asmref", "Assets/Game/Shadow.cs"]);
    rmSync(join(root, "Assets/Game/Shadow.cs"));
    rmSync(join(root, "Assets/Game/Into.asmref"));
    expect(restoreAcceptance(root, [source], "committed", harness).tamper).toEqual([]);
  });

  it("restores a .meta Unity or a worker changed without calling it tamper", () => {
    const { root, source, harness } = setUp();
    writeFileSync(join(root, `${source.path}.meta`), "fileFormatVersion: 2\nguid: 00000000000000000000000000000000\n");
    const result = restoreAcceptance(root, [source], "committed", harness);
    expect(result.tamper).toEqual([]);
    expect(result.written).toEqual([`${source.path}.meta`]);
  });

  it("refuses a stored file whose bytes do not match its sha256, or whose path leaves the folder", () => {
    const { root, source, harness } = setUp();
    expect(() => restoreAcceptance(root, [{ ...source, source: `${source.source}// x\n` }], "committed", harness)).toThrow(/sha256/);
    expect(() => restoreAcceptance(root, [{ ...source, path: "Assets/Game/Evil.cs" }], "committed", harness)).toThrow(/StradaAcceptance/);
  });
});

describe("ephemeral checks", () => {
  it("are kept out of git while they exist, and removed with their exclude lines", () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    put(root, "Assets/Game/Game.asmdef", asmdef("Game.Runtime"));
    const harness: AcceptanceHarness = { asmdef: planAcceptanceAssembly(root).asmdef };
    const source = storedSource("m1", [{ row: row(), check: goodRuleCheck }]);
    materialize(root, [source], "ephemeral", harness);
    const ignored = (rel: string): boolean => {
      try {
        execFileSync("git", ["-C", root, "check-ignore", "-q", rel]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored(source.path)).toBe(true);
    expect(ignored(`${ACCEPTANCE_DIR}.meta`)).toBe(true);
    expect(ignored("Assets/Game/Game.asmdef")).toBe(false);
    // A second materialize does not stack a second block.
    materialize(root, [source], "ephemeral", harness);
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/strada-acceptance/g)?.length).toBe(2);

    removeEphemeral(root);
    expect(existsSync(join(root, ACCEPTANCE_DIR))).toBe(false);
    expect(existsSync(join(root, `${ACCEPTANCE_DIR}.meta`))).toBe(false);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).not.toContain("StradaAcceptance");

    // Restored for the next run: an expected absence, not tamper, and out of git again.
    expect(restoreAcceptance(root, [source], "ephemeral", harness).tamper).toEqual([]);
    expect(ignored(source.path)).toBe(true);
    expect(execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })).not.toContain("StradaAcceptance");
  });

  it("committed checks are never excluded", () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    const harness: AcceptanceHarness = { asmdef: asmdef("Strada.Acceptance") };
    const source = storedSource("m1", [{ row: row(), check: goodRuleCheck }]);
    materialize(root, [source], "ephemeral", harness);
    materialize(root, [source], "committed", harness);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).not.toContain("StradaAcceptance");
  });
});

describe("scanForeignAcceptanceNamespace", () => {
  it("finds the acceptance namespace declared outside the system's folder, and ignores mentions in comments", () => {
    const root = project();
    put(root, "Assets/Tests/Fake.cs", "namespace Strada.Acceptance.M1 { public class Acceptance_M1 { } }");
    put(root, "Assets/Scripts/Scoped.cs", "namespace Strada.Acceptance;\nclass X {}");
    put(root, "Assets/Scripts/Note.cs", "// namespace Strada.Acceptance is the system's\nnamespace Game { }");
    put(root, `${ACCEPTANCE_DIR}/Acceptance_M1.cs`, "namespace Strada.Acceptance.M1 { }");
    expect(scanForeignAcceptanceNamespace(root)).toEqual(["Assets/Scripts/Scoped.cs", "Assets/Tests/Fake.cs"]);
  });

  it("finds a test named into the namespace from outside it (NUnit TestName on a global-namespace fixture)", () => {
    const root = project();
    put(root, "Assets/Tests/Named.cs", '[NUnit.Framework.TestFixture(TestName = "Strada.Acceptance.M1.Acceptance_M1")]\npublic class Named { }');
    put(root, "Assets/Tests/Mention.cs", '// TestName = "Strada.Acceptance.M1" would be wrong\nnamespace Game.Tests { public class Mention { } }');
    expect(scanForeignAcceptanceNamespace(root)).toEqual(["Assets/Tests/Named.cs"]);
  });

  it("finds an assembly reference that compiles code from outside the folder into the acceptance assembly, by name or by GUID", () => {
    const root = project();
    put(root, "Assets/Game/Game.asmdef", asmdef("Game.Runtime"));
    put(root, "Assets/Game/Extras/Extras.asmref", JSON.stringify({ reference: "Game.Runtime" }));
    // Code under these lands in Strada.Acceptance itself, where `namespace Strada { static class Assert }` shadows NUnit.
    put(root, "Assets/Shadow/Assert.cs", "namespace Strada { public static class Assert { } }");
    put(root, "Assets/Shadow/ByName.asmref", JSON.stringify({ reference: "Strada.Acceptance" }));
    put(root, "Assets/Shadow/Deep/ByGuid.asmref", JSON.stringify({ reference: `GUID:${acceptanceGuid(ACCEPTANCE_ASMDEF_PATH)}` }));
    put(root, "Packages/com.game.extra/Runtime/Into.asmref", JSON.stringify({ reference: "Strada.Acceptance" }, null, 2).replace(/\n/g, "\r\n"));
    // Unity's reader is not JSON.parse: an asmref it might read that names the assembly is reported all the same.
    put(root, "Assets/Shadow/Loose.asmref", '{ "reference": "Strada.Acceptance", }');
    expect(scanForeignAcceptanceNamespace(root)).toEqual(
      ["Assets/Shadow/ByName.asmref", "Assets/Shadow/Deep/ByGuid.asmref", "Assets/Shadow/Loose.asmref", "Packages/com.game.extra/Runtime/Into.asmref"].sort(),
    );
  });

  it("reads a namespace as C# does: a verbatim or escaped spelling of Strada.Acceptance is the same namespace", () => {
    const root = project();
    put(root, "Assets/Scripts/Verbatim.cs", "namespace @Strada.@Acceptance.M1 { public static class Assert { } }");
    put(root, "Assets/Scripts/Escaped.cs", "namespace Str\\u0061da.Acceptance.M1 { public static class Is { } }");
    put(root, "Assets/Scripts/Other.cs", "namespace @Strada.Gameplay { }");
    expect(scanForeignAcceptanceNamespace(root)).toEqual(["Assets/Scripts/Escaped.cs", "Assets/Scripts/Verbatim.cs"]);
  });
});

describe("scanForeignAcceptanceNamespace reads names as the compiler does", () => {
  it("drops a soft hyphen or a zero-width character inside a name, raw or escaped", () => {
    const root = project();
    put(root, "Assets/Scripts/SoftHyphen.cs", "namespace Stra\u00ADda.Acceptance.M1 { public static class Assert { } }");
    put(root, "Assets/Scripts/EscapedSoftHyphen.cs", "namespace Stra\\u00ADda.Acceptance { public static class GameBootstrapper { } }");
    put(root, "Assets/Scripts/ZeroWidth.cs", "namespace Strada\u200B.Acc\u200Deptance { public static class Is { } }");
    // One name, not the acceptance namespace.
    put(root, "Assets/Scripts/Other.cs", "namespace Strada\u00ADGame { }");
    expect(scanForeignAcceptanceNamespace(root)).toEqual(["Assets/Scripts/EscapedSoftHyphen.cs", "Assets/Scripts/SoftHyphen.cs", "Assets/Scripts/ZeroWidth.cs"]);
  });

  it("finds a type named var, dynamic, nint or nuint: C# would give it every check's var locals", () => {
    const root = project();
    put(root, "Assets/Scripts/Var.cs", "public class var { public static implicit operator var(int n) { return new var(); } }");
    put(root, "Assets/Scripts/Dyn.cs", "namespace Strada { public struct d\u00ADynamic { } }");
    put(root, "Assets/Scripts/Native.cs", "namespace Game { public record \\u006Eint(int Value); }");
    // A member or a type that only starts like one is not a type so named.
    put(root, "Assets/Scripts/Fine.cs", "namespace Game { public class Variant { int var = 0; } public class Dynamics { } }");
    expect(scanForeignAcceptanceNamespace(root)).toEqual(["Assets/Scripts/Dyn.cs", "Assets/Scripts/Native.cs", "Assets/Scripts/Var.cs"]);
  });

  it("leaves a delegate's return type and a nested type alone: neither is a type a check's var could find", () => {
    const root = project();
    // The name is what follows the return type; nint and dynamic here are what the delegates return.
    put(root, "Assets/Scripts/Interop.cs", "namespace Game.Native { public delegate nint Allocate(int size); public delegate dynamic Peek<T>(T key); }");
    // A nested type is in scope only inside its outer type, which a check never is.
    put(
      root,
      "Assets/Scripts/Nested.cs",
      "namespace Game { public class Kiln { class var { } public struct nint { } public delegate void dynamic(); public void Fire() { var heat = 3; } } }",
    );
    put(root, "Assets/Scripts/FileScoped.cs", "namespace Game.Kilns;\npublic class Shelf { public record nuint(int Width); }");
    // Still a type so named, at namespace level: a delegate named var, generic or not, and one in a file-scoped namespace.
    put(root, "Assets/Scripts/NamedVar.cs", "public delegate nint var<T>(T value);");
    put(root, "Assets/Scripts/FileScopedTop.cs", "namespace Strada;\npublic class Kiln { }\npublic struct nint { }");
    put(root, "Assets/Scripts/AfterNested.cs", "namespace Strada { public class Kiln { class Ember { } } public class var { } }");
    expect(scanForeignAcceptanceNamespace(root)).toEqual(["Assets/Scripts/AfterNested.cs", "Assets/Scripts/FileScopedTop.cs", "Assets/Scripts/NamedVar.cs"]);
  });

  it("does not let an #if branch's braces hide a later type so named: braces the compiler may not see fall back to the whole file", () => {
    const root = project();
    // The editor/player split: two headers open one body, so a walk over both branches is one brace too deep after it.
    put(
      root,
      "Assets/Scripts/EditorSplit.cs",
      [
        "#if UNITY_EDITOR",
        "public class Kiln : UnityEditor.Editor {",
        "#else",
        "public class Kiln : UnityEngine.MonoBehaviour {",
        "#endif",
        "  void Fire() { }",
        "}",
        "public struct nint { }",
      ].join("\n"),
    );
    // Balanced as text, yet with NEVER undefined the compiler reads `var` at Strada level.
    put(
      root,
      "Assets/Scripts/Balanced.cs",
      ["namespace Strada {", "#if NEVER", "  class Hide {", "#endif", "  public class var { }", "#if NEVER", "  }", "#endif", "}"].join("\n"),
    );
    // A stray closer: the walk cannot say what is nested, so the whole file is read.
    put(root, "Assets/Scripts/Stray.cs", "namespace Game { class A { } } } class B { class dynamic { } }");
    // A namespace the compiler reads as one, though spelled with spaces round its dot or letters past ASCII.
    put(root, "Assets/Scripts/Spaced.cs", "namespace Strada . Kilns { class Shelf { } public class var { } }");
    put(root, "Assets/Scripts/Letters.cs", "namespace Fırın { public struct nint { } }");
    // Directives with no brace inside a branch leave the walk exact: a nested type stays nested.
    put(
      root,
      "Assets/Scripts/QuietBranch.cs",
      ["namespace Game {", "  public class Kiln {", "#if UNITY_EDITOR", "    int heat;", "#endif", "    class var { }", "  }", "}"].join("\n"),
    );
    expect(scanForeignAcceptanceNamespace(root)).toEqual([
      "Assets/Scripts/Balanced.cs",
      "Assets/Scripts/EditorSplit.cs",
      "Assets/Scripts/Letters.cs",
      "Assets/Scripts/Spaced.cs",
      "Assets/Scripts/Stray.cs",
    ]);
  });
});

// =============================================================================
// WHAT THE WRITER IS SHOWN
// =============================================================================

describe("publicSurfaceDigest", () => {
  it("lists public signatures of runtime code only, never bodies, tests or editor code", () => {
    const root = project();
    put(root, "Assets/Modules/Jump/Jump.asmdef", asmdef("Game.Jump"));
    put(
      root,
      "Assets/Modules/Jump/JumpRules.cs",
      [
        "using UnityEngine;",
        "namespace Game.Jump",
        "{",
        "    public interface IJumpRules",
        "    {",
        "        float CoyoteSeconds { get; }",
        "        bool TryJump(int playerId);",
        "    }",
        "    public sealed class JumpRules : IJumpRules",
        "    {",
        "        private float _secret = 0.3f;",
        "        public float CoyoteSeconds => _secret;",
        "        public int Jumps { get; private set; }",
        '        public bool TryJump(int playerId) { Debug.Log("SECRET_BODY"); return true; }',
        "        internal void Hidden() { }",
        // Braces that open no block: an interpolation hole, an expression body's initializer.
        '        public void PlayLevel(int level) => Debug.Log($"level_{level}_{(level > 1 ? "x" : "y")}");',
        '        public static string[] Keys() => new[] { "a", "b" };',
        "        public int[] Defaults => new[] { 1, 2 };",
        "    }",
        "    public enum JumpState { Grounded, Airborne }",
        "    public record JumpEvent(int PlayerId, float Height);",
        "    public static class JumpLimits { public static readonly int[] PerLevel = { 1, 2 }; }",
        "    public delegate void Landed(int playerId, float height);",
        "    internal delegate void HiddenDelegate();",
        "}",
      ].join("\n"),
    );
    put(root, "Assets/Modules/Jump/Tests/Jump.Tests.asmdef", asmdef("Game.Jump.Tests", { defineConstraints: ["UNITY_INCLUDE_TESTS"] }));
    put(root, "Assets/Modules/Jump/Tests/JumpTests.cs", "namespace Game.Jump.Tests { public class WorkerTestMarker { public void T() { } } }");
    put(root, "Assets/Modules/Jump/Editor/JumpEditor.cs", "namespace Game.Jump { public class EditorMarker { } }");
    put(root, "Assets/Scripts/Loose.cs", "namespace Game { public class AssemblyCSharpMarker { } }");

    const digest = publicSurfaceDigest(root, requirementTokens("Jump rules"));
    expect(digest).toContain("public interface global::Game.Jump.IJumpRules");
    expect(digest).toContain("float CoyoteSeconds { get; }");
    expect(digest).toContain("bool TryJump(int playerId)");
    expect(digest).toContain("public sealed class global::Game.Jump.JumpRules : IJumpRules");
    expect(digest).toContain("public int Jumps { get; }");
    expect(digest).toContain("public enum global::Game.Jump.JumpState { Grounded, Airborne }");
    expect(digest).toContain("public record global::Game.Jump.JumpEvent(int PlayerId, float Height)");
    expect(digest).toContain("  public static readonly int[] PerLevel\n");
    expect(digest).toContain("public delegate void global::Game.Jump.Landed(int playerId, float height)");
    expect(digest).toContain("  public void PlayLevel(int level)\n  public static string[] Keys()\n  public int[] Defaults { get; }\n");
    expect(digest).toContain("public enum global::Strada.Core.Play.PlaythroughOutcome");
    for (const absent of ["SECRET_BODY", "_secret", "Hidden", "WorkerTestMarker", "EditorMarker", "AssemblyCSharpMarker", "0.3f"]) {
      expect(digest, absent).not.toContain(absent);
    }
  });

  it("ranks the types a row is about first, and discloses what the cap left out", () => {
    const root = project();
    put(root, "Assets/Game/Game.asmdef", asmdef("Game.Runtime"));
    for (let i = 0; i < 40; i++) put(root, `Assets/Game/Filler${i}.cs`, `namespace Game { public class Filler${i} { public int Value${i} { get; set; } } }`);
    put(root, "Assets/Game/Lives.cs", "namespace Game { public class LivesCounter { public int Lives { get; } } }");
    const digest = publicSurfaceDigest(root, requirementTokens("The player starts with three lives."), 1200);
    expect(digest.length).toBeLessThanOrEqual(1200);
    expect(digest).toContain("Game.LivesCounter");
    expect(digest).toMatch(/more type\(s\) not shown/);
  });
});

describe("detectInputInjection", () => {
  it("routes through the Input System when the package is present and the new input handling is on", () => {
    const root = project();
    put(root, "Packages/manifest.json", JSON.stringify({ dependencies: { "com.unity.inputsystem": "1.11.2", "com.unity.ugui": "2.0.0" } }));
    put(root, "ProjectSettings/ProjectSettings.asset", "PlayerSettings:\n  activeInputHandler: 2\n");
    expect(detectInputInjection(root)).toMatchObject({ route: "input-system", inputSystemPackage: true, ugui: true, activeInputHandler: "both" });
  });

  it("falls back to EventSystem pointer events when only the old input manager is on", () => {
    const root = project();
    put(root, "Packages/manifest.json", JSON.stringify({ dependencies: { "com.unity.inputsystem": "1.11.2", "com.unity.ugui": "2.0.0" } }));
    put(root, "ProjectSettings/ProjectSettings.asset", "PlayerSettings:\n  activeInputHandler: 0\n");
    expect(detectInputInjection(root)).toMatchObject({ route: "event-system", activeInputHandler: "old" });
  });

  it("says when no input can be injected at all", () => {
    const root = project();
    put(root, "Packages/manifest.json", JSON.stringify({ dependencies: {} }));
    expect(detectInputInjection(root).route).toBe("none");
    expect(harnessApiDoc(detectInputInjection(root))).toMatch(/no input can be injected/i);
  });
});
