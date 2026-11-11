/**
 * The phase rule is decided once per model turn, on the calls, and nothing but the session reads
 * a refused one.
 *
 * Three QA rounds on 2026-11-11 found a reader that counted a refused write: the step records
 * (the verifier, the reflection cadence, the DONE check), the run's executed-tool sequence (the
 * supervisor's node verifier), and the plan-review gate, whose count came from the call list
 * before any result existed. Each fix taught one more reader to skip the refusal, and the next
 * reader was the next finding. So the spine splits a turn's calls once (splitCallsByPhase) and
 * hands every reader the calls that run. The tripwire below names each place that may still read
 * what the model made or what was refused; a new one turns it red.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentPhase } from "../../agents/agent-state.js";
import type { ToolCall } from "../../agents/providers/provider-core.interface.js";
import {
  allCallsRun,
  isPhaseWriteRefusal,
  phaseWriteRefusal,
  splitCallsByPhase,
  toolNamesRunnableIn,
  type PhaseRefuses,
} from "./phase-write-access.js";

const call = (id: string, name: string): ToolCall => ({ id, name, input: {} });
const refusesWrites: PhaseRefuses = (name, phase) => name === "file_write" && phase !== AgentPhase.EXECUTING;

describe("splitCallsByPhase", () => {
  it("keeps the model's order, runs what the phase allows and answers each refused call", () => {
    const made = [call("r1", "file_read"), call("w1", "file_write"), call("r2", "file_read")];
    const split = splitCallsByPhase(made, AgentPhase.PLANNING, refusesWrites);

    expect(split.asMade).toEqual(made);
    expect(split.runnable.map((c) => c.id)).toEqual(["r1", "r2"]);
    expect([...split.refusals.keys()]).toEqual(["w1"]);
    const refusal = split.refusals.get("w1")!;
    expect(refusal).toMatchObject({ toolCallId: "w1", content: phaseWriteRefusal(AgentPhase.PLANNING), isError: true });
    expect(isPhaseWriteRefusal(refusal)).toBe(true);
  });

  it("refuses nothing in a phase that writes, and allCallsRun refuses nothing at all", () => {
    const made = [call("w1", "file_write")];
    expect(splitCallsByPhase(made, AgentPhase.EXECUTING, refusesWrites).runnable).toEqual(made);
    expect(splitCallsByPhase(made, AgentPhase.EXECUTING, refusesWrites).refusals.size).toBe(0);
    expect(allCallsRun(made)).toEqual({ asMade: made, runnable: made, refusals: new Map() });
  });

  it("names the tools that run now: the offered list read as 'what can run in this phase'", () => {
    const names = ["file_read", "file_write"];
    expect(toolNamesRunnableIn(names, AgentPhase.REFLECTING, refusesWrites)).toEqual(["file_read"]);
    expect(toolNamesRunnableIn(names, AgentPhase.EXECUTING, refusesWrites)).toEqual(names);
  });
});

// ─── Tripwire: who may read what the model made ──────────────────────────────

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) && !/\.d\.ts$/.test(entry) ? [path] : [];
  });
}

/** Code lines (comments left out) of `file` that match `pattern`, trimmed. */
function codeLines(file: string, pattern: RegExp): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !/^(?:\/\/|\*|\/\*)/.test(line) && pattern.test(line));
}

/** Each allowed reader: the line's content key, how many lines carry it, and why it may read. */
interface Reader {
  readonly key: string;
  readonly count: number;
  readonly why: string;
}

function unnamedReaders(lines: readonly string[], readers: readonly Reader[]): string[] {
  const left = [...lines];
  for (const reader of readers) {
    for (let n = 0; n < reader.count; n++) {
      const at = left.findIndex((line) => line.includes(reader.key));
      if (at >= 0) left.splice(at, 1);
    }
  }
  return left;
}

function missingReaders(lines: readonly string[], readers: readonly Reader[]): string[] {
  return readers
    .filter((reader) => lines.filter((line) => line.includes(reader.key)).length !== reader.count)
    .map((reader) => `${reader.key} (expected on ${reader.count} line(s))`);
}

/**
 * Who reads the split's raw members: `asMade` (every call the model made) and `refusals` (the
 * answer each refused call gets). Only the session's answers and the daemon log's count.
 */
const SPLIT_READERS: Record<string, readonly Reader[]> = {
  "agent-core/runner/v2-agent-runner.ts": [
    { key: "if (calls.asMade.length > 0) {", count: 2, why: "a turn that made any call goes through the tool turn, so each tool_use is answered" },
    { key: "if (calls.refusals.size > 0) {", count: 1, why: "the daemon log counts the refused writes" },
    { key: "calls.asMade.filter((tc) => calls.refusals.has(tc.id))", count: 1, why: "the log line names them" },
  ],
  "agent-core/engine/tool-turn.ts": [
    { key: "const answers = calls.asMade.flatMap(", count: 1, why: "the session answers every call the model made, in its order" },
    { key: "calls.refusals.get(tc.id)", count: 1, why: "a refused call is answered by its refusal" },
  ],
  "agents/orchestrator-loop-shared.ts": [
    { key: "const asMade = split?.asMade ?? toolCalls;", count: 1, why: "the calls the model made, or those given when nothing was split" },
    { key: "tool_calls: [...asMade],", count: 1, why: "the assistant turn carries every call the model made" },
    { key: "split?.refusals.values()", count: 1, why: "a failed batch still answers every call, a refused one by its refusal" },
  ],
};

/** Who reads a model turn's raw call list in the spine, where the turn arrives. */
const RAW_CALL_READERS: readonly Reader[] = [
  { key: "splitCallsByPhase(outcome.response.toolCalls,", count: 1, why: "the one split" },
  {
    key: 'outcome.response.stopReason === "max_tokens" && outcome.response.toolCalls.length === 0',
    count: 1,
    why: "the shape of a truncated turn: one with calls falls through to them, whatever the phase does with them",
  },
];

describe("tripwire: the readers of a model turn's calls", () => {
  it("nothing but the session and the daemon log reads what the model made or what was refused", () => {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === "agent-core/engine/phase-write-access.ts") continue; // the producer
      const lines = codeLines(file, /\.(?:asMade|refusals)\b/);
      if (lines.length > 0) found[rel] = lines;
    }

    const unnamed = Object.entries(found).flatMap(([rel, lines]) =>
      unnamedReaders(lines, SPLIT_READERS[rel] ?? []).map((line) => `${rel}: ${line}`),
    );
    expect(
      unnamed,
      "a new reader of a refused call: read `calls.runnable` (agent-core/engine/phase-write-access.ts), or name it in SPLIT_READERS with why it must see what the model made",
    ).toEqual([]);
    const missing = Object.entries(SPLIT_READERS).flatMap(([rel, readers]) =>
      missingReaders(found[rel] ?? [], readers).map((m) => `${rel}: ${m}`),
    );
    expect(missing, "a named reader moved or went: update SPLIT_READERS").toEqual([]);
  });

  it("the spine reads a turn's raw call list only to split it and to tell a truncated turn", () => {
    const lines = codeLines(join(SRC, "agent-core/runner/v2-agent-runner.ts"), /\bresponse\.toolCalls\b/);

    expect(
      unnamedReaders(lines, RAW_CALL_READERS),
      "a new reader of the turn's raw calls: read the split's `calls.runnable`, or name it in RAW_CALL_READERS",
    ).toEqual([]);
    expect(missingReaders(lines, RAW_CALL_READERS)).toEqual([]);
  });

  it("the tool turn takes its calls from the split, and everything after reads the calls that run", () => {
    const toolTurn = join(SRC, "agent-core/engine/tool-turn.ts");
    expect(codeLines(toolTurn, /\bargs\[0\]/)).toEqual([
      "const calls = (args[5] as PhaseCallSplit | undefined) ?? allCallsRun(args[0] as ToolCall[]);",
    ]);
    expect(codeLines(toolTurn, /const toolCalls = /)).toEqual(["const toolCalls = [...calls.runnable];"]);

    const runner = join(SRC, "agent-core/runner/v2-agent-runner.ts");
    // The plan-review count, the tool events and the port's tool turn take the calls that run.
    expect(codeLines(runner, /toolCallCount:/)).toEqual(["toolCallCount: calls.runnable.length,"]);
    expect(codeLines(runner, /type: "tool\.started"/)).toHaveLength(2);
    expect(codeLines(runner, /for \(const tc of calls\.runnable\) \{/)).toHaveLength(2);
    expect(codeLines(runner, /port\.executeToolCalls\(/)).toEqual([
      "port.executeToolCalls(calls.runnable, setup.session, state, response.text, runScope, calls),",
    ]);
  });
});
