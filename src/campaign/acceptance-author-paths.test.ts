/**
 * The writer's compile repair reads a compile error's file the way the judge
 * does: the editor reports an absolute path, or a
 * path in another case, and an exact comparison left such an error unrepaired
 * while `attributeRun` charged it to the file as a check fault. Invented rows.
 */

import { describe, expect, it } from "vitest";
import type { IAIProvider, ProviderResponse } from "../agents/providers/provider.interface.js";
import { AcceptanceAuthor, type WriterProviderSource } from "./acceptance-author.js";
import { harnessApiDoc, renderAcceptanceFile } from "./acceptance-files.js";
import { attributeRun } from "./scope-verdict.js";
import type { AcceptanceSource, AcceptanceWriteContext, RequirementRow } from "./scope-types.js";

const CAPS = { maxTokens: 8192, streaming: false, structuredStreaming: false, toolCalling: false, vision: false, systemPrompt: true };
const NUNIT = "global::NUnit.Framework";

function row(rid: string, start: number, text: string): RequirementRow {
  return {
    rid,
    encoded: text,
    text,
    section: "Lanterns",
    sectionNumber: "2.2",
    line: start,
    span: { start: start * 10, end: start * 10 + 9 },
    kind: "rule",
    source: "extracted",
    ownership: [],
    status: "open",
    checks: [],
    gddSha256: "e".repeat(64),
    gddRevision: 1,
  };
}

const asked = (user: string): string[] => [...user.matchAll(/^ROW (\S+)$/gm)].map((m) => m[1]!);

function writer(): { source: WriterProviderSource; users: string[] } {
  const users: string[] = [];
  const make = (name: string): IAIProvider => ({
    name,
    capabilities: CAPS,
    chat: async (_system, messages): Promise<ProviderResponse> => {
      const user = String(messages.at(-1)?.content ?? "");
      users.push(user);
      return {
        text: JSON.stringify({ checks: asked(user).map((rid) => ({ rid, body: `${NUNIT}.Assert.That(Service<global::Glow.ILamp>().Lit, ${NUNIT}.Is.True);` })), unbound: [] }),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
  return {
    users,
    source: {
      listExecutionCandidates: () => [{ name: "writer-co", defaultModel: "writer-model" }],
      getProviderByName: (name) => make(name),
      getPrimaryProviderByName: (name: string) => make(name),
    },
  };
}

describe("repairCompile reads an error's file as attributeRun does", () => {
  const lit = row("req-001-aaaaaaaaaaaa", 4, "A lantern stays lit while the moth rests on it.");
  const dim = row("req-002-bbbbbbbbbbbb", 9, "A lantern dims when the moth leaves it.");
  const rendered = renderAcceptanceFile("m2", [
    { row: lit, check: { rid: lit.rid, body: `${NUNIT}.Assert.That(Service<global::Glow.ILamp>().Lit, ${NUNIT}.Is.True);` } },
    { row: dim, check: { rid: dim.rid, body: `${NUNIT}.Assert.That(Service<global::Glow.ILamp>().Dimm, ${NUNIT}.Is.True);` } },
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
  const line = rendered.source.split("\n").findIndex((l) => l.includes(".Dimm")) + 1;
  const ctx: AcceptanceWriteContext = { milestoneId: "m2", workerModels: ["worker-model"], harnessDoc: harnessApiDoc(), surfaceDigest: "", rows: [lit, dim] };

  it.each([
    ["an absolute path", `/Users/someone/Projects/Glow/${rendered.path}`],
    ["another case", rendered.path.toLowerCase()],
    ["backslashes and a leading ./", `.\\${rendered.path.replace(/\//g, "\\")}`],
  ])("an error reported with %s is the file's, for the repair as for the judge", async (_how, reported) => {
    const errors = [{ path: reported, line, code: "CS1061", message: "'ILamp' does not contain a definition for 'Dimm'" }];
    // The judge charges it to this file's never-compiled check …
    const judged = attributeRun(
      { admitted: false, refusal: { kind: "count-mismatch", detail: "short" }, revision: "r", expected: [], failedNames: [], unattributed: 0, flaky: [], acceptanceCompileErrors: errors, tamper: [], failures: [] },
      rendered.tests.map((t) => ({ testName: t.testName, path: rendered.path })),
      new Set(),
    );
    expect(Object.values(judged.tests).map((t) => t.outcome)).toEqual(["check-fault", "check-fault"]);
    // … so the repair must ask about it, not skip it.
    const { source, users } = writer();
    const result = await new AcceptanceAuthor({ providers: source, isHealthy: () => true, streaming: false }).repairCompile(file, errors, ctx);
    expect(users).toHaveLength(1);
    expect(asked(users[0]!)).toEqual([dim.rid]);
    expect(result.checks.map((c) => c.rid)).toEqual([dim.rid]);
  });
});
