/**
 * LRN-1 (embedding part): candidate reads on the per-message and per-tool-error
 * paths copied and JSON-parsed every instinct's vector, though only the semantic
 * pass compares vectors. The vectors are read only where that pass runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatternMatcher, type EmbedderLike } from "./pattern-matcher.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { Instinct } from "../types.ts";

const TRIGGER = "CS0246: The type or namespace name 'PlayerController' could not be found";
const VECTOR = [0.6, 0.8, 0];

let dir: string;
let storage: LearningStorage;

function rule(id: string, triggerPattern = TRIGGER): Instinct {
  return {
    id,
    name: id,
    type: "error_fix",
    status: "active",
    confidence: 0.8,
    triggerPattern,
    action: "Add the using directive for the controller namespace",
    contextConditions: [],
    stats: { timesSuggested: 3, timesApplied: 3, timesFailed: 0, successRate: 1 },
    embedding: VECTOR,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Instinct;
}

const embedder: EmbedderLike = {
  embed: async () => ({ vector: VECTOR }),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matcher-embedding-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  storage.createInstinct(rule("rule-a"), "/work/game");
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("instinct reads leave the vector out unless it is compared", () => {
  it("storage reads without the vector keep every other field", () => {
    const full = storage.getInstincts()[0]!;
    const lean = storage.getInstincts({ withEmbedding: false })[0]!;
    expect(full.embedding).toEqual(VECTOR);
    expect(lean.embedding).toBeUndefined();
    expect({ ...lean, embedding: VECTOR }).toEqual(full);

    const scoped = storage.getInstinctsForScope({
      projectPath: "/work/game",
      scopeFilter: "project-only",
      withEmbedding: false,
    });
    expect(scoped.map((i) => i.id)).toEqual(["rule-a"]);
    expect(scoped[0]!.embedding).toBeUndefined();
  });

  it("writing back an instinct read without its vector keeps the stored vector", () => {
    const lean = storage.getInstincts({ withEmbedding: false })[0]!;
    storage.updateInstinct({ ...lean, confidence: 0.85 });
    expect(storage.getInstinct("rule-a")!.embedding).toEqual(VECTOR);
  });

  it("error matching does not read vectors", () => {
    const matches = new PatternMatcher(storage).findInstinctsForError({ errorMessage: TRIGGER });
    expect(matches.map((m) => m.instinct?.id)).toEqual(["rule-a"]);
    expect(matches[0]!.instinct!.embedding).toBeUndefined();
  });

  it("task matching reads vectors only when it has an embedder to compare them with", async () => {
    const lexical = await new PatternMatcher(storage).findSimilarInstincts(TRIGGER);
    expect(lexical[0]!.instinct!.embedding).toBeUndefined();

    // A rule no lexical score reaches is found through its vector.
    storage.createInstinct(rule("rule-semantic", "zzzz qqqq"), "/work/game");
    const semantic = await new PatternMatcher(storage, { embedder }).findSimilarInstincts("unrelated words here", {
      scope: {
        projectPath: "/work/game",
        scopeFilter: "project-only",
        recencyBoost: 1,
        scopeBoost: 1,
      },
    });
    expect(semantic.map((m) => m.instinct?.id)).toContain("rule-semantic");
  });
});
