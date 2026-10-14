import { describe, expect, it, vi } from "vitest";
import { CampaignPlanner, namesContent } from "./campaign-planner.js";

/**
 * Measured live 2026-09-03 08:33: one malformed reply skipped the GDD
 * coverage check for the whole delivery ("delivered WITHOUT a clean
 * GDD-coverage check"). The shape is worth one retry; the judgement is not.
 */
describe("coverage audit malformed JSON", () => {
  function plannerWith(replies: string[]) {
    const chat = vi.fn(async () => ({ text: replies.shift() ?? "" }));
    // No chatStream → streamOrChatText falls to chat().
    const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
    return { planner: new CampaignPlanner(provider), chat };
  }

  it("asks once more when the first reply is not usable JSON", async () => {
    const { planner, chat } = plannerWith([
      "Sure! Here is what I found: the ladder covers everything.",
      '{"missing": ["Decompression stop: no milestone implemented it"]}',
    ]);

    const missing = await planner.auditCoverage("# GDD", [{ title: "Sprint A" }]);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat.mock.calls[1])).toContain("not valid JSON");
    expect(missing).toEqual(["Decompression stop: no milestone implemented it"]);
  });

  it("shows the audit what each sprint MEASURED, not its title (Codex 2026-09-12 R#15)", async () => {
    // "Only report an item as missing when no milestone's scope or result
    // plausibly includes it" — with a title and 300 characters of prose as the
    // whole input. A plan that mentioned an item read as coverage of it.
    const { planner, chat } = plannerWith(['{"missing": []}']);

    await planner.auditCoverage("# GDD\n\nEvery ascent pauses at a decompression stop.", [
      {
        title: "Sprint A — Ascent",
        status: "green",
        testVerdict: "PlayMode verification passed: 42 of 42 tests passed",
        testVerdictUnfiltered: true,
        commitNote: "3 commit(s): Assets/Scripts/DecompressionStop.cs, Assets/Prefabs/AscentLine.prefab",
        structureFindings: ["the shipped scenes reference 37 of 38 authored prefabs"],
        gddClaims: ["wreck site count = 33 measured 33"],
        resultExcerpt: "the decompression stop is implemented",
      },
      { title: "Sprint B — Nothing measured yet" },
    ]);

    const sent = JSON.stringify(chat.mock.calls[0]);
    expect(sent).toContain("status: green");
    expect(sent).toContain("suite: PlayMode verification passed");
    expect(sent).toContain("(unfiltered)");
    expect(sent).toContain("landed: 3 commit(s)");
    expect(sent).toContain("shipped tree: the shipped scenes reference 37 of 38");
    expect(sent).toContain("document numbers: wreck site count = 33");
    // A sprint with nothing measured says so, instead of passing as covered.
    expect(sent).toContain("(no evidence recorded)");
    // …and the instruction is evidence, not plausibility.
    expect(sent).toContain("TITLE or PLAN is not coverage");
    expect(sent).not.toContain("plausibly includes it");
  });

  it("gives up after the second malformed reply", async () => {
    const { planner, chat } = plannerWith(["not json", "still not json"]);
    await expect(planner.auditCoverage("# GDD", [{ title: "Sprint A" }])).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("reads the verdict past a leaked reasoning block on the first try", async () => {
    // Measured 2026-09-07: the audit extracted `{…}` from inside
    // "<reasoning>…</reasoning>" and delivered "WITHOUT a clean GDD-coverage
    // check" because of it.
    const { planner, chat } = plannerWith([
      '<reasoning>\nLet me weigh {"missing": "everything?"} first.\n</reasoning>\n{"missing":["Sonar log: no milestone made it"]}',
    ]);
    await expect(planner.auditCoverage("# GDD", [], "final report")).resolves.toEqual([
      "Sonar log: no milestone made it",
    ]);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

/**
 * A repair sprint that spent its attempts used to leave its requirement
 * "failed" for ever: nothing re-judged it, so delivery either stepped over
 * known missing work or could never be reached. Exhaustion stops the repair;
 * evidence closes the requirement (Codex 2026-09-12 U, Job 2.7).
 */
describe("the audit's full list survives (Codex 2026-09-12 W#10)", () => {
  function plannerWith(replies: string[]) {
    const chat = vi.fn(async () => ({ text: replies.shift() ?? "" }));
    const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
    return { planner: new CampaignPlanner(provider), chat };
  }

  it("keeps the thirty-first requirement the audit named", async () => {
    // The list was clamped to thirty, so requirement 31 never reached the
    // queue that exists to keep every one of them.
    const many = Array.from({ length: 31 }, (_, i) => `Req${i + 1}: absent`);
    const { planner } = plannerWith([JSON.stringify({ missing: many })]);
    const missing = await planner.auditCoverage("# GDD", [{ title: "Sprint A" }]);
    expect(missing).toHaveLength(31);
    expect(missing.at(-1)).toBe("Req31: absent");
  });
});

describe("re-judging the requirements no sprint closed", () => {
  function plannerWith(replies: string[]) {
    const chat = vi.fn(async () => ({ text: replies.shift() ?? "" }));
    const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
    return { planner: new CampaignPlanner(provider), chat };
  }

  const ladder = [
    {
      title: "Sprint A — Ascent",
      status: "green",
      commitNote: "3 commit(s): Assets/Scripts/DecompressionStop.cs, Assets/Prefabs/AscentLine.prefab",
    },
  ];

  it("closes a requirement the evidence shows, and asks about exactly the named ones", async () => {
    const { planner, chat } = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "landed: 3 commit(s): Assets/Scripts/DecompressionStop.cs"}, {"id": 2, "delivered": false}]}',
    ]);

    const judged = await planner.resolveCoverageGaps(
      "# GDD\n\nEvery ascent pauses at a decompression stop, and the dock posts a tide chart.",
      ["Decompression stop: no milestone implemented it", "Tide chart: absent"],
      ladder,
    );

    expect(judged.closed).toEqual(["Decompression stop: no milestone implemented it"]);
    expect(judged.open).toEqual(["Tide chart: absent"]);
    const sent = JSON.stringify(chat.mock.calls[0]);
    expect(sent).toContain("Decompression stop: no milestone implemented it");
    expect(sent).toContain("landed: 3 commit(s)");
  });

  it("a measured line closes only a requirement it is ABOUT: a suite total is not a save system (plan 0-B.3, AK#14)", async () => {
    // "67/67 tests passed (unfiltered)" is a measured, quotable line — and
    // it closed "Save progress across restarts". A blacklist cannot fix that:
    // the quote is held to a typed, requirement-specific predicate.
    const withSuite = [
      ...ladder,
      { title: "Sprint B — Tests", status: "green", testVerdict: "67/67 tests passed", testVerdictUnfiltered: true, commitNote: "1 commit(s): Assets/Art/Hero.png" },
    ];
    const { planner } = plannerWith([
      '{"verdicts": [' +
        '{"id": 1, "delivered": true, "evidence": "suite: 67/67 tests passed (unfiltered)"},' +
        '{"id": 2, "delivered": true, "evidence": "suite: 67/67 tests passed (unfiltered)"},' +
        '{"id": 3, "delivered": true, "evidence": "landed: 1 commit(s): Assets/Art/Hero.png"},' +
        '{"id": 4, "delivered": true, "evidence": "landed: 3 commit(s): Assets/Scripts/DecompressionStop.cs"}' +
      ']}',
    ]);
    const judged = await planner.resolveCoverageGaps(
      "# GDD",
      ["Save progress across restarts: absent", "The full test suite runs green: absent", "Tide chart: absent", "Decompression stop: no milestone implemented it"],
      withSuite,
    );
    // The suite total closes the requirement about the suite, and nothing else;
    // a hero sprite is not a tide chart; the decompression commit closes the stop.
    expect(judged.open).toEqual(["Save progress across restarts: absent", "Tide chart: absent"]);
    expect(judged.closed).toEqual(["The full test suite runs green: absent", "Decompression stop: no milestone implemented it"]);
  });

  it("a 'delivered' with nothing to point at, or no verdict at all, stays OPEN", async () => {
    // The default is the conservative one: this audit exists to stop prose
    // from closing a requirement, so a bare claim closes nothing.
    const { planner } = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true}, {"id": 2, "delivered": true, "evidence": "yes"}]}',
    ]);

    const judged = await planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent", "Tide chart: absent", "Save: absent"], ladder);

    expect(judged.closed).toEqual([]);
    expect(judged.open).toEqual(["Decompression stop: absent", "Tide chart: absent", "Save: absent"]);
  });

  it("invented prose closes nothing, and two verdicts for one id close nothing (Codex 2026-09-12 V#2)", async () => {
    // Executed by Codex: twelve characters of "The feature is definitely
    // done." closed an absent feature against a ladder with no evidence at
    // all — and a reply carrying both false and true for the same id closed
    // it on the positive one. The quote must exist in the record we sent.
    const invented = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "The feature is definitely done."}]}',
    ]);
    await expect(
      invented.planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent"], [{ title: "Sprint A" }]),
    ).resolves.toEqual({ closed: [], open: ["Decompression stop: absent"], unasked: [] });

    for (const reply of [
      '{"verdicts": [{"id": 1, "delivered": false}, {"id": 1, "delivered": true, "evidence": "landed: 3 commit(s): Assets/Scripts/DecompressionStop.cs"}]}',
      // …in either order: the positive one used to win whichever side it sat on.
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "landed: 3 commit(s): Assets/Scripts/DecompressionStop.cs"}, {"id": 1, "delivered": false}]}',
    ]) {
      const conflicting = plannerWith([reply]);
      await expect(
        conflicting.planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent"], ladder),
      ).resolves.toEqual({ closed: [], open: ["Decompression stop: absent"], unasked: [] });
    }

    // An id nobody asked about closes nothing either.
    const strayId = plannerWith([
      '{"verdicts": [{"id": 2, "delivered": true, "evidence": "landed: 3 commit(s): Assets/Scripts/DecompressionStop.cs"}]}',
    ]);
    await expect(
      strayId.planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent"], ladder),
    ).resolves.toEqual({ closed: [], open: ["Decompression stop: absent"], unasked: [] });
  });

  it("a sprint's STATUS closes nothing, nor does a suite of unknown scope (Codex 2026-09-12 AD#1)", async () => {
    // Reproduced by Codex: `{"verdicts":[{"id":1,"delivered":true,"evidence":
    // "status: failed"}]}` — fourteen characters that exist in every
    // milestone's record — closed "Save progress across restarts". A status
    // says how a sprint ENDED; it says nothing about this requirement. A
    // suite whose scope nobody knows says nothing about it either.
    const failedLadder = [{ title: "Sprint A — Save", status: "failed", coverageGap: "Save: absent" }];
    for (const evidence of ["status: failed", "status: green"]) {
      const quoted = plannerWith([`{"verdicts": [{"id": 1, "delivered": true, "evidence": "${evidence}"}]}`]);
      await expect(
        quoted.planner.resolveCoverageGaps("# GDD", ["Save: absent"], [{ ...failedLadder[0]!, status: evidence.slice(8) }]),
      ).resolves.toEqual({ closed: [], open: ["Save: absent"], unasked: [] });
    }

    const filtered = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "suite: 12 of 12 tests passed (FILTERED or unknown scope)"}]}',
    ]);
    await expect(
      filtered.planner.resolveCoverageGaps("# GDD", ["Save: absent"], [
        { title: "Sprint A", status: "green", testVerdict: "12 of 12 tests passed", testVerdictUnfiltered: false },
      ]),
    ).resolves.toEqual({ closed: [], open: ["Save: absent"], unasked: [] });

    // …and an UNFILTERED suite still counts as a measurement — of the SUITE:
    // it closes the requirement about the suite, and not the save system it
    // says nothing about (plan 0-B.3).
    const unfiltered = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "suite: 67 of 67 tests passed (unfiltered)"}, {"id": 2, "delivered": true, "evidence": "suite: 67 of 67 tests passed (unfiltered)"}]}',
    ]);
    await expect(
      unfiltered.planner.resolveCoverageGaps("# GDD", ["Save: absent", "The full test suite runs green: absent"], [
        { title: "Sprint A", status: "green", testVerdict: "67 of 67 tests passed", testVerdictUnfiltered: true },
      ]),
    ).resolves.toEqual({ closed: ["The full test suite runs green: absent"], open: ["Save: absent"], unasked: [] });
  });

  it("a title or the worker's own prose is not evidence (Codex 2026-09-12 W#3)", async () => {
    // Both of these closed "Decompression stop: absent" in Codex's run: the
    // requirement's own title, quoted back, and a failed sprint's sentence
    // saying the stop is NOT delivered. The quotable record is the MEASURED
    // lines only.
    const titleQuoted = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "Decompression stop: absent"}]}',
    ]);
    await expect(
      titleQuoted.planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent"], [{ title: "Decompression stop: absent" }]),
    ).resolves.toEqual({ closed: [], open: ["Decompression stop: absent"], unasked: [] });

    const proseQuoted = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "The decompression stop is NOT delivered."}]}',
    ]);
    await expect(
      proseQuoted.planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent"], [
        { title: "Sprint A", status: "failed", resultExcerpt: "The decompression stop is NOT delivered." },
      ]),
    ).resolves.toEqual({ closed: [], open: ["Decompression stop: absent"], unasked: [] });

    // …and a measured line still closes it.
    const measured = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "landed: 3 commit(s): Assets/Scripts/DecompressionStop.cs"}]}',
    ]);
    await expect(
      measured.planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent"], ladder),
    ).resolves.toEqual({ closed: ["Decompression stop: absent"], open: [], unasked: [] });

    // The prompt still SHOWS the worker's report as context.
    const sent = JSON.stringify(proseQuoted.chat.mock.calls[0]);
    expect(sent).toContain("report: The decompression stop is NOT delivered.");
  });

  it("throws when the reply is unusable, so the CALLER decides what an unrun audit means", async () => {
    const { planner } = plannerWith(["I could not tell."]);
    await expect(planner.resolveCoverageGaps("# GDD", ["Decompression stop: absent"], ladder)).rejects.toThrow(/schema validation/);
  });

  it("asks nothing when there is nothing to re-judge", async () => {
    const { planner, chat } = plannerWith([]);
    await expect(planner.resolveCoverageGaps("# GDD", [], ladder)).resolves.toEqual({ closed: [], open: [], unasked: [] });
    expect(chat).not.toHaveBeenCalled();
  });
});

/**
 * A COMMIT NOTE THAT NAMES NO CONTENT CLOSES NOTHING (Codex 2026-09-13 AJ,
 * the requirement trace).
 *
 * Executed by Codex against the real resolver: a ladder carrying only
 * "Committed 1 file(s) as `abcdef`." and a model reply quoting that sentence
 * closed a ballast-trim requirement. The line is a measured fact about a
 * commit and says nothing about WHICH requirement it implements.
 */
describe("closure needs evidence that names content", () => {
  function plannerWith(replies: string[]) {
    const chat = vi.fn(async () => ({ text: replies.shift() ?? "" }));
    const provider = { chat, name: "test", capabilities: { streaming: false } } as never;
    return { planner: new CampaignPlanner(provider), chat };
  }

  it("refuses a closure quoting a note that names only a count and a hash", async () => {
    const ladder = [{ title: "Sprint A", status: "failed", commitNote: "Committed 1 file(s) as `abcdef`." }];
    const { planner, chat } = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "landed: Committed 1 file(s) as `abcdef`."}]}',
    ]);

    const judged = await planner.resolveCoverageGaps("# GDD", ["Ballast trim: absent"], ladder);

    expect(judged.closed).toEqual([]);
    expect(judged.open).toEqual(["Ballast trim: absent"]);
    // The line is still SHOWN to the auditing model — it is disclosure; it
    // just cannot be the evidence that closes anything.
    expect(JSON.stringify(chat.mock.calls[0])).toContain("Committed 1 file(s)");
  });

  it("…and admits one whose note names the files it landed", async () => {
    const ladder = [{
      title: "Sprint A",
      status: "green",
      commitNote: "Committed 2 file(s) as `abcdef`: Assets/Scripts/BallastTrim.cs, Assets/Tests/PlayMode/TrimTests.cs.",
    }];
    const { planner } = plannerWith([
      '{"verdicts": [{"id": 1, "delivered": true, "evidence": "Assets/Tests/PlayMode/TrimTests.cs"}]}',
    ]);

    const judged = await planner.resolveCoverageGaps("# GDD", ["Ballast trim: absent"], ladder);
    expect(judged.closed).toEqual(["Ballast trim: absent"]);
  });

  // STREAMING_ENABLED=false governs every provider call, campaign planning included.
  it("with STREAMING_ENABLED=false the planner calls chat(), never chatStream()", async () => {
    const chat = vi.fn(async () => ({ text: '{"missing": []}' }));
    const chatStream = vi.fn(async () => {
      throw new Error("chatStream() must not be called with streaming disabled");
    });
    const provider = { chat, chatStream, name: "test", capabilities: { streaming: true } } as never;
    const planner = new CampaignPlanner(provider, { streamingEnabled: false });

    expect(await planner.auditCoverage("# GDD", [{ title: "Sprint A" }])).toEqual([]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chatStream).not.toHaveBeenCalled();
  });

  it("namesContent reads paths, files and type names — not counts and hashes", () => {
    expect(namesContent("landed: Committed 1 file(s) as `abcdef`.")).toBe(false);
    expect(namesContent("landed: Committed 12 file(s) as `9f2ab1c`.")).toBe(false);
    expect(namesContent("landed: 3 commit(s) in this sprint.")).toBe(false);
    expect(namesContent("landed: Committed 2 file(s) as `abcdef`: Assets/Scripts/Winch.cs.")).toBe(true);
    expect(namesContent("landed: Winch.cs")).toBe(true);
    expect(namesContent("landed: Game.Modules.Winch.Rules")).toBe(true);
    expect(namesContent("landed: Assets/Art/hero.png")).toBe(true);
    expect(namesContent("landed: docs/Game_GDD.md")).toBe(true);
  });
});
