import { describe, it, expect, vi } from "vitest";
import {
  PatternMatcher,
  boundedLevenshtein,
  combinedSimilarity,
  stringSimilarity,
  MAX_EDIT_DISTANCE_CHARS,
} from "./pattern-matcher.ts";
import type { LearningStorage } from "../storage/learning-storage.ts";
import type { Instinct } from "../types.ts";

/** The full-matrix distance the matcher used to compute, as the reference. */
function referenceLevenshtein(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= b.length; i++) rows[i] = [i];
  for (let j = 0; j <= a.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      rows[i]![j] = b[i - 1] === a[j - 1]
        ? rows[i - 1]![j - 1]!
        : Math.min(rows[i - 1]![j - 1]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j]! + 1);
    }
  }
  return rows[b.length]![a.length]!;
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const WORDS = [
  "the", "type", "namespace", "could", "not", "be", "found", "missing", "assembly", "reference",
  "player", "controller", "system", "entity", "component", "module", "build", "error", "warning", "unity",
  "scene", "prefab", "asset", "shader", "compile", "runtime", "null", "object", "instance", "method",
];

function words(random: () => number, chars: number): string {
  const out: string[] = [];
  let length = 0;
  while (length < chars) {
    const word = WORDS[Math.floor(random() * WORDS.length)]! + (random() < 0.3 ? String(Math.floor(random() * 100)) : "");
    out.push(word);
    length += word.length + 1;
  }
  return out.join(" ").slice(0, chars);
}

function instinct(id: number, triggerPattern: string, action: string): Instinct {
  return {
    id: `instinct_perf_${id}`,
    name: `rule ${id}`,
    type: "error_fix",
    status: "active",
    confidence: 0.8,
    triggerPattern,
    action,
    contextConditions: [],
    stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0, averageExecutionMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceTrajectoryIds: [],
    tags: [],
  } as unknown as Instinct;
}

function storageWith(instincts: Instinct[]): LearningStorage {
  return {
    getInstincts: vi.fn(() => instincts),
    getInstinctsForScope: vi.fn(() => instincts),
    mergeInstincts: vi.fn(),
  } as unknown as LearningStorage;
}

describe("bounded edit distance (LRN-1)", () => {
  it("equals the full-matrix distance, and reports 'over' exactly when the bound is exceeded", () => {
    const random = rng(7);
    const alphabet = "abcde ";
    const draw = (max: number) =>
      Array.from({ length: Math.floor(random() * max) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    for (let trial = 0; trial < 600; trial++) {
      const a = draw(40);
      const b = draw(40);
      const exact = referenceLevenshtein(a, b);
      expect(boundedLevenshtein(a, b), `${a} | ${b}`).toBe(exact);
      const bound = Math.floor(random() * 30);
      const bounded = boundedLevenshtein(a, b, bound);
      if (exact <= bound) expect(bounded, `${a} | ${b} @${bound}`).toBe(exact);
      else expect(bounded, `${a} | ${b} @${bound}`).toBe(bound + 1);
    }
  });

  it("scores short strings exactly as before whenever the score clears the floor", () => {
    const random = rng(11);
    for (let trial = 0; trial < 300; trial++) {
      const a = words(random, 20 + Math.floor(random() * 120));
      const b = random() < 0.5 ? a.replace(/e/g, "a") : words(random, 20 + Math.floor(random() * 120));
      const old = a === b ? 1 : 1 - referenceLevenshtein(a, b) / Math.max(a.length, b.length);
      expect(stringSimilarity(a, b)).toBeCloseTo(old, 12);
      for (const floor of [0.3, 0.5, 0.7, 0.85]) {
        const bounded = stringSimilarity(a, b, floor);
        if (old >= floor) expect(bounded).toBeCloseTo(old, 12);
        else expect(bounded).toBeLessThan(floor);
      }
    }
  });

  it("does not score a short pattern as a copy of a long text that merely starts with it", () => {
    const pattern = "CS0246 the type or namespace name could not be found";
    const text = pattern + " " + "x".repeat(MAX_EDIT_DISTANCE_CHARS * 20);
    // The whole-length ceiling: at best min/max of the full lengths.
    expect(stringSimilarity(pattern, text)).toBeLessThanOrEqual(pattern.length / text.length);
    // Two long texts that agree on their compared prefix still read as near-copies.
    const long = "y".repeat(MAX_EDIT_DISTANCE_CHARS * 4);
    expect(stringSimilarity(long, long + "z")).toBeGreaterThan(0.99);
  });

  it("combinedSimilarity keeps the dedup decision the unbounded blend made", () => {
    const random = rng(23);
    for (let trial = 0; trial < 200; trial++) {
      const a = words(random, 30 + Math.floor(random() * 60));
      const b = random() < 0.5 ? `${a} again` : words(random, 30 + Math.floor(random() * 60));
      const exact = combinedSimilarity(a, b);
      const bounded = combinedSimilarity(a, b, 0.85);
      expect(bounded >= 0.85).toBe(exact >= 0.85);
      if (exact >= 0.85) expect(bounded).toBeCloseTo(exact, 12);
    }
  });
});

describe("lexical matching on hot paths stays bounded (LRN-1)", () => {
  it("a 20 KB prompt against 500 stored rules does not block the event loop", async () => {
    const random = rng(3);
    const instincts = Array.from({ length: 500 }, (_, i) => instinct(i, words(random, 200), words(random, 120)));
    const matcher = new PatternMatcher(storageWith(instincts));
    const prompt = words(random, 20_000);

    const started = performance.now();
    await matcher.findSimilarInstincts(prompt, {
      minSimilarity: 0.4,
      maxResults: 15,
      scope: { projectPath: "/p", scopeFilter: "project+global", recencyBoost: 1, scopeBoost: 1.1 },
    });
    const elapsed = performance.now() - started;
    // The full-matrix version took tens of seconds here (about 12 ms per rule).
    expect(elapsed).toBeLessThan(500);
  }, 120_000);

  it("an 8 KB tool error through findInstinctsForError does not block the event loop", () => {
    const random = rng(5);
    const instincts = Array.from({ length: 500 }, (_, i) => instinct(i, words(random, 200), words(random, 120)));
    const matcher = new PatternMatcher(storageWith(instincts));
    const error = words(random, 8_000);

    const started = performance.now();
    matcher.findInstinctsForError({ errorMessage: error }, { minConfidence: 0.5, maxResults: 3 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
  }, 120_000);

  it("a long error that equals a rule's trigger still matches it", () => {
    const random = rng(9);
    const trigger = words(random, 3_000);
    const matcher = new PatternMatcher(storageWith([instinct(1, trigger, "rebuild the assembly")]));
    const [match] = matcher.findInstinctsForError({ errorMessage: trigger }, { minConfidence: 0.1 });
    expect(match?.instinct?.id).toBe("instinct_perf_1");
  });
});
