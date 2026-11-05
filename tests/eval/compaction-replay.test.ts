/**
 * The offline compaction A/B harness: scripts/eval/compaction-replay.mjs.
 *
 * It must say what it measured. A log replay is a shape replay (real sizes,
 * placeholder content) and says so first. A recorded transcript goes through
 * the same arms. An input with no replayable call is "not measured", never an
 * empty table. The log lines and the transcript here are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLIFF, EXIT, armsFor, main, parseArgs, parseCliff } from "../../scripts/eval/compaction-replay.mjs";

let dir = "";
let out = "";
let err = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-replay-"));
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err += `${args.join(" ")}\n`;
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const turn = (m: number, history: number) =>
  JSON.stringify({
    timestamp: "2026-11-05 10:00:00",
    level: "info",
    message: "Provider call",
    label: "turn",
    chatId: "chat-a",
    messages: m,
    inputTokens: 12_000 + history,
    outputTokens: 100,
    toolCalls: 1,
    promptChars: 40_000,
    toolChars: 8_000,
  });
const tool = (bytes: number) => JSON.stringify({ level: "info", message: "Tool call", chatId: "chat-a", tool: "file_read", ok: true, bytes });

function writeLog(lines: string[]): string {
  const log = join(dir, "strada-brain.log");
  writeFileSync(log, `${lines.join("\n")}\n`);
  return log;
}

describe("compaction-replay arguments", () => {
  it("defaults to one cliff arm and derives the minimum reclaim when it is left out", () => {
    const args = parseArgs([]);
    expect(args.cliffs).toEqual([parseCliff(DEFAULT_CLIFF).cliff]);
    expect(parseCliff("64000:24000")).toEqual({ cliff: { triggerTokens: 64_000, floorTokens: 24_000, minReclaimTokens: 10_000 } });
    expect(armsFor(parseArgs(["--cliff", "64000:24000"]).cliffs).map((a: { name: string }) => a.name)).toEqual([
      "append-only (reference)",
      "current (session-compaction.ts)",
      "cliff 64k->24k, min 10k",
    ]);
  });

  it("refuses what it cannot read", () => {
    expect(parseArgs(["--cliff", "16000:48000"]).error).toMatch(/trigger must be above the floor/);
    expect(parseArgs(["--cliff", "48k:16k"]).error).toMatch(/trigger:floor/);
    expect(parseArgs(["--log", "a.log", "--transcript", "b.json"]).error).toMatch(/exclusive/);
    expect(parseArgs(["--price-uncached", "1"]).error).toMatch(/go together/);
    expect(parseArgs(["--context-window", "lots"]).error).toMatch(/positive integer/);
    expect(parseArgs(["--since", "yesterday"]).error).toMatch(/not a time/);
    expect(parseArgs(["--loud"]).error).toMatch(/unknown argument/);
  });
});

describe("compaction-replay", () => {
  it("labels a log replay as a shape replay and prints one row per arm", async () => {
    const lines = [turn(1, 500)];
    for (let i = 1; i < 30; i++) lines.push(tool(16_000), turn(1 + 2 * i, 500 + i * 4_100));
    const code = await main(["--log", writeLog(lines), "--cliff", "40000:12000"]);
    expect(code).toBe(EXIT.PRINTED);
    expect(out.split("\n")[0]).toMatch(/^Compaction A\/B, offline: SHAPE REPLAY, NOT CONTENT\./);
    expect(out).toMatch(/1 session\(s\), 30 call\(s\); context window 128,000/);
    expect(out).toMatch(/^append-only \(reference\)/m);
    expect(out).toMatch(/^current \(session-compaction\.ts\)/m);
    expect(out).toMatch(/^cliff 40k->12k, min 7k/m);
    // Append-only outgrows 128k by the last calls: it is named as no option, the compacting arms are not.
    expect(out).toMatch(/^NOT VIABLE at a 128,000-token window: "append-only \(reference\)" sent \d+ of 30 call\(s\)/m);
    expect(out.match(/^NOT VIABLE/gm)).toHaveLength(1);
    expect(out).toMatch(/tool results: 29 sized from their "Tool call" line/);
    expect(out).toMatch(/not measured here:/);
  });

  it("replays a recorded transcript through the same arms, as JSON when asked", async () => {
    const transcript = join(dir, "transcript.json");
    const say = (role: string, text: string) => ({ role, content: text });
    writeFileSync(
      transcript,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "guide",
            turns: [
              { promptChars: 4_000, toolChars: 0, append: [say("user", "Summarise the field guide.")] },
              { promptChars: 4_000, toolChars: 0, append: [say("assistant", "Here is the outline."), say("user", "Add the nesting months.")] },
            ],
          },
        ],
      }),
    );
    const code = await main(["--transcript", transcript, "--json", "--price-uncached", "1.2", "--price-cached", "0.024"]);
    expect(code).toBe(EXIT.PRINTED);
    const report = JSON.parse(out);
    expect(report.source).toBe("transcript");
    expect(report.arms.map((a: { calls: number }) => a.calls)).toEqual([2, 2, 2]);
    expect(report.priceNote).toBe("1.2 / 0.024 per million tokens (uncached / cached)");
    expect(report.skeleton).toBeUndefined();
    expect(report.notMeasured.length).toBeGreaterThan(0);
  });

  it("names the first schema error of a transcript it cannot read", async () => {
    const transcript = join(dir, "broken.json");
    writeFileSync(transcript, JSON.stringify({ version: 1, sessions: [{ id: "x", turns: [{ promptChars: -1, toolChars: 0, append: [] }] }] }));
    expect(await main(["--transcript", transcript])).toBe(EXIT.USAGE);
    expect(err).toMatch(/not a replay transcript: sessions\.0\.turns\.0\.promptChars/);
  });

  it("says NOT MEASURED when no call can be replayed", async () => {
    const code = await main(["--log", writeLog([JSON.stringify({ level: "info", message: "Daemon booted" })])]);
    expect(code).toBe(EXIT.NOT_MEASURED);
    expect(err).toMatch(/NOT MEASURED: no call could be replayed/);
  });

  it("refuses a log path with nothing at it", async () => {
    expect(await main(["--log", join(dir, "missing.log")])).toBe(EXIT.USAGE);
    expect(err).toMatch(/no daemon log at/);
  });
});
