/**
 * Tripwire: a direct provider call that bypasses the billing path (task #71).
 * Contract: docs/contracts/provider-call-billing.md, rule direct-provider-call-is-billed.
 *
 * The gap closed by billed-call.ts surfaced three times as "one more caller":
 * the goal decomposer (task #67), then ten call sites at once (task #71). Each
 * called `provider.chat` or `streamOrChatText`, read the text, and dropped the
 * usage. This test parses every source file under src/ (TypeScript AST, so
 * comments and strings do not count) and counts the calls that reach a
 * provider directly:
 *   - `x.chat(...)`, `x.chatStream(...)`, `x.chatStreamStructured(...)`, also
 *     optional (`x?.chat(`, `x.chat?.(`), bracketed (`x["chat"](`), wrapped in
 *     parentheses, a cast or `!` (`(x.chat)(`), and `.call`/`.apply`/`.bind`;
 *   - `streamOrChatText(...)`, bare or through a namespace (`ns.streamOrChatText(`),
 *     and any import that renames it.
 * The matcher's own cases ("counts …", "does not count …", "cannot see …")
 * pin each spelling.
 * A file may make such calls only if it is listed below with its exact count
 * and the reason its calls are billed.
 * Everything else bills through billedChat / billedStreamOrChatText, which
 * this test does not count.
 *
 * What it cannot see: a provider method taken into a variable
 * (`const f = provider.chat; f()`) or destructured (`const { chat } = provider`),
 * a call through a wrapper defined in an
 * allowlisted file and used elsewhere, other paid endpoints (embeddings,
 * image generation), and code outside src/.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..");
const PROVIDER_METHODS = new Set(["chat", "chatStream", "chatStreamStructured"]);

/**
 * Files allowed to call a provider directly, with their exact call count.
 * A new direct call anywhere fails; so does a changed count here — raise it
 * only with the reason the new call is billed.
 */
const ALLOWED: Readonly<Record<string, { readonly calls: number; readonly why: string }>> = {
  // ── the choke point and the providers layer itself ──
  "agents/providers/billed-call.ts": { calls: 2, why: "the choke point: billedChat and billedStreamOrChatText make the call they bill" },
  "agents/providers/provider.interface.ts": { calls: 2, why: "streamOrChatText's own body: the unbilled primitive billed-call.ts wraps" },
  "agents/providers/fallback-chain.ts": {
    calls: 3,
    why: "a chain calling its members: the consumer bills the chain's reply (servedBy, auxiliaryUsage, error.usage); " +
      "the recovering-member health probe bills through billedChat (task #72)",
  },
  // ── engine paths that bill through recordProviderUsage / recordAuxiliaryUsage themselves ──
  "agents/orchestrator.ts": { calls: 6, why: "model turns, the supervisor planning call and the two synthesis calls: each bills recordProviderUsage on its reply" },
  "agents/orchestrator-intervention-pipeline.ts": { calls: 2, why: "reviewer calls billed with deps.recordAuxiliaryUsage" },
  "agents/autonomy/progress-assessment.ts": { calls: 1, why: "the assessment bills deps.recordAuxiliaryUsage" },
  "agent-core/engine/review.ts": { calls: 2, why: "review and verify calls billed with recordAuxiliaryUsage" },
  "agent-core/routing/consensus-manager.ts": { calls: 2, why: "reviewer spend collected per call (usageEntryOf / error.usage) and billed through consensusUsageSink" },
  "goals/goal-decomposer.ts": { calls: 1, why: "each reply billed through DecomposeOptions.onUsage → Orchestrator.recordProviderUsage (task #67)" },
};

/** The call sites tasks #71 and #72 moved onto billed-call.ts (each bills a run or a named budget source). */
const MOVED_TO_CHOKE_POINT = new Set([
  // task #72: the two residues #71 left allowlisted
  "core/bootstrap-stages/stage-agents.ts",
  "agents/providers/fallback-chain.ts",
  // task #71
  "supervisor/supervisor-verification.ts",
  "supervisor/capability-matcher.ts",
  "campaign/campaign-planner.ts",
  "campaign/acceptance-author.ts",
  "campaign/visual-conformance.ts",
  "agents/style/style-analysis.ts",
  "memory/unified/session-summarizer.ts",
  "learning/chains/chain-synthesizer.ts",
  "vault/symbol-summarizer.ts",
  "agent-core/agent-core.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(SRC, path) === "tests") continue; // test helpers
      out.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The expression under `(…)`, `… as T`, `<T>…`, `…!` and `… satisfies T`: none of them changes what is called. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** The member a callee names: `x.m`, `x?.m`, `x["m"]`, ``x[`m`]`` (after unwrap). */
function memberName(callee: ts.Expression): string | undefined {
  const e = unwrap(callee);
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return undefined;
}

/** Does this callee reach a provider directly: a provider method, or streamOrChatText bare or through a namespace? */
function isDirectCallee(callee: ts.Expression): boolean {
  const e = unwrap(callee);
  if (ts.isIdentifier(e)) return e.text === "streamOrChatText";
  const name = memberName(e);
  return name !== undefined && (PROVIDER_METHODS.has(name) || name === "streamOrChatText");
}

interface Finding { readonly line: number; readonly text: string }

/** The engine's own billing calls: a file that also bills through billed-call.ts would count one reply twice. */
const SELF_BILLING = new Set(["recordProviderUsage", "recordAuxiliaryUsage", "consensusUsageSink"]);
const BILLED_HELPERS = new Set(["billedChat", "billedStreamOrChatText"]);

interface FileFindings {
  readonly calls: Finding[];
  readonly renamedImports: Finding[];
  readonly billed: Finding[];
  readonly selfBilled: Finding[];
}

function directCalls(path: string): FileFindings {
  return directCallsIn(readFileSync(path, "utf8"), path);
}

function directCallsIn(source: string, path: string): FileFindings {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: Finding[] = [];
  const renamedImports: Finding[] = [];
  const billed: Finding[] = [];
  const selfBilled: Finding[] = [];
  const at = (node: ts.Node): Finding => ({
    line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    text: node.getText(file).split("\n")[0]!.slice(0, 120),
  });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      // `x.chat.call(…)`, `.apply`, `.bind`: the function method of a direct callee.
      const viaFunctionMethod = ts.isPropertyAccessExpression(callee)
        && ["call", "apply", "bind"].includes(callee.name.text)
        && isDirectCallee(callee.expression);
      if (isDirectCallee(callee) || viaFunctionMethod) {
        calls.push(at(node));
      }
      const name = ts.isIdentifier(callee) ? callee.text : (memberName(callee) ?? "");
      if (BILLED_HELPERS.has(name)) billed.push(at(node));
      if (SELF_BILLING.has(name)) selfBilled.push(at(node));
    }
    if (ts.isImportSpecifier(node) && node.propertyName?.text === "streamOrChatText" && node.name.text !== "streamOrChatText") {
      renamedImports.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { calls, renamedImports, billed, selfBilled };
}

describe("the tripwire's matcher, on every spelling of a direct call (task #71)", () => {
  const count = (snippet: string): number => directCallsIn(snippet, "fixture.ts").calls.length;

  it.each([
    ["a method call", "p.chat(s, m, t);"],
    ["an optional receiver", "p?.chat(s, m, t);"],
    ["an optional call", "p.chat?.(s, m, t);"],
    ["a quoted member", 'p["chat"](s, m, t);'],
    ["a template-quoted member", "p[`chat`](s, m, t);"],
    ["a parenthesized callee", "(p.chat)(s, m, t);"],
    ["a non-null callee", "p.chat!(s, m, t);"],
    ["a cast receiver", "(p as IAIProvider).chat(s, m, t);"],
    ["a cast callee", "(p.chat as Chat)(s, m, t);"],
    ["call()", "p.chat.call(p, s, m, t);"],
    ["apply()", "p.chat.apply(p, [s, m, t]);"],
    ["bind()", "p.chat.bind(p);"],
    ["a call split over lines", "provider\n  .chat(\n    s,\n    m,\n    t,\n  );"],
    ["chatStream", "p.chatStream(s, m, t, onChunk);"],
    ["chatStreamStructured", "p.chatStreamStructured(s, m, t, onChunk);"],
    ["streamOrChatText", "streamOrChatText(p, s, u);"],
    ["streamOrChatText through a namespace import", "ns.streamOrChatText(p, s, u);"],
    ["streamOrChatText through a quoted namespace member", 'ns["streamOrChatText"](p, s, u);'],
    ["a parenthesized streamOrChatText", "(streamOrChatText)(p, s, u);"],
  ])("counts %s", (_name, snippet) => {
    expect(count(snippet)).toBe(1);
  });

  it.each([
    ["a line comment", "// p.chat(s, m, t)"],
    ["a block comment", "/* streamOrChatText(p, s, u) */"],
    ["a string", 'const doc = "p.chat(s, m, t)";'],
    ["a method declaration", "class P { async chat(s: string) { return s; } }"],
    ["a billed call", "billedChat(p, BILLING, s, m, t); billedStreamOrChatText(p, BILLING, s, u);"],
    ["a longer name", "p.chats(s); p.chatty(s); streamOrChatTextual(p);"],
  ])("does not count %s", (_name, snippet) => {
    expect(count(snippet)).toBe(0);
  });

  it("sees streamOrChatText imported under another name", () => {
    expect(directCallsIn('import { streamOrChatText as soct } from "./provider.interface.js";', "fixture.ts").renamedImports).toHaveLength(1);
  });

  // What it cannot see (docs/contracts/provider-call-billing.md): pinned at 0, so a matcher that starts to see one shows here.
  it.each([
    ["a method taken into a variable", "const f = p.chat; f(s, m, t);"],
    ["a destructured method", "const { chat } = p; chat(s, m, t);"],
  ])("cannot see %s", (_name, snippet) => {
    expect(count(snippet)).toBe(0);
  });
});

/** The scan walks every source file: on a loaded machine it outlasts vitest's 30 s default (docs/contracts/wall-clock-assertions.md). */
const REPO_SCAN_TIMEOUT_MS = 120_000;

type Scanned = { readonly file: string } & FileFindings;
let scannedOnce: Scanned[] | undefined;

/** The tree, parsed once and shared by the cases; each case that reaches it carries the scan's limit. */
function scanned(): Scanned[] {
  scannedOnce ??= sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split(sep).join("/"), ...directCalls(path) }));
  return scannedOnce;
}

describe("direct provider calls go through the billing path (task #71)", { timeout: REPO_SCAN_TIMEOUT_MS }, () => {
  it("scans the source tree (a scan that found nothing would pass vacuously)", () => {
    expect(scanned().length).toBeGreaterThan(500);
    expect(scanned().find((s) => s.file === "agents/orchestrator.ts")?.calls.length).toBeGreaterThan(0);
  });

  it("no file outside the allowlist calls a provider directly", () => {
    const offenders = scanned()
      .filter((s) => s.calls.length > 0 && !(s.file in ALLOWED))
      .map((s) => `src/${s.file}: ${s.calls.map((c) => `:${c.line} ${c.text}`).join(" | ")}`);
    expect(
      offenders,
      "bill the call with billedChat / billedStreamOrChatText (src/agents/providers/billed-call.ts) and name who pays",
    ).toEqual([]);
  });

  it("every allowlisted file makes exactly the calls its reason covers", () => {
    const counts = Object.fromEntries(Object.keys(ALLOWED).map((f) => [f, scanned().find((s) => s.file === f)?.calls.length ?? 0]));
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.calls]));
    expect(counts, "a new direct call in an allowlisted file needs its own billing — or lower the count when one is gone").toEqual(expected);
  });

  it("nobody imports streamOrChatText under another name", () => {
    expect(scanned().flatMap((s) => s.renamedImports.map((r) => `src/${s.file}:${r.line} ${r.text}`))).toEqual([]);
  });

  it("no file bills one call twice: through billed-call.ts and through the engine's own billing", () => {
    const both = scanned()
      .filter((s) => s.billed.length > 0 && s.selfBilled.length > 0)
      .map((s) => `src/${s.file}: billed ${s.billed.map((b) => `:${b.line}`).join(",")} and self-billed ${s.selfBilled.map((b) => `:${b.line}`).join(",")}`);
    expect(both).toEqual([]);
    // The call sites tasks #71 and #72 moved onto the choke point are all still on it.
    const onChokePoint = new Set(scanned().filter((s) => s.billed.length > 0).map((s) => s.file));
    expect([...MOVED_TO_CHOKE_POINT].filter((f) => !onChokePoint.has(f))).toEqual([]);
  });

  it("the process ledger is installed at boot: bootstrap wires the spend counters", () => {
    const bootstrap = readFileSync(join(SRC, "core", "bootstrap.ts"), "utf8");
    const wiring = readFileSync(join(SRC, "core", "bootstrap-spend-counters.ts"), "utf8");
    expect(bootstrap).toMatch(/\n\s+wireSpendCounters\(\{/);
    expect(wiring).toMatch(/installProviderUsageLedger\(\s*createProviderUsageLedger\(/);
  });
});
