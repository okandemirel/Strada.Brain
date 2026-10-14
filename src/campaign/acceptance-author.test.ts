/**
 * The acceptance test writer.
 *
 * A milestone is green only when its GDD rows pass checks the system owns.
 * Those checks are worth something only if their writer reads the GDD, not
 * the work: these tests pin that the writer is shown the verbatim rows, the
 * harness and the public signatures and nothing a worker wrote; that it is a
 * model which did not work on the milestone whenever one is healthy, and says
 * so when none is; that its reply is strict JSON, linted, regenerated at most
 * once; and that its calls stay inside the plan's caps. Every game here is
 * invented.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IAIProvider, ProviderResponse } from "../agents/providers/provider.interface.js";
import type { ProviderManager } from "../agents/providers/provider-manager.js";
import {
  AcceptanceAuthor,
  MAX_WRITER_CALLS,
  WRITER_BATCH_ROWS,
  acceptanceWriteContext,
  parseWriterReply,
  type WriterProviderSource,
} from "./acceptance-author.js";
import { harnessApiDoc, lintAcceptanceBody, renderAcceptanceFile } from "./acceptance-files.js";
import type { AcceptanceCheckBody, AcceptanceSource, AcceptanceWriteContext, RequirementKind, RequirementRow } from "./scope-types.js";

// =============================================================================
// AN INVENTED GAME: a moth gliding between lanterns
// =============================================================================

function row(over: Partial<RequirementRow> = {}): RequirementRow {
  return {
    rid: "req-001-aaaaaaaaaaaa",
    encoded: "The moth loses one life when it touches a thorn.",
    text: "The moth loses one life when it touches a thorn.",
    section: "Hazards",
    sectionNumber: "2.4",
    line: 31,
    span: { start: 400, end: 450 },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [],
    gddSha256: "e".repeat(64),
    gddRevision: 1,
    ...over,
  };
}

const ruleRow = (): RequirementRow => row();
const rangeRow = (): RequirementRow =>
  row({
    rid: "req-002-bbbbbbbbbbbb",
    text: "Glide speed stays between 2 and 4 m/s.",
    encoded: "Glide speed stays between 2 and 4 m/s.",
    section: "Flight",
    sectionNumber: "2.1",
    line: 12,
    span: { start: 100, end: 140 },
    kind: "range",
    bounds: { kind: "range", lo: 2, hi: 4, unit: "m/s" },
  });
const inputRow = (): RequirementRow =>
  row({
    rid: "req-003-cccccccccccc",
    text: "The player taps the screen to flap once.",
    encoded: "The player taps the screen to flap once.",
    section: "Controls",
    sectionNumber: "1.2",
    line: 7,
    span: { start: 50, end: 90 },
    kind: "input",
  });

const manyRows = (n: number): RequirementRow[] =>
  Array.from({ length: n }, (_, i) =>
    row({
      rid: `req-${String(i + 1).padStart(3, "0")}-${(i + 1).toString(16).padStart(12, "0")}`,
      text: `Lantern ${i + 1} lights when the moth lands on it.`,
      line: 100 + i,
      span: { start: 1000 + i * 60, end: 1050 + i * 60 },
    }),
  );

const NUNIT = "global::NUnit.Framework";

/** A check that passes the lint for each kind of row: what an honest writer returns. */
function goodCheck(rid: string, kind: RequirementKind, numeric: boolean): AcceptanceCheckBody {
  if (numeric) return { rid, observe: "Service<global::Glow.IFlight>().GlideSpeed" };
  if (kind === "input") {
    return {
      rid,
      body: `yield return TapViewport(0.5f, 0.5f);\n${NUNIT}.Assert.That(Service<global::Glow.IFlight>().Flaps, ${NUNIT}.Is.EqualTo(1));`,
    };
  }
  return { rid, body: `${NUNIT}.Assert.That(Service<global::Glow.ILives>().Count, ${NUNIT}.Is.EqualTo(2));` };
}

/** The rids a prompt asks for, in order. */
const askedRids = (user: string): string[] => [...user.matchAll(/^ROW (\S+)$/gm)].map((m) => m[1]!);

/** An honest writer: a good check for every row it is asked about. */
function honest(rows: readonly RequirementRow[]): (user: string) => string {
  const byRid = new Map(rows.map((r) => [r.rid, r]));
  return (user) =>
    JSON.stringify({
      checks: askedRids(user).map((rid) => {
        const r = byRid.get(rid)!;
        return goodCheck(rid, r.kind, r.bounds !== undefined && (r.kind === "range" || r.kind === "constant"));
      }),
      unbound: [],
    });
}

interface Call {
  readonly provider: string;
  readonly model?: string;
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
}

interface FakeModel {
  readonly name: string;
  readonly model: string;
  /** Who the reply says served it (a chain that fell over). */
  readonly servedBy?: { provider: string; model?: string };
}

const CAPS = { maxTokens: 8192, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true };

/** A provider manager with the given healthy models; every reply comes from `reply`. */
function fakeProviders(
  models: readonly FakeModel[],
  reply: (user: string, call: number) => string,
  opts: { allowed?: (name: string) => boolean; noBare?: boolean } = {},
): { source: WriterProviderSource; calls: Call[]; built: string[] } {
  const calls: Call[] = [];
  const built: string[] = [];
  const make = (name: string, model?: string): IAIProvider => ({
    name,
    capabilities: CAPS,
    chat: async (system, messages, _tools, options): Promise<ProviderResponse> => {
      const user = String(messages.at(-1)?.content ?? "");
      calls.push({ provider: name, model, system, user, maxTokens: options?.maxTokens });
      const servedBy = models.find((m) => m.name === name)?.servedBy;
      return {
        text: reply(user, calls.length),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        ...(servedBy ? { servedBy } : {}),
      };
    },
  });
  const source: WriterProviderSource = {
    listExecutionCandidates: () => models.map((m) => ({ name: m.name, defaultModel: m.model })),
    getProviderByName: (name, model) => {
      built.push(`chain:${name}:${model}`);
      return make(name, model);
    },
    ...(opts.noBare
      ? {}
      : {
          getPrimaryProviderByName: (name: string, model?: string) => {
            built.push(`bare:${name}:${model}`);
            return make(name, model);
          },
        }),
    ...(opts.allowed ? { allowsProvider: opts.allowed } : {}),
  };
  return { source, calls, built };
}

/** The wiring passes the provider manager as it stands; this stops compiling if the two drift apart. */
const managerIsASource: ProviderManager extends WriterProviderSource ? true : never = true;

const SURFACE = "public interface global::Glow.IFlight\n  float GlideSpeed { get; }\n  int Flaps { get; }\npublic interface global::Glow.ILives\n  int Count { get; }";

function ctx(over: Partial<AcceptanceWriteContext> = {}): AcceptanceWriteContext {
  return { milestoneId: "m2", workerModels: ["worker-model"], harnessDoc: harnessApiDoc(), surfaceDigest: SURFACE, ...over };
}

const WRITER: FakeModel = { name: "writer-co", model: "writer-model" };
const WORKER: FakeModel = { name: "worker-co", model: "worker-model" };

function author(source: WriterProviderSource, configured?: { provider: string; model?: string }, healthy: (name: string) => boolean = () => true): AcceptanceAuthor {
  return new AcceptanceAuthor({ providers: source, ...(configured ? { configured } : {}), isHealthy: healthy, streaming: false });
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

// =============================================================================
// WHAT THE WRITER IS SHOWN
// =============================================================================

describe("the writer's prompt", () => {
  it("carries each row's own words, section, line, kind and bounds, the harness and the surface — and nothing a worker wrote", async () => {
    const rows = [
      // Everything a worker could have put on a row is planted: the last run's words, a check's name, an ownership note.
      { ...rangeRow(), last: { revision: "abc", atMs: 1, outcome: "fail" as const, detail: "WORKER-REPORT-MARKER: I made glide faster" } },
      {
        ...ruleRow(),
        label: "HZ-1",
        checks: [{ kind: "test" as const, testName: "Strada.Acceptance.M2.Acceptance_M2.TEST-BODY-MARKER", path: "Assets/StradaAcceptance/Acceptance_M2.cs", bodySha: "0" }],
        ownership: [{ milestoneId: "m2", reason: "covered-section" as const, detail: "WORKER-REPORT-MARKER", atMs: 1 }],
      },
    ];
    const planted = {
      ...ctx(),
      workerReport: "WORKER-REPORT-MARKER: done, all rows implemented",
      workerTests: "[Test] public void TEST-BODY-MARKER() { Assert.Pass(); }",
      workerCode: "class Flight { float glide = 3; } // WORKER-CODE-MARKER",
    } as AcceptanceWriteContext;
    const { source, calls } = fakeProviders([WRITER], honest(rows));

    const result = await author(source).write(rows, planted);

    expect(calls).toHaveLength(1);
    const { system, user } = calls[0]!;
    for (const r of rows) expect(user).toContain(r.text);
    expect(user).toContain("§2.1 Flight");
    expect(user).toContain("line: 12");
    expect(user).toContain("kind: range");
    expect(user).toMatch(/2 m\/s ≤ value ≤ 4 m\/s/);
    expect(user).toContain("label: HZ-1");
    expect(user).toContain(harnessApiDoc());
    expect(user).toContain(SURFACE);
    for (const marker of ["WORKER-REPORT-MARKER", "TEST-BODY-MARKER", "WORKER-CODE-MARKER"]) {
      expect(system).not.toContain(marker);
      expect(user).not.toContain(marker);
    }
    expect(result.checks.map((c) => c.rid)).toEqual(rows.map((r) => r.rid));
    expect(result.faulted).toEqual([]);
    expect(result.writer).toEqual({ provider: "writer-co", model: "writer-model", independence: "different-model" });
  });

  it("reads a project on disk through its public signatures only: no method body, no test file", async () => {
    const root = mkdtempSync(join(tmpdir(), "strada-author-"));
    roots.push(root);
    put(root, "Packages/manifest.json", JSON.stringify({ dependencies: { "com.strada.core": "file:Submodules/Strada.Core" } }));
    put(root, "Assets/Glow/Glow.asmdef", JSON.stringify({ name: "Glow", references: ["Strada.Core"] }));
    put(
      root,
      "Assets/Glow/Flight.cs",
      "namespace Glow {\n  public interface IFlight { float GlideSpeed { get; } }\n  public sealed class Flight : IFlight {\n    public float GlideSpeed { get { return 3f; /* WORKER-CODE-MARKER */ } }\n    private void Tune() { var x = \"WORKER-CODE-MARKER\"; }\n  }\n}\n",
    );
    put(root, "Assets/Glow/Tests/Glow.Tests.asmdef", JSON.stringify({ name: "Glow.Tests", references: ["Glow", "UnityEngine.TestRunner"], defineConstraints: ["UNITY_INCLUDE_TESTS"] }));
    put(root, "Assets/Glow/Tests/FlightTests.cs", "namespace Glow.Tests { public class FlightTests { public void WORKER_TEST_MARKER() {} } }\n");
    const rows = [rangeRow()];
    const { source, calls } = fakeProviders([WRITER], honest(rows));

    await author(source).write(rows, acceptanceWriteContext(root, "m2", rows, ["worker-model"]));

    const user = calls[0]!.user;
    expect(user).toContain("public interface global::Glow.IFlight");
    expect(user).toContain("float GlideSpeed { get; }");
    expect(user).not.toContain("WORKER-CODE-MARKER");
    expect(user).not.toContain("WORKER_TEST_MARKER");
    expect(user).not.toContain("return 3f");
  });
});

// =============================================================================
// BATCHES AND STRICT JSON
// =============================================================================

describe("batches", () => {
  it(`asks about at most ${WRITER_BATCH_ROWS} rows per call`, async () => {
    const rows = manyRows(31);
    const { source, calls } = fakeProviders([WRITER], honest(rows));

    const result = await author(source).write(rows, ctx());

    expect(calls.map((c) => askedRids(c.user).length)).toEqual([15, 15, 1]);
    expect(calls.flatMap((c) => askedRids(c.user))).toEqual(rows.map((r) => r.rid));
    expect(result.checks).toHaveLength(31);
    expect(result.calls).toBe(3);
  });
});

describe("the reply is strict JSON", () => {
  const asked = [ruleRow().rid];
  const good = goodCheck(ruleRow().rid, "rule", false);

  it("reads the object, alone or in one json fence", () => {
    expect(parseWriterReply(JSON.stringify({ checks: [good], unbound: [] }), asked)).toEqual({ checks: [good], unbound: [] });
    expect(parseWriterReply("```json\n" + JSON.stringify({ checks: [good] }) + "\n```", asked)).toEqual({ checks: [good], unbound: [] });
  });

  it("rejects prose, prose around the object, and every key the contract does not name", () => {
    const rejected = (text: string): boolean => "error" in parseWriterReply(text, asked);
    expect(rejected("Here are the checks you asked for.")).toBe(true);
    expect(rejected(`Sure! ${JSON.stringify({ checks: [good], unbound: [] })}`)).toBe(true);
    expect(rejected(JSON.stringify({ checks: [good], unbound: [], notes: "x" }))).toBe(true);
    expect(rejected(JSON.stringify({ checks: [{ ...good, assert: "Is.True" }], unbound: [] }))).toBe(true);
    expect(rejected(JSON.stringify({ checks: [], unbound: [{ rid: asked[0], missingObservable: "x", hint: "y" }] }))).toBe(true);
    // A row nobody asked about, a row answered twice, a part that is not text.
    expect(rejected(JSON.stringify({ checks: [{ ...good, rid: "req-999-ffffffffffff" }] }))).toBe(true);
    expect(rejected(JSON.stringify({ checks: [good], unbound: [{ rid: asked[0], missingObservable: "x" }] }))).toBe(true);
    expect(rejected(JSON.stringify({ checks: [{ ...good, body: ["a"] }] }))).toBe(true);
  });

  it("asks once more after a reply it cannot read, then reports the rows as unparseable — never a third call", async () => {
    const rows = [ruleRow(), rangeRow()];
    const { source, calls } = fakeProviders([WRITER], () => "I wrote the tests in FlightTests.cs, they all pass.");

    const result = await author(source).write(rows, ctx());

    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toMatch(/not the JSON object asked for/);
    expect(result.checks).toEqual([]);
    expect(result.faulted.map((f) => [f.rid, f.cause])).toEqual(rows.map((r) => [r.rid, "unparseable"]));
    expect(result.calls).toBe(2);
  });

  it("an extra key costs a regeneration, and the corrected reply is taken", async () => {
    const rows = [ruleRow()];
    const fair = honest(rows);
    const { source, calls } = fakeProviders([WRITER], (user, call) =>
      call === 1 ? JSON.stringify({ checks: [{ ...goodCheck(rows[0]!.rid, "rule", false), explanation: "reads lives" }], unbound: [] }) : fair(user),
    );

    const result = await author(source).write(rows, ctx());

    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("explanation");
    expect(result.checks.map((c) => c.rid)).toEqual([rows[0]!.rid]);
    expect(result.faulted).toEqual([]);
  });
});

// =============================================================================
// LINT AND THE ONE REGENERATION
// =============================================================================

describe("lint and the bounded regeneration", () => {
  it("returns only checks the lint accepts; a refused one is regenerated once with its problems", async () => {
    const rows = [ruleRow(), rangeRow()];
    const fair = honest(rows);
    const { source, calls } = fakeProviders([WRITER], (user, call) =>
      call === 1
        ? JSON.stringify({
            checks: [
              // The guardrail shape: an assertion on reflection, which cannot fail on behaviour.
              { rid: rows[0]!.rid, body: `${NUNIT}.Assert.That(typeof(global::Glow.ILives).GetInterfaces().Length, ${NUNIT}.Is.GreaterThanOrEqualTo(2));` },
              goodCheck(rows[1]!.rid, "range", true),
            ],
            unbound: [],
          })
        : fair(user),
    );

    const result = await author(source).write(rows, ctx());

    expect(calls).toHaveLength(2);
    // Only the refused row is asked again, with what was wrong and what it returned.
    expect(askedRids(calls[1]!.user)).toEqual([rows[0]!.rid]);
    expect(calls[1]!.user).toMatch(/reflection only/);
    expect(calls[1]!.user).toContain("GetInterfaces().Length");
    expect(result.checks.map((c) => c.rid).sort()).toEqual(rows.map((r) => r.rid).sort());
    for (const check of result.checks) expect(lintAcceptanceBody(rows.find((r) => r.rid === check.rid)!, check).ok).toBe(true);
    expect(result.faulted).toEqual([]);
  });

  it("a check still refused after its regeneration is a fault with the lint's problems, not a third call", async () => {
    const rows = [rangeRow()];
    // A numeric row whose writer insists on asserting the GDD's numbers itself.
    const { source, calls } = fakeProviders([WRITER], () =>
      JSON.stringify({ checks: [{ rid: rows[0]!.rid, body: `${NUNIT}.Assert.That(Service<global::Glow.IFlight>().GlideSpeed, ${NUNIT}.Is.InRange(2, 4));` }] }),
    );

    const result = await author(source).write(rows, ctx());

    expect(calls).toHaveLength(2);
    expect(result.checks).toEqual([]);
    expect(result.faulted).toHaveLength(1);
    expect(result.faulted[0]!.cause).toBe("lint");
    expect(result.faulted[0]!.problems.join(" ")).toMatch(/observe/);
  });

  it("a row the reply leaves out is asked again, then reported missing", async () => {
    const rows = [ruleRow(), inputRow()];
    // A writer that only ever answers for the first row, whatever it is asked.
    const { source, calls } = fakeProviders([WRITER], (user) =>
      JSON.stringify({ checks: askedRids(user).filter((rid) => rid === rows[0]!.rid).map((rid) => goodCheck(rid, "rule", false)), unbound: [] }),
    );

    const result = await author(source).write(rows, ctx());

    expect(calls).toHaveLength(2);
    expect(askedRids(calls[1]!.user)).toEqual([rows[1]!.rid]);
    expect(result.checks.map((c) => c.rid)).toEqual([rows[0]!.rid]);
    expect(result.faulted.map((f) => [f.rid, f.cause])).toEqual([[rows[1]!.rid, "missing"]]);
  });

  it("the checks it returns render into the system's file", async () => {
    const rows = [ruleRow(), rangeRow(), inputRow()];
    const { source } = fakeProviders([WRITER], honest(rows));

    const result = await author(source).write(rows, ctx());

    const byRid = new Map(rows.map((r) => [r.rid, r]));
    const rendered = renderAcceptanceFile("m2", result.checks.map((check) => ({ row: byRid.get(check.rid)!, check })));
    expect(rendered.tests).toHaveLength(3);
    // The GDD's numbers are the system's: the range row's assertion is built from the row's bounds.
    expect(rendered.source).toContain(`${NUNIT}.Is.InRange(2d, 4d)`);
  });
});

describe("unbound rows", () => {
  it("pass through with what would make them observable, and cost no regeneration", async () => {
    const rows = [ruleRow(), inputRow()];
    const { source, calls } = fakeProviders([WRITER], () =>
      JSON.stringify({
        checks: [goodCheck(rows[0]!.rid, "rule", false)],
        unbound: [{ rid: rows[1]!.rid, missingObservable: "a public flap counter on global::Glow.IFlight" }],
      }),
    );

    const result = await author(source).write(rows, ctx());

    expect(calls).toHaveLength(1);
    expect(result.unbound).toEqual([{ rid: rows[1]!.rid, missingObservable: "a public flap counter on global::Glow.IFlight" }]);
    expect(result.checks.map((c) => c.rid)).toEqual([rows[0]!.rid]);
    expect(result.faulted).toEqual([]);
  });
});

// =============================================================================
// WHO WRITES
// =============================================================================

describe("pickWriter", () => {
  it("takes the configured writer when its model did not work on the milestone", () => {
    const { source, built } = fakeProviders([WORKER, WRITER, { name: "third-co", model: "third-model" }], () => "");
    const picked = author(source, { provider: "third-co", model: "third-model" }).pickWriter(["worker-model"]);
    expect(picked?.writer).toEqual({ provider: "third-co", model: "third-model", independence: "different-model" });
    expect(picked?.disclosure).toBeUndefined();
    // A bare provider, never a chain: a chain could fall over to the worker's model and answer under the writer's name.
    expect(built).toEqual(["bare:third-co:third-model"]);
  });

  it("passes over a configured writer whose model is the worker's, and takes the next healthy candidate", () => {
    const { source } = fakeProviders([WORKER, WRITER], () => "");
    // The same model under another spelling — a provider prefix, another case — is still the worker's.
    const picked = author(source, { provider: "worker-co", model: "worker-model" }).pickWriter(["opencode/Worker-Model"]);
    expect(picked?.writer).toEqual({ provider: "writer-co", model: "writer-model", independence: "different-model" });
  });

  it("skips a candidate that is cooling down or outside the operator's chain", () => {
    const third: FakeModel = { name: "third-co", model: "third-model" };
    const { source } = fakeProviders([WORKER, WRITER, third], () => "", { allowed: (name) => name !== "writer-co" });
    expect(author(source).pickWriter(["worker-model"])?.writer.provider).toBe("third-co");
    const { source: s2 } = fakeProviders([WORKER, WRITER, third], () => "");
    expect(author(s2, undefined, (name) => name !== "third-co" && name !== "writer-co").pickWriter(["worker-model"])?.writer).toEqual({
      provider: "worker-co",
      model: "worker-model",
      independence: "same-model",
    });
  });

  it("with only the worker's model healthy, writes with it as same-model and says so", async () => {
    const rows = [ruleRow()];
    const { source, calls } = fakeProviders([WORKER], honest(rows));

    const result = await author(source).write(rows, ctx());

    expect(calls).toHaveLength(1);
    expect(result.writer).toEqual({ provider: "worker-co", model: "worker-model", independence: "same-model" });
    expect(result.disclosure).toMatch(/worker-model/);
    expect(result.disclosure).toMatch(/cannot prove/);
  });

  it("when the milestone's models were not recorded, no writer can be shown independent: same-model", () => {
    const { source } = fakeProviders([WRITER], () => "");
    const picked = author(source).pickWriter([]);
    expect(picked?.writer.independence).toBe("same-model");
    expect(picked?.disclosure).toMatch(/not recorded/);
  });

  it("with no healthy model, calls nothing and faults every row as no-writer", async () => {
    const rows = [ruleRow(), rangeRow()];
    const { source, calls } = fakeProviders([WORKER, WRITER], honest(rows));

    const result = await author(source, undefined, () => false).write(rows, ctx());

    expect(calls).toEqual([]);
    expect(result.calls).toBe(0);
    expect(result.writer).toBeUndefined();
    expect(result.checks).toEqual([]);
    expect(result.faulted.map((f) => [f.rid, f.cause])).toEqual(rows.map((r) => [r.rid, "no-writer"]));
    expect(result.disclosure).toMatch(/no healthy model/);
  });

  it("a reply served by a worker's model is recorded as same-model, whatever was picked", async () => {
    const rows = [ruleRow()];
    const fellOver: FakeModel = { ...WRITER, servedBy: { provider: "worker-co", model: "worker-model" } };
    const { source } = fakeProviders([fellOver], honest(rows), { noBare: true });

    const result = await author(source).write(rows, ctx());

    expect(result.writer).toEqual({ provider: "worker-co", model: "worker-model", independence: "same-model" });
    expect(result.disclosure).toMatch(/worker-model/);
  });

  it("takes the production provider manager as its source", () => {
    expect(managerIsASource).toBe(true);
  });

  it("describe() names the configured writer, or auto", () => {
    const { source } = fakeProviders([WRITER], () => "");
    expect(author(source, { provider: "writer-co", model: "writer-model" }).describe()).toMatch(/^writer-co:writer-model \(configured\)/);
    expect(author(source).describe()).toMatch(/^auto/);
  });
});

// =============================================================================
// COST CAPS
// =============================================================================

describe("cost caps", () => {
  it("never spends more calls than the caller's budget; rows past it are faulted as budget", async () => {
    const rows = manyRows(31);
    const { source, calls } = fakeProviders([WRITER], honest(rows));

    const result = await author(source).write(rows, ctx({ maxCalls: 2 }));

    expect(calls).toHaveLength(2);
    expect(result.calls).toBe(2);
    expect(result.checks).toHaveLength(30);
    expect(result.faulted.map((f) => f.cause)).toEqual(["budget"]);
  });

  it("an unreadable budget spends nothing", async () => {
    const rows = [ruleRow()];
    const { source, calls } = fakeProviders([WRITER], honest(rows));

    const result = await author(source).write(rows, ctx({ maxCalls: Number.NaN }));

    expect(calls).toEqual([]);
    expect(result.faulted.map((f) => f.cause)).toEqual(["budget"]);
  });

  it(`never spends more than ${MAX_WRITER_CALLS} calls in one request, and caps every call's output`, async () => {
    const rows = manyRows(WRITER_BATCH_ROWS * MAX_WRITER_CALLS + 5);
    const { source, calls } = fakeProviders([WRITER], honest(rows));

    const result = await author(source).write(rows, ctx({ maxCalls: 50 }));

    expect(calls).toHaveLength(MAX_WRITER_CALLS);
    expect(result.faulted.filter((f) => f.cause === "budget")).toHaveLength(5);
    for (const call of calls) expect(call.maxTokens).toBeGreaterThan(0);
    for (const call of calls) expect(call.maxTokens).toBeLessThanOrEqual(16_000);
  });
});

// =============================================================================
// REPAIRS: regenerate, rebind, revise, repairCompile
// =============================================================================

describe("repairs", () => {
  it("regenerate asks once for one row, with the problems it was given", async () => {
    const rows = [ruleRow()];
    const { source, calls } = fakeProviders([WRITER], honest(rows));

    const result = await author(source).regenerate(rows[0]!, ["the review found the check reads a constant the game never changes"], ctx());

    expect(calls).toHaveLength(1);
    expect(askedRids(calls[0]!.user)).toEqual([rows[0]!.rid]);
    expect(calls[0]!.user).toContain("the review found the check reads a constant the game never changes");
    expect(result.checks.map((c) => c.rid)).toEqual([rows[0]!.rid]);
  });

  it("rebind writes against the new surface it is given, from the old check", async () => {
    const rows = [rangeRow()];
    const { source, calls } = fakeProviders([WRITER], honest(rows));
    const newSurface = "public interface global::Glow.Motion.IGlide\n  float Speed { get; }";

    await author(source).rebind(rows[0]!, "Service<global::Glow.IFlight>().GlideSpeed", newSurface, ctx());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain(newSurface);
    expect(calls[0]!.user).not.toContain(SURFACE);
    expect(calls[0]!.user).toContain("Service<global::Glow.IFlight>().GlideSpeed");
  });

  it("revise shows the dispute as the worker's claim, clipped, beside the run's failure", async () => {
    const rows = [ruleRow()];
    const { source, calls } = fakeProviders([WRITER], honest(rows));
    const longReason = `thorns only cost a life on hard mode ${"x".repeat(5000)}`;

    await author(source).revise(rows[0]!, goodCheck(rows[0]!.rid, "rule", false).body!, longReason, "Expected: 2 But was: 3", ctx());

    const user = calls[0]!.user;
    expect(calls).toHaveLength(1);
    expect(user).toMatch(/worker's claim/i);
    expect(user).toContain("thorns only cost a life on hard mode");
    expect(user).not.toContain("x".repeat(5000));
    expect(user).toContain("Expected: 2 But was: 3");
  });

  it("repairCompile asks only about the check a compile error sits in, and faults a test whose row it was not given", async () => {
    const rule = ruleRow();
    const range = rangeRow();
    const rendered = renderAcceptanceFile("m2", [
      { row: rule, check: goodCheck(rule.rid, "rule", false) },
      { row: range, check: { rid: range.rid, observe: "Service<global::Glow.IFlight>().GlideSpeedd" } },
    ]);
    const file: AcceptanceSource = {
      milestoneId: "m2",
      path: rendered.path,
      sha256: rendered.sha256,
      source: rendered.source,
      writer: { provider: "writer-co", model: "writer-model", independence: "different-model" },
      revisions: 1,
      tests: rendered.tests,
    };
    const errorLine = rendered.source.split("\n").findIndex((l) => l.includes("GlideSpeedd")) + 1;
    const errors = [{ path: rendered.path, line: errorLine, code: "CS1061", message: "'IFlight' does not contain a definition for 'GlideSpeedd'" }];
    const { source, calls } = fakeProviders([WRITER], honest([rule, range]));

    const result = await author(source).repairCompile(file, errors, ctx({ rows: [rule, range] }));

    expect(calls).toHaveLength(1);
    expect(askedRids(calls[0]!.user)).toEqual([range.rid]);
    expect(calls[0]!.user).toContain("does not contain a definition for 'GlideSpeedd'");
    expect(calls[0]!.user).toContain("GlideSpeedd");
    expect(result.checks.map((c) => c.rid)).toEqual([range.rid]);

    // An error no single check holds is shown to every check; a test with no row passed is faulted, not guessed at.
    const { source: s2, calls: c2 } = fakeProviders([WRITER], honest([rule, range]));
    const unplaced = await author(s2).repairCompile(file, [{ path: rendered.path, message: "the assembly failed" }], ctx({ rows: [range] }));
    expect(askedRids(c2[0]!.user)).toEqual([range.rid]);
    expect(unplaced.faulted.map((f) => [f.rid, f.cause])).toEqual([[rule.rid, "no-row"]]);
  });
});
