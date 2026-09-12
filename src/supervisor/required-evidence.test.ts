import { describe, expect, it } from "vitest";
import { summarizeToolArgs } from "../agents/orchestrator-tool-execution.js";
import { describeEvidenceShortfall, missingRequiredEvidence, requiredToolsInPrompt, requiredToolArguments, thresholdLoopTools, REQUIRED_EVIDENCE_PREFIX } from "./required-evidence.js";

describe("required evidence named by the task", () => {
  it("the trace's argument copy is capped, deep-redacted, and never throws (Codex 2026-09-11 D#1, D#15, D#16)", () => {
    const summary = summarizeToolArgs({
      sessions: "all",
      apiKey: "sk-should-never-appear",
      prompt: "x".repeat(200),
      nested: { a: 1 },
      nothing: null,
    });
    expect(summary).toContain('"sessions":"all"');
    expect(summary).not.toContain("sk-should-never-appear");
    expect(summary).toContain("<redacted>");
    expect(summary).not.toContain("nothing");
    // NESTED credentials, and credentials inside ordinary values (D#1).
    const nested = summarizeToolArgs({
      headers: { Authorization: "OPAQUE-NESTED-CREDENTIAL-0001" },
      env: [{ name: "API_KEY", value: "sk-FAKE-SECRET-VALUE-5678" }],
      command: "curl --token FAKE-SECRET-VALUE-9012 https://x",
    })!;
    expect(nested).not.toContain("OPAQUE-NESTED-CREDENTIAL-0001");
    expect(nested).not.toContain("FAKE-SECRET-VALUE-5678");
    expect(nested).not.toContain("FAKE-SECRET-VALUE-9012");
    // Every field stays parseable, however many there are (D#15).
    const many: Record<string, unknown> = { sessions: "all" };
    for (let i = 0; i < 8; i++) many[`field${i}`] = "y".repeat(60);
    const parsed = JSON.parse(summarizeToolArgs(many)!) as Record<string, string>;
    expect(parsed["sessions"]).toBe("all");
    // Exotic input is recorded as nothing rather than thrown (D#16).
    const circular: Record<string, unknown> = {};
    circular["self"] = { back: circular };
    expect(() => summarizeToolArgs(circular)).not.toThrow();
    expect(() => summarizeToolArgs({ nested: { n: 1n } })).not.toThrow();
    expect(() => summarizeToolArgs({ nested: { toJSON() { return undefined; } } })).not.toThrow();
    expect(summarizeToolArgs(undefined)).toBeUndefined();
    expect(summarizeToolArgs({})).toBeUndefined();
  });

  it("a tool that ran the WRONG way is not evidence (Codex 2026-09-11, review B #13 residue)", () => {
    const prompt = 'Prove the levels: run unity_playthrough with sessions "all" and report the catalog.';
    expect(requiredToolArguments(prompt)).toEqual([{ tool: "unity_playthrough", key: "sessions", value: "all" }]);
    // Ran, but with one session: the task asked for all of them.
    const narrow = missingRequiredEvidence(prompt, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "1" }) },
    ]);
    expect(narrow).toEqual([{ tool: "unity_playthrough", attempts: 1, argument: { key: "sessions", value: "all" } }]);
    expect(describeEvidenceShortfall(narrow)).toContain('with sessions "all"');
    // Ran the way the task named it.
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "all" }) },
    ])).toEqual([]);
    // A CALL WITH NO RECORDED ARGUMENTS cannot show the task's own argument:
    // accepting it let `sessions: "all"` pass on a run that never said so
    // (Codex 2026-09-11 M#2). A unity tool called with arguments always
    // records them; no arguments means it was called with none.
    expect(missingRequiredEvidence(prompt, [{ toolName: "unity_playthrough", success: true }]))
      .toEqual([{ tool: "unity_playthrough", attempts: 1, argument: { key: "sessions", value: "all" } }]);
    // An ordinary mention manufactures no requirement.
    expect(requiredToolArguments('unity_playthrough is a tool; the scene is named "Main".')).toEqual([]);
  });

  it("the argument gate is narrow, same-call, and knows the unfiltered flag (Codex 2026-09-11 D#9-11, D#14)", () => {
    // Prose does not invent requirements…
    expect(requiredToolArguments('Run unity_playthrough and report "all good".')).toEqual([]);
    expect(requiredToolArguments('Run unity_playthrough with {"sessions":"all"}')).toEqual([]);
    // …and another tool's argument does not travel to this one.
    expect(requiredToolArguments('Run unity_playthrough with sessions "all", then use unity_build_player with target "android".'))
      .toEqual([
        { tool: "unity_playthrough", key: "sessions", value: "all" },
        { tool: "unity_build_player", key: "target", value: "android" },
      ]);

    // ONE call must satisfy EVERY named argument (D#10).
    const two = 'run unity_playthrough with sessions "all" and mode "fast"';
    expect(missingRequiredEvidence(two, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "all", mode: "slow" }) },
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "1", mode: "fast" }) },
    ])).toHaveLength(1);
    expect(missingRequiredEvidence(two, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "all", mode: "fast" }) },
    ])).toEqual([]);

    // "FULL suite UNFILTERED" is a requirement (D#11).
    const unfiltered = "Run the FULL PlayMode suite UNFILTERED using unity_test_run.";
    expect(requiredToolArguments(unfiltered)).toEqual([{ tool: "unity_test_run", key: "unfiltered", value: "true" }]);
    expect(missingRequiredEvidence(unfiltered, [
      { toolName: "unity_test_run", success: true, args: JSON.stringify({ filter: "Smoke" }) },
    ])).toHaveLength(1);
    expect(missingRequiredEvidence(unfiltered, [
      { toolName: "unity_test_run", success: true, args: JSON.stringify({ scene: "Main" }) },
    ])).toEqual([]);
  });

  it("names the tool whatever verb the sentence uses (Codex 2026-09-11 B#13)", () => {
    expect(requiredToolsInPrompt("execute unity_playthrough when the scene loads")).toEqual(["unity_playthrough"]);
    expect(requiredToolsInPrompt("run the full PlayMode suite using unity_test_run")).toEqual(["unity_test_run"]);
    expect(requiredToolsInPrompt("prove it via unity_build_player")).toEqual(["unity_build_player"]);
    expect(requiredToolsInPrompt("call unity_verify_change first")).toEqual(["unity_verify_change"]);
    expect(requiredToolsInPrompt("unity_playthrough is a tool that exists")).toEqual([]);
  });

  const prompt = "Register the driver. Then run unity_verify_change, then run unity_playthrough (no arguments) and report its verdict VERBATIM. Run the unity_build_player afterwards.";

  it("reads the tools the prompt tells the worker to run", () => {
    expect(requiredToolsInPrompt(prompt)).toEqual(["unity_verify_change", "unity_playthrough", "unity_build_player"]);
    expect(requiredToolsInPrompt("Bind sprites with unity_bind_sprite and commit.")).toEqual([]);
  });

  it("a required tool with no successful call is a shortfall — never ran, or ran and failed", () => {
    const trace = [
      { toolName: "file_edit", success: true },
      { toolName: "unity_verify_change", success: true },
      { toolName: "unity_playthrough", success: false },
      { toolName: "unity_playthrough", success: false },
    ];
    expect(missingRequiredEvidence(prompt, trace)).toEqual([
      { tool: "unity_playthrough", attempts: 2 },
      { tool: "unity_build_player", attempts: 0 },
    ]);
    expect(describeEvidenceShortfall(missingRequiredEvidence(prompt, trace))).toBe(
      "REQUIRED EVIDENCE MISSING: the task says run unity_playthrough; 2 run(s), none ok; the task says run unity_build_player; it never ran in this node — the result is not done whatever the report says.",
    );
    expect(missingRequiredEvidence(prompt, [...trace, { toolName: "unity_playthrough", success: true }, { toolName: "unity_build_player", success: true }])).toEqual([]);
  });
});

describe("a tool the situation does not call for is not missing evidence (measured live 2026-09-11)", () => {
  // The real mission, shortened: a batch procedure that repeats until a
  // measured count is below a threshold. The count was already 0, so the run
  // correctly generated nothing — and this gate failed the node every round
  // for hours, retrying a mission whose goal was already met.
  const loop =
    "Mission: replace placeholder art IN PLACE, in batches. Each batch is ONE unit of work: call unity_delivery_measure once " +
    "and take the first 24 placeholder paths it lists; then call unity_generate_sprite exactly TWICE, each call with `batch` " +
    "holding 12 items; then call unity_delivery_measure again and report the new number. " +
    "Repeat batches until the measured count is below 200, then finish with the count you MEASURED.";

  it("accepts a node that measured and found nothing to do", () => {
    const measuredOnly = [{ toolName: "unity_delivery_measure", success: true }];
    expect(missingRequiredEvidence(loop, measuredOnly)).toEqual([]);
  });

  it("still rejects a node that ran NONE of the tools it was told to", () => {
    expect(missingRequiredEvidence(loop, []).map((s) => s.tool).sort())
      .toEqual(["unity_delivery_measure", "unity_generate_sprite"]);
    expect(missingRequiredEvidence(loop, [{ toolName: "git_status", success: true }])).toHaveLength(2);
  });

  it("leaves an ordinary instruction demanding every tool it names", () => {
    const plain = "Run unity_verify_change, then run unity_playthrough and report its verdict.";
    expect(missingRequiredEvidence(plain, [{ toolName: "unity_verify_change", success: true }]).map((s) => s.tool))
      .toEqual(["unity_playthrough"]);
    // …and a timing clause is not a condition (Codex 2026-09-11 B#13 stands).
    expect(requiredToolsInPrompt("execute unity_playthrough when the scene loads")).toEqual(["unity_playthrough"]);
    // An explicitly conditional instruction is not a demand.
    expect(requiredToolsInPrompt("If the scene is empty, run unity_bind_sprite to fix it.")).toEqual([]);
    expect(requiredToolsInPrompt("Run unity_playthrough as needed.")).toEqual([]);
  });
});

describe("prose formatting does not defeat the evidence gate (Codex 2026-09-11 M#2)", () => {
  it("reads a tool name written as code", () => {
    expect(requiredToolsInPrompt('Run `unity_playthrough` with sessions "all".')).toEqual(["unity_playthrough"]);
    expect(requiredToolsInPrompt('Run **unity_verify_change** before reporting.')).toEqual(["unity_verify_change"]);
  });

  it("an unconditional instruction outranks a later conditional one", () => {
    // "Run X. If it fails, run X again." required nothing at all: the second
    // sentence deleted the first.
    expect(requiredToolsInPrompt("Run unity_playthrough. If it fails, run unity_playthrough again."))
      .toEqual(["unity_playthrough"]);
    // …and a tool named ONLY conditionally is still not demanded.
    expect(requiredToolsInPrompt("If the scene is empty, run unity_bind_sprite to fix it.")).toEqual([]);
  });

  it("a threshold loop waives its OWN tools, not the work beside it", () => {
    const prompt =
      "Replace placeholder art in batches: call unity_delivery_measure, then call unity_generate_sprite twice. " +
      "Repeat until the measured count is below 200.\n\n" +
      "Then run unity_build_player for Android and report its artifact.";

    // The loop measured and found nothing to do — but the build was not run.
    expect(missingRequiredEvidence(prompt, [{ toolName: "unity_delivery_measure", success: true }]).map((s) => s.tool))
      .toEqual(["unity_build_player"]);
  });
});

describe("two calls are not one call (Codex 2026-09-12 P#3)", () => {
  const twoBuilds = 'Run unity_build_player with target "Android". Run unity_build_player with target "iOS".';

  it("accepts one call per named value of the same argument", () => {
    // Requiring a single call to satisfy every named argument demanded one
    // build whose target was Android AND iOS at once, and an honest two-call
    // run failed the gate.
    expect(missingRequiredEvidence(twoBuilds, [
      { toolName: "unity_build_player", success: true, args: JSON.stringify({ target: "Android" }) },
      { toolName: "unity_build_player", success: true, args: JSON.stringify({ target: "iOS" }) },
    ])).toEqual([]);
  });

  it("still names the value nobody built", () => {
    const missing = missingRequiredEvidence(twoBuilds, [
      { toolName: "unity_build_player", success: true, args: JSON.stringify({ target: "Android" }) },
    ]);
    expect(missing).toEqual([{ tool: "unity_build_player", attempts: 1, argument: { key: "target", value: "iOS" } }]);
  });

  it("different KEYS must still meet in one call (D#10 stands)", () => {
    const prompt = 'Run the full suite UNFILTERED using unity_test_run with filter "all".';
    // Two calls, each satisfying one of the two demands, is the combination
    // nobody made.
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_test_run", success: true, args: JSON.stringify({ filter: "all" }) },
      { toolName: "unity_test_run", success: true, args: JSON.stringify({ unfiltered: true }) },
    ])).toHaveLength(1);
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_test_run", success: true, args: JSON.stringify({ filter: "all", unfiltered: true }) },
    ])).toEqual([]);
  });
});

describe("one parser, clause scope, and a prompt that states its own evidence (Codex 2026-09-12 P#4)", () => {
  it("reads an argument beside a CODE-FORMATTED tool name", () => {
    // The tool matcher learned backticks and the argument matcher did not, so
    // a `sessions: "smoke"` call passed a prompt that asked for "all".
    const prompt = 'Run `unity_playthrough` with sessions "all".';
    expect(requiredToolsInPrompt(prompt)).toEqual(["unity_playthrough"]);
    expect(requiredToolArguments(prompt)).toEqual([{ tool: "unity_playthrough", key: "sessions", value: "all" }]);
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "smoke" }) },
    ])).toEqual([{ tool: "unity_playthrough", attempts: 1, argument: { key: "sessions", value: "all" } }]);
  });

  it("a conditional CLAUSE does not govern the unconditional one beside it", () => {
    // "Run X; if it fails, run X again." required nothing: the whole line was
    // judged conditional because only "." and newline ended a sentence.
    expect(requiredToolsInPrompt("Run unity_playthrough; if it fails, run unity_playthrough again."))
      .toEqual(["unity_playthrough"]);
    // …and a genuinely conditional instruction is still not demanded.
    expect(requiredToolsInPrompt("If the scene fails to load; run unity_playthrough again")).toEqual([]);
  });

  it("a threshold loop waives its own body, not the work written after it", () => {
    const prompt =
      "Call unity_generate_sprite for each placeholder and repeat batches until the measured count is below 200. " +
      "Then run unity_build_player for the GDD's platform.";
    expect(thresholdLoopTools(prompt)).toEqual(new Set(["unity_generate_sprite"]));
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_generate_sprite", success: true, args: "{}" },
    ])).toEqual([{ tool: "unity_build_player", attempts: 0 }]);
  });

  it("a prompt may state its evidence outright, in any language", () => {
    const prompt =
      "Exécutez unity_playthrough avec toutes les sessions.\n\n" +
      `${REQUIRED_EVIDENCE_PREFIX} unity_playthrough sessions="all"; unity_build_player`;
    expect(requiredToolsInPrompt(prompt).sort()).toEqual(["unity_build_player", "unity_playthrough"]);
    expect(requiredToolArguments(prompt)).toEqual([{ tool: "unity_playthrough", key: "sessions", value: "all" }]);
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_playthrough", success: true, args: JSON.stringify({ sessions: "all" }) },
      { toolName: "unity_build_player", success: true, args: "{}" },
    ])).toEqual([]);
  });

  it("a declared requirement is not waived by a threshold loop", () => {
    const prompt =
      "Call unity_generate_sprite, then call unity_build_player, and repeat until the placeholder count is below 200.\n\n" +
      `${REQUIRED_EVIDENCE_PREFIX} unity_build_player`;
    // The loop body DID measure — one of its tools ran — so the loop's own
    // tools are waived. The declared one is not one of them.
    expect(missingRequiredEvidence(prompt, [
      { toolName: "unity_generate_sprite", success: true, args: "{}" },
    ])).toEqual([{ tool: "unity_build_player", attempts: 0 }]);
  });
});
