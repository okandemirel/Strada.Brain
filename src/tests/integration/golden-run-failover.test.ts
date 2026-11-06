/**
 * Golden run of the provider chain's failover path: the first seat of a
 * two-seat chain fails for good, and the work finishes on the second.
 *
 * The REAL bootstrap() runs every stage; only the edges of the process are
 * replaced (src/tests/helpers/golden-run-harness.ts says what, and why). The
 * other golden runs replace provider-registry itself, so the chain they boot
 * is one scripted provider: a dropped call is retried on the same provider,
 * and the fallback chain and the health registry never decide anything. Here
 * only the two seats' provider classes are replaced (PROVIDER_CHAIN=
 * deepseek,kimi): the real preflight, buildProviderChain, FallbackChainProvider
 * and ProviderHealthRegistry run between them, and every step names the seat
 * its call must reach.
 *
 * Each run pins, in order, which seat took every call and which member the
 * chain logged for each attempt; which seat each worker turn was billed to;
 * what the health registry wrote to the file the next boot restores; what
 * the user read; and how the task was recorded.
 *
 * With both seats healthy a short request is spread over the two (measured
 * 2026-11-06): deepseek plans, kimi acts and reports, and deepseek reviews the
 * draft and writes the user's answer from it, a call a one-seat chain never
 * makes. Each run breaks deepseek at one of its calls:
 *
 * 1. Its key is refused on the first call, the plan. The chain benches it for
 *    the session and hands kimi the same call. No later call is offered to
 *    deepseek: kimi takes every role, so no answer is written separately.
 * 2. It is overloaded at the review, after the work is done. The chain cools
 *    it down for minutes, not hours, and hands kimi the same call; the answer,
 *    which was deepseek's to write, is written by kimi.
 *
 * When a deliberate change alters the calls a run makes, the failure names
 * the step it expected and the call it got, and the seat that took it.
 * Update that run's script in the same commit and say in the message what
 * changed in the loop and why.
 */

import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../agents/providers/deepseek.js", async (original) =>
  (await import("../helpers/golden-run-edges.js")).scriptedSeat(original, "DeepSeekProvider", "deepseek"));
vi.mock("../../agents/providers/kimi.js", async (original) =>
  (await import("../helpers/golden-run-edges.js")).scriptedSeat(original, "KimiProvider", "kimi"));
vi.mock("../../core/bootstrap-channels.js", async (original) =>
  (await import("../helpers/golden-run-edges.js")).scriptedChannels(original));
vi.mock("../../vault/framework-vault-targets.js", async (original) =>
  (await import("../helpers/golden-run-edges.js")).noFrameworkVaultTargets(original));

import {
  offers,
  requires,
  say,
  textOf,
  toolResultIds,
  type ProviderCall,
  type Step,
} from "../helpers/golden-run-edges.js";
import {
  GOLDEN_RUN_TIMEOUT_MS,
  GOLDEN_WORKING_DIR,
  isolationDisabled,
  runGolden,
  settledWhenAnswered,
  type GoldenOutcome,
} from "../helpers/golden-run-harness.js";
import { TaskStatus } from "../../tasks/types.js";
import type { ProviderHealthEntry } from "../../agents/providers/provider-health.js";

// ─── The chain ───────────────────────────────────────────────────────────────

const CHAIN = ["deepseek", "kimi"] as const;
/** What each seat's provider class calls itself: the chain, its logs and its health records use these names. */
const DEEPSEEK = "DeepSeek";
const KIMI = "Kimi (Moonshot)";

const HOUR_MS = 60 * 60 * 1000;
/** How long a refused key keeps its seat benched: a person has to change the key. */
const CREDENTIAL_BENCH_MS = 8 * HOUR_MS;
/** How long an overloaded seat of a chain with a sibling is cooled down, on its first episode. */
const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000;

/** The 401 an OpenAI-compatible seat throws once its retries are spent ("<name> API error <status>: <body>"). */
const KEY_REFUSED = `${DEEPSEEK} API error 401: {"error":{"message":"invalid api key","type":"authentication_error"}}`;
/** The 503 it throws once fetch-with-retry has retried the overload and given up. */
const OVERLOADED = `${DEEPSEEK} API error 503: {"error":{"message":"the upstream is overloaded"}}`;

// ─── Script pieces ───────────────────────────────────────────────────────────

const writeCall = (id: string, path: string, content: string) =>
  ({ id, name: "file_write", input: { path, content } });

/** The worker's prompt starts with its task. */
const isWorkerOn = (task: string) =>
  (call: ProviderCall): string | false =>
    !textOf(call.messages[0]).startsWith(task) && `the worker's task is not "${task.slice(0, 60)}…"`;

const carriesResult = (call: ProviderCall, id: string): string | false =>
  !toolResultIds(call.messages.at(-1)).includes(id) && `the last message carries no result for ${id}`;

function planStep(step: string, seat: string, task: string): Step {
  return {
    step,
    seat,
    check: (call) =>
      requires([
        isWorkerOn(task)(call),
        call.messages.length !== 1 && `the run is not fresh: ${call.messages.length} message(s)`,
        offers(call, "file_write") && "a planning turn offers file_write",
      ]),
    reply: say("Plan: write the file with file_write, then report."),
  };
}

function actStep(step: string, seat: string, task: string, writes: ReturnType<typeof writeCall>[]): Step {
  return {
    step,
    seat,
    check: (call) => requires([isWorkerOn(task)(call), !offers(call, "file_write") && "file_write is not offered"]),
    reply: { text: "", toolCalls: writes, stopReason: "tool_use" },
  };
}

function reportStep(step: string, seat: string, task: string, callId: string, done: string): Step {
  return {
    step,
    seat,
    check: (call) => requires([isWorkerOn(task)(call), carriesResult(call, callId)]),
    reply: say(done),
  };
}

/** A worker outside the supervisor has its final draft reviewed before the user sees it. */
function reviewStep(step: string, seat: string, request: string, draft: string): Step {
  return {
    step,
    seat,
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.startsWith("Decide whether the current worker draft is safe to surface") && "this is not the visibility review",
        !prompt.includes(`User request:\n${request}\n`) && `the reviewer is not shown the request "${request.slice(0, 60)}…"`,
        !prompt.includes(`Candidate visible draft:\n${draft}`) && `the reviewer is not shown "${draft}"`,
      ]);
    },
    reply: say('{"decision":"allow","reason":"the requested file is written"}'),
  };
}

/**
 * With the work spread over both seats, one more call writes the user's answer
 * from the reviewed draft (orchestrator synthesizeUserFacingResponse). A chain
 * of one seat never makes it.
 */
function answerStep(step: string, seat: string, request: string, draft: string, answer: string): Step {
  return {
    step,
    seat,
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.startsWith("Create the final user-facing response for this completed orchestrated task.") &&
          "this is not the answer's synthesis",
        !prompt.includes(`Original user request:\n${request}\n`) && `the writer is not shown the request "${request.slice(0, 60)}…"`,
        !prompt.includes(`Worker draft:\n${draft}`) && `the writer is not shown "${draft}"`,
      ]);
    },
    reply: say(answer),
  };
}

/** The step's reply, replaced by the error the seat fails the call with. */
const failsWith = (step: Step, message: string): Step => ({ ...step, reply: new Error(message) });

// ─── Run 1: the first seat's key is refused ──────────────────────────────────

/** Under 60 characters: one worker, no supervisor (golden-run-recovery.test.ts, run 1). */
const REFUSED_REQUEST = "Create notes/lamp.txt containing the word LAMP.";
const LAMP_DONE = "Wrote notes/lamp.txt.";

const REFUSED_SCRIPT: readonly Step[] = [
  failsWith(planStep("plan, on deepseek: its key is refused", "deepseek", REFUSED_REQUEST), KEY_REFUSED),
  planStep("plan, the same call handed to kimi", "kimi", REFUSED_REQUEST),
  actStep("act, on kimi", "kimi", REFUSED_REQUEST, [writeCall("call_lamp", "notes/lamp.txt", "LAMP\n")]),
  reportStep("report, on kimi", "kimi", REFUSED_REQUEST, "call_lamp", LAMP_DONE),
  // deepseek's role when it is healthy. Benched, it is not offered the call.
  reviewStep("review the draft, on kimi", "kimi", REFUSED_REQUEST, LAMP_DONE),
];

// ─── Run 2: the first seat is overloaded mid-task ────────────────────────────

const OVERLOAD_REQUEST = "Create notes/kite.txt containing the word KITE.";
const KITE_DONE = "Wrote notes/kite.txt.";
const KITE_ANSWER = "notes/kite.txt now holds the word KITE.";

const OVERLOAD_SCRIPT: readonly Step[] = [
  planStep("plan, on deepseek", "deepseek", OVERLOAD_REQUEST),
  actStep("act, on kimi", "kimi", OVERLOAD_REQUEST, [writeCall("call_kite", "notes/kite.txt", "KITE\n")]),
  reportStep("report, on kimi", "kimi", OVERLOAD_REQUEST, "call_kite", KITE_DONE),
  failsWith(reviewStep("review the draft, on deepseek: it is overloaded", "deepseek", OVERLOAD_REQUEST, KITE_DONE), OVERLOADED),
  reviewStep("review the draft, the same call handed to kimi", "kimi", OVERLOAD_REQUEST, KITE_DONE),
  // deepseek's role, and it is cooled down: the chain skips it.
  answerStep("write the answer, on kimi", "kimi", OVERLOAD_REQUEST, KITE_DONE, KITE_ANSWER),
];

// ─── What a run left behind ──────────────────────────────────────────────────

/** What bootstrap tells every chat when it starts: not part of any run. */
const SYSTEM_STATUS = expect.stringMatching(/^\*System Status\*\n/);

const texts = (run: GoldenOutcome): string[] => run.delivered.map((m) => m.text);

/** Every provider health record the next boot would restore, by the name it is kept under. */
function healthOnDisk(run: GoldenOutcome): Record<string, ProviderHealthEntry> {
  const saved = JSON.parse(readFileSync(run.providerHealthFile, "utf8")) as { entries?: Array<[string, ProviderHealthEntry]> };
  return Object.fromEntries(saved.entries ?? []);
}

/** The labels FallbackChainProvider logs its attempts under; the worker's own call log uses others. */
const CHAIN_LABELS = new Set(["chat", "streaming"]);

/** The member the chain logged for each attempt, in order: which one failed it, which one served it. */
function chainAttempts(run: GoldenOutcome): string[] {
  return run.logged.flatMap((line) => {
    if (!CHAIN_LABELS.has(String(line.meta["label"]))) return [];
    const member = String(line.meta["provider"]);
    return line.message === "Provider call" ? [`served by ${member}`]
      : line.message === "Provider call failed" ? [`failed on ${member}`]
        : [];
  });
}

/** The seat each answered worker turn was billed to (its servedBy), in order. */
const turnsBilledTo = (run: GoldenOutcome): string[] =>
  run.logged.flatMap((line) =>
    line.message === "Provider call" && line.meta["label"] === "turn" ? [String(line.meta["provider"])] : []);

/** The meta of the first line the run logged that starts with `message`. */
const loggedMeta = (run: GoldenOutcome, message: string): Readonly<Record<string, unknown>> | undefined =>
  run.logged.find((line) => line.message.startsWith(message))?.meta;

/** What the chain warns once a failure leaves it one live member. */
const NO_FALLBACK_LEFT = "Provider chain collapsed to a single working provider";

function expectCleanRun(run: GoldenOutcome, script: readonly Step[]): void {
  expect(run.strayEntries, `the run wrote into ${GOLDEN_WORKING_DIR}`).toEqual([]);
  expect(isolationDisabled(run), "the run had no workspace leases").toEqual([]);
  expect(readdirSync(run.leaseRoot), "a lease was never released").toEqual([]);
  expect(run.violations).toEqual([]);
  expect(run.served).toEqual(script.map((s) => s.step));
}

// ─── The runs ────────────────────────────────────────────────────────────────

describe("golden run: the provider chain fails over to its second seat, through the real bootstrap", () => {
  it("a refused key benches the first seat for the session, and the work finishes on the second", async () => {
    const startedAt = Date.now();
    const run = await runGolden({
      name: "key-refused",
      request: REFUSED_REQUEST,
      script: REFUSED_SCRIPT,
      chain: CHAIN,
      settled: settledWhenAnswered,
    });

    expectCleanRun(run, REFUSED_SCRIPT);
    // Which seat took each call, in order: the refused one once, then never again.
    expect(run.calls.map((c) => c.seat)).toEqual(["deepseek", "kimi", "kimi", "kimi", "kimi"]);
    // The chain handed kimi the very call deepseek refused, not a new one.
    expect(run.calls[1]?.messages).toEqual(run.calls[0]?.messages);
    expect(run.calls[1]?.systemPrompt).toBe(run.calls[0]?.systemPrompt);
    // The chain's own account of it: one failed attempt, and every answer from kimi.
    expect(chainAttempts(run)).toEqual([
      `failed on ${DEEPSEEK}`,
      `served by ${KIMI}`,
      `served by ${KIMI}`,
      `served by ${KIMI}`,
      `served by ${KIMI}`,
    ]);
    // The plan was routed to deepseek and answered by kimi: it is billed to kimi.
    expect(turnsBilledTo(run)).toEqual(["kimi", "kimi", "kimi"]);
    expect(loggedMeta(run, "Provider credential rejected; benched for this session")).toMatchObject({ provider: DEEPSEEK });
    expect(loggedMeta(run, NO_FALLBACK_LEFT)).toMatchObject({ configured: 2, available: 1, liveProvider: KIMI });

    // The health record the next boot restores: deepseek benched for eight
    // hours on the 401 it earned, kimi never failed.
    const health = healthOnDisk(run);
    expect(Object.keys(health)).toEqual(["deepseek"]);
    // One refusal, one failure (until 2026-11-06 it counted two).
    expect(health["deepseek"]).toMatchObject({ status: "down", consecutiveFailures: 1, lastError: KEY_REFUSED.slice(0, 200) });
    expect(health["deepseek"]!.lastFailureAt).toBeGreaterThanOrEqual(startedAt);
    expect(health["deepseek"]!.cooldownUntil - health["deepseek"]!.lastFailureAt).toBe(CREDENTIAL_BENCH_MS);

    // The work reached the project, and the task completed with kimi's answer.
    expect(run.toolResults.map((r) => ({ id: r.toolCallId, isError: r.isError }))).toEqual([
      { id: "call_lamp", isError: false },
    ]);
    expect(readFileSync(join(run.project, "notes", "lamp.txt"), "utf8")).toBe("LAMP\n");
    expect(run.tasks.map((t) => t.status), `task error: ${run.task?.error ?? "none"}`).toEqual([TaskStatus.completed]);
    expect(run.task?.result).toBe(LAMP_DONE);
    expect(run.task?.error).toBeUndefined();

    // What the user read: the answer, and nothing about the seat that failed.
    expect(texts(run)).toEqual([SYSTEM_STATUS, LAMP_DONE]);
  }, GOLDEN_RUN_TIMEOUT_MS);

  it("an overloaded first seat hands its review to the second, is cooled down for minutes, and the second writes the answer", async () => {
    const startedAt = Date.now();
    const run = await runGolden({
      name: "overloaded",
      request: OVERLOAD_REQUEST,
      script: OVERLOAD_SCRIPT,
      chain: CHAIN,
      settled: settledWhenAnswered,
    });

    expectCleanRun(run, OVERLOAD_SCRIPT);
    expect(run.calls.map((c) => c.seat)).toEqual(["deepseek", "kimi", "kimi", "deepseek", "kimi", "kimi"]);
    // The chain handed kimi the very review deepseek failed.
    expect(run.calls[4]?.messages).toEqual(run.calls[3]?.messages);
    expect(chainAttempts(run)).toEqual([
      `served by ${DEEPSEEK}`,
      `served by ${KIMI}`,
      `served by ${KIMI}`,
      `failed on ${DEEPSEEK}`,
      `served by ${KIMI}`,
      `served by ${KIMI}`,
    ]);
    expect(turnsBilledTo(run)).toEqual(["deepseek", "kimi", "kimi"]);
    expect(loggedMeta(run, "Provider failed (")).toMatchObject({ failedProvider: DEEPSEEK, nextProvider: KIMI });
    expect(loggedMeta(run, NO_FALLBACK_LEFT)).toMatchObject({ configured: 2, available: 1, liveProvider: KIMI });

    // Cooled down for the overload's five minutes, not benched for hours.
    const health = healthOnDisk(run);
    expect(Object.keys(health)).toEqual(["deepseek"]);
    expect(health["deepseek"]).toMatchObject({ status: "down", consecutiveFailures: 1, lastError: OVERLOADED.slice(0, 200) });
    expect(health["deepseek"]!.lastFailureAt).toBeGreaterThanOrEqual(startedAt);
    expect(health["deepseek"]!.cooldownUntil - health["deepseek"]!.lastFailureAt).toBe(OVERLOAD_COOLDOWN_MS);

    expect(run.toolResults.map((r) => ({ id: r.toolCallId, isError: r.isError }))).toEqual([
      { id: "call_kite", isError: false },
    ]);
    expect(readFileSync(join(run.project, "notes", "kite.txt"), "utf8")).toBe("KITE\n");
    expect(run.tasks.map((t) => t.status), `task error: ${run.task?.error ?? "none"}`).toEqual([TaskStatus.completed]);
    // The answer kimi wrote in deepseek's place is what the task recorded and the user read.
    expect(run.task?.result).toBe(KITE_ANSWER);
    expect(run.task?.error).toBeUndefined();
    expect(texts(run)).toEqual([SYSTEM_STATUS, KITE_ANSWER]);
  }, GOLDEN_RUN_TIMEOUT_MS);
});
