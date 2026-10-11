/**
 * The system's acceptance files (GDD-drift plan W05).
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
    text: "Coyote time is 0.25–0.5 s.",
    kind: "range",
    bounds: { kind: "range", lo: 0.25, hi: 0.5, unit: "s" },
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

const goodRuleCheck: AcceptanceCheckBody = {
  rid: "req-007-a1b2c3d4e5f6",
  setup: "yield return StartSessionForSetup(1);",
  body: "yield return Until(() => Driver.Outcome != PlaythroughOutcome.None, 95f);\nAssert.That(Driver.Outcome, Is.EqualTo(PlaythroughOutcome.Won));",
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
        "using System.Collections;",
        "using System.Collections.Generic;",
        "using System.Linq;",
        "using NUnit.Framework;",
        "using UnityEngine;",
        "using UnityEngine.TestTools;",
        "using Strada.Core.Play;",
        "",
        "namespace Strada.Acceptance.M1",
        "{",
        '    [TestFixture, Category("StradaAcceptance")]',
        "    public sealed class Acceptance_M1 : global::Strada.Acceptance.AcceptanceFixture",
        "    {",
        "        // REQ req-007-a1b2c3d4e5f6 — The player must reach the exit within 90 seconds.",
        "        [UnityTest, Timeout(120000)]",
        "        public IEnumerator R007_a1b2c3()",
        "        {",
        "            yield return Boot();",
        "            yield return StartSessionForSetup(1);",
        "            yield return Until(() => Driver.Outcome != PlaythroughOutcome.None, 95f);",
        "            Assert.That(Driver.Outcome, Is.EqualTo(PlaythroughOutcome.Won));",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    expect(rendered.sha256).toBe(sha256(rendered.source));
    expect(rendered.tests).toEqual([
      { rid: "req-007-a1b2c3d4e5f6", testName: "Strada.Acceptance.M1.Acceptance_M1.R007_a1b2c3", bodySha: checkBodySha(goodRuleCheck) },
    ]);
    expect(isAcceptanceTestName(rendered.tests[0]!.testName)).toBe(true);
  });

  it("asserts a constant or range row against the row's bounds — the model supplies only the observation", () => {
    const check: AcceptanceCheckBody = {
      rid: "req-012-0123456789ab",
      setup: "yield return StartSessionForSetup(1);",
      // The model's own numbers inside its observation must not become the assertion.
      observe: "Service<Game.Movement.IJumpRules>().CoyoteSeconds * 1.0",
    };
    const { source } = renderAcceptanceFile("m2", [{ row: constantRow(), check }]);
    expect(source).toContain("            var observed = (double)(Service<Game.Movement.IJumpRules>().CoyoteSeconds * 1.0);");
    expect(source).toContain('            Assert.That(observed, Is.InRange(0.25d, 0.5d), "req-012-0123456789ab: Coyote time is 0.25–0.5 s.");');
    // Exactly one assertion, and it is the system's.
    expect(source.match(/Assert\./g)).toHaveLength(1);
  });

  it("writes exact values with the row's tolerance and one-sided or exclusive bounds as NUnit constraints", () => {
    const exact = row({ rid: "req-001-aaaaaaaaaaaa", kind: "constant", text: "Fire rate is 12/s.", bounds: { kind: "exact", value: 12, tolerance: 0.01 } });
    const atLeast = row({ rid: "req-002-bbbbbbbbbbbb", kind: "range", text: "At least 3 lives.", bounds: { kind: "range", lo: 3 } });
    const below = row({ rid: "req-003-cccccccccccc", kind: "range", text: "Under 2 s, over 1 s.", bounds: { kind: "range", lo: 1, hi: 2, loExclusive: true, hiExclusive: true } });
    const { source } = renderAcceptanceFile("m3", [
      { row: exact, check: { rid: exact.rid, observe: "Service<Game.IRates>().Fire" } },
      { row: atLeast, check: { rid: atLeast.rid, observe: "Service<Game.ILives>().Count" } },
      { row: below, check: { rid: below.rid, observe: "Service<Game.ITimer>().Seconds" } },
    ]);
    expect(source).toContain("Is.EqualTo(12d).Within(0.01d)");
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
    const { source } = renderAcceptanceFile("m4", [{ row: tricky, check: { rid: tricky.rid, observe: "Service<Game.ISpeed>().Max" } }]);
    // Every line of the verbatim text stays a comment line.
    expect(source).toContain('        // REQ req-004-dddddddddddd — Speed "max" is 5\\s\n        //     line two\n        //     Assert.Pass();');
    expect(source).toContain('"req-004-dddddddddddd: Speed \\"max\\" is 5\\\\s\\nline two\\u2028Assert.Pass();"');
    expect(source.split("\n").filter((l) => /^\s*Assert\.Pass/.test(l))).toEqual([]);
  });

  it("chooses unique names in a file and names the file after the milestone, deterministically", () => {
    const a = row({ rid: "req-010-abcdef000001", span: { start: 10, end: 20 } });
    const b = row({ rid: "req-010-abcdef000002", span: { start: 30, end: 40 } });
    const tests = [
      { row: b, check: { rid: b.rid, body: "Assert.That(Driver.IsSessionActive, Is.False);" } },
      { row: a, check: { rid: a.rid, body: "Assert.That(Driver.IsSessionActive, Is.False);" } },
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
    expect(() => renderAcceptanceFile("m1", [{ row: constantRow(), check: { rid: constantRow().rid, body: "Assert.That(1, Is.EqualTo(1));" } }])).toThrow(/observe/);
    expect(() => renderAcceptanceFile("m1", [{ row: row(), check: { ...goodRuleCheck, rid: "req-999-000000000000" } }])).toThrow(/rid/);
    expect(() => renderAcceptanceFile("m1", [{ row: row(), check: goodRuleCheck }, { row: row(), check: goodRuleCheck }])).toThrow(/twice/);
  });
});

// =============================================================================
// THE LINT
// =============================================================================

describe("lintAcceptanceBody", () => {
  const lint = (body: string, over: Partial<RequirementRow> = {}, extra: Partial<AcceptanceCheckBody> = {}) =>
    lintAcceptanceBody(row(over), { rid: row(over).rid, body, ...extra });

  it("accepts a body that observes the game and asserts on it", () => {
    expect(lintAcceptanceBody(row(), goodRuleCheck)).toEqual({ ok: true, problems: [] });
  });

  it("rejects the exact P1 guardrail shape: an assertion on reflection alone", () => {
    const result = lint("Assert.That(typeof(IX).GetMethods().Length, Is.EqualTo(1));");
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/reflection/);
  });

  it("rejects reflection laundered through a local, a type-name comparison, and a literal-only assertion", () => {
    expect(lint("var n = typeof(Game.IX).GetInterfaces().Length;\nAssert.That(n, Is.GreaterThan(0));").ok).toBe(false);
    expect(lint('Assert.AreEqual("Mover", Service<Game.IMover>().GetType().Name);').ok).toBe(false);
    expect(lint("Assert.IsTrue(typeof(Game.IMover).IsAssignableFrom(Service<Game.IMover>().GetType()));").ok).toBe(false);
    const literal = lint("Assert.That(2 + 2, Is.EqualTo(4));");
    expect(literal.ok).toBe(false);
    expect(literal.problems.join("\n")).toMatch(/literal/);
  });

  it.each([
    ["Assert.Pass", "Assert.Pass();"],
    ["Assert.Ignore", 'Assert.Ignore("later");'],
    ["Assert.Inconclusive", "Assert.Inconclusive();"],
    ["Assume", "Assume.That(Driver.IsSessionActive);\nAssert.That(Driver.IsSessionActive);"],
    ["catch", "try { Assert.That(Driver.IsSessionActive); } catch (System.Exception) { }"],
    ["#if", "#if UNITY_EDITOR\nAssert.That(Driver.IsSessionActive);\n#endif"],
    ["System.IO", 'System.IO.File.WriteAllText("x", "y");\nAssert.That(Driver.IsSessionActive);'],
    ["Process", 'System.Diagnostics.Process.Start("sh");\nAssert.That(Driver.IsSessionActive);'],
    [".Act(", "Service<Game.IDriverLike>().Act();\nAssert.That(Driver.Outcome, Is.EqualTo(PlaythroughOutcome.Won));"],
    ["IPlaythroughDriver", "var d = Service<IPlaythroughDriver>();\nAssert.That(d.Phase, Is.EqualTo(\"Playing\"));"],
    ["[Category]", '[Category("x")] void Local() { }\nAssert.That(Driver.IsSessionActive);'],
    ["[Ignore]", '[NUnit.Framework.Ignore("x")] void Local() { }\nAssert.That(Driver.IsSessionActive);'],
    ["yield break", "if (!Driver.IsSessionActive) yield break;\nAssert.That(Driver.IsSessionActive);"],
    ["ignoreFailingMessages", "UnityEngine.TestTools.LogAssert.ignoreFailingMessages = true;\nAssert.That(Driver.IsSessionActive);"],
    // What Assert.Pass and Assert.Ignore throw ends the test the same way.
    ["SuccessException", 'if (Driver.IsSessionActive) throw new NUnit.Framework.SuccessException("ok");\nAssert.That(Driver.IsSessionActive);'],
    ["IgnoreException", 'throw new IgnoreException("later");'],
    ["UnityEditor", "UnityEditor.EditorApplication.isPlaying = false;\nAssert.That(Driver.IsSessionActive);"],
  ])("rejects %s", (_name, body) => {
    const result = lint(body);
    expect(result.ok, body).toBe(false);
  });

  it("does not mistake a forbidden word inside a string or a comment for code", () => {
    const result = lint('// Assert.Pass would be wrong here; catch nothing\nAssert.That(Driver.Phase, Is.Not.EqualTo("Assert.Pass catch #if"));');
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it("rejects a body that escapes its method or does not assert at all", () => {
    expect(lint("Assert.That(Driver.IsSessionActive); }\n[UnityTest] public System.Collections.IEnumerator Extra() { yield return null;").ok).toBe(false);
    const none = lint("yield return Frames(3);");
    expect(none.ok).toBe(false);
    expect(none.problems.join("\n")).toMatch(/assert/i);
  });

  it("rejects a harness coroutine that is called but not yielded (it would never run)", () => {
    const result = lint("TapViewport(0.5f, 0.5f);\nAssert.That(Driver.IsSessionActive);", { kind: "input" });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/TapViewport.*yield return/);
  });

  it("an input row must act through the harness's Tap/Drag/Press, and must not start the session itself", () => {
    const input = { kind: "input" as const, text: "The player taps to jump." };
    const noTap = lint("Service<Game.IJumper>().Jump();\nyield return Frames(2);\nAssert.That(Service<Game.IJumper>().Airborne);", input);
    expect(noTap.ok).toBe(false);
    expect(noTap.problems.join("\n")).toMatch(/Tap/);
    const starts = lint("yield return StartSessionForSetup(1);\nyield return TapViewport(0.5f, 0.5f);\nAssert.That(Service<Game.IJumper>().Airborne);", input);
    expect(starts.ok).toBe(false);
    expect(starts.problems.join("\n")).toMatch(/StartSession/);
    const good = lint("yield return TapViewport(0.5f, 0.5f);\nyield return Frames(2);\nAssert.That(Service<Game.IJumper>().Airborne, Is.True);", input);
    expect(good).toEqual({ ok: true, problems: [] });
  });

  it("a numeric row takes an observation only; its observation must read the game", () => {
    const r = constantRow();
    expect(lintAcceptanceBody(r, { rid: r.rid, observe: "Service<Game.IJumpRules>().CoyoteSeconds" })).toEqual({ ok: true, problems: [] });
    expect(lintAcceptanceBody(r, { rid: r.rid, body: "Assert.That(Service<Game.IJumpRules>().CoyoteSeconds, Is.EqualTo(0.3));" }).ok).toBe(false);
    expect(lintAcceptanceBody(r, { rid: r.rid, observe: "0.3" }).ok).toBe(false);
    expect(lintAcceptanceBody(r, { rid: r.rid, observe: "1; Assert.Pass(); var x = (0" }).ok).toBe(false);
  });

  it("caps a body at 80 lines", () => {
    const long = Array.from({ length: 80 }, () => "yield return Frames(1);").join("\n") + "\nAssert.That(Driver.IsSessionActive);";
    expect(lint(long).ok).toBe(false);
  });
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
      "IEnumerator TapScreen(Vector2 position)",
      "IEnumerator TapObject(GameObject target)",
      "IEnumerator Drag(Vector2 from, Vector2 to, float seconds = 0.25f)",
      "IEnumerator Press(string key)",
    ]) {
      expect(ACCEPTANCE_FIXTURE_SOURCE, member).toContain(member);
      expect(harnessApiDoc(), member).toContain(member);
    }
    // The read-only driver view never offers the driver's own action.
    expect(ACCEPTANCE_FIXTURE_SOURCE).not.toMatch(/\.Act\s*\(/);
    expect(ACCEPTANCE_FIXTURE_SOURCE).toContain("GameBootstrapper.Services");
    expect(ACCEPTANCE_FIXTURE_SOURCE).toContain("SceneManager.LoadSceneAsync(0, LoadSceneMode.Single)");
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
    // Measured in a Unity 6000.3 PlayMode run: without this every injected tap, drag and key press was dropped.
    const boot = ACCEPTANCE_FIXTURE_SOURCE.slice(ACCEPTANCE_FIXTURE_SOURCE.indexOf("protected IEnumerator Boot()"));
    expect(boot.indexOf("EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView")).toBeGreaterThan(0);
    expect(boot.indexOf("EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView")).toBeLessThan(boot.indexOf("LoadSceneAsync"));
    expect(boot).toContain("InputSettings.BackgroundBehavior.IgnoreFocus");
    // The project's settings asset is swapped for a copy, never edited.
    expect(boot).toContain("UnityEngine.Object.Instantiate(current)");
    expect(ACCEPTANCE_FIXTURE_SOURCE).toMatch(/\[TearDown\]\s*public void RestoreHarnessState\(\)[\s\S]*InputSystem\.settings = _projectInputSettingsAsset;/);
    // A scene that never loads is the harness's fault, not a test timeout.
    expect(boot).toContain('HarnessFault("no-scene", "build scene 0 did not finish loading in "');
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
    writeFileSync(join(root, source.path), source.source.replace("Is.EqualTo(PlaythroughOutcome.Won)", "Is.Not.Null"));
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
    const before = storedSource("m1", [{ row: row(), check: { ...goodRuleCheck, body: "Assert.That(Driver.Outcome, Is.Not.EqualTo(PlaythroughOutcome.Lost));" } }]);
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

  it("still calls an edit tamper when the editor kept the stamp line, or hand-wrote an asmdef", () => {
    const { root, source, harness } = setUp();
    // The stamp line kept, the assertion weakened under it.
    writeFileSync(join(root, source.path), source.source.replace("Is.EqualTo(PlaythroughOutcome.Won)", "Is.Not.Null"));
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
    expect(digest).toContain("public interface Game.Jump.IJumpRules");
    expect(digest).toContain("float CoyoteSeconds { get; }");
    expect(digest).toContain("bool TryJump(int playerId)");
    expect(digest).toContain("public sealed class Game.Jump.JumpRules : IJumpRules");
    expect(digest).toContain("public int Jumps { get; }");
    expect(digest).toContain("public enum Game.Jump.JumpState { Grounded, Airborne }");
    expect(digest).toContain("public record Game.Jump.JumpEvent(int PlayerId, float Height)");
    expect(digest).toContain("  public static readonly int[] PerLevel\n");
    expect(digest).toContain("public delegate void Game.Jump.Landed(int playerId, float height)");
    expect(digest).toContain("  public void PlayLevel(int level)\n  public static string[] Keys()\n  public int[] Defaults { get; }\n");
    expect(digest).toContain("Strada.Core.Play");
    expect(digest).toContain("PlaythroughOutcome");
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
