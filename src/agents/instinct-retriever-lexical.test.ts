/**
 * LEXICAL RETRIEVAL HAS TO MATCH A REAL REQUEST.
 *
 * With no embedding provider the boot notice says learning continues with
 * lexical matching only. Retrieval compares the whole prompt against each
 * trigger, and that blend is symmetric: its edit-distance half is capped by the
 * length ratio, and its token half split on whitespace only, so a snake_case
 * seed ('object_pooling') shared no token with any sentence. A realistic prompt
 * scored ~0.14 against a 0.4 bar and every retrieval came back empty: nothing
 * learned or seeded ever reached a prompt, so nothing was ever credited.
 *
 * These run the real InstinctRetriever, PatternMatcher and LearningStorage, no
 * embedder, with the seeds and the scope context production builds. The
 * opposite direction is pinned too: a prompt that shares one word with a
 * trigger is not about it, and trigger-to-trigger comparison (the pipeline's
 * duplicate check) stays symmetric.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "../learning/storage/learning-storage.js";
import { PatternMatcher, type ScopeContext } from "../learning/matching/pattern-matcher.js";
import { seedStradaConventions } from "../learning/seeds/strada-core-seeds.js";
import { InstinctRetriever } from "./instinct-retriever.js";

let dir: string;
let storage: LearningStorage;
let matcher: PatternMatcher;
let retriever: InstinctRetriever;

// What stage-runtime builds from the config defaults.
const scopeContext: ScopeContext = {
  projectPath: "/projects/apiary",
  scopeFilter: "project+universal",
  maxAgeDays: 90,
  recencyBoost: 1.0,
  scopeBoost: 1.1,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "retriever-lexical-"));
  storage = new LearningStorage(join(dir, "learning.db"));
  storage.initialize();
  await seedStradaConventions(storage);
  matcher = new PatternMatcher(storage);
  retriever = new InstinctRetriever(matcher, { scopeContext, storage });
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

async function triggersFor(prompt: string): Promise<string[]> {
  return (await retriever.getMatchedInstincts(prompt)).map((i) => i.triggerPattern);
}

describe("lexical retrieval matches a request that names a trigger", () => {
  it.each([
    ["Use object pooling for the bees in the swarm module", "object_pooling"],
    ["Register the new PollenLedgerService in the dependency injection container", "dependency_injection"],
    ["Implement the event system that tells the almanac panel the weather changed", "event_system"],
  ])("%s → %s", async (prompt, trigger) => {
    expect(await triggersFor(prompt)).toContain(trigger);

    const { insights, matchedInstinctIds } = await retriever.getInsightsForTask(prompt);
    expect(matchedInstinctIds.length).toBeGreaterThan(0);
    expect(insights.join("\n")).toContain("Strada.Core");
  });

  it("a request that shares one word with a trigger is not about it", async () => {
    expect(await triggersFor("Create a new object for the player and save the system settings")).toEqual([]);
    expect(await triggersFor("Fix the typo in the README")).toEqual([]);
  });

  it("comparing a trigger with a trigger stays symmetric (the pipeline's duplicate check)", async () => {
    // findSimilarInstincts with no request flag is what considerInstinctCreation
    // asks; a new long trigger that merely mentions a seed is not its duplicate.
    const similar = await matcher.findSimilarInstincts("Use object pooling for the bees in the swarm module");
    expect(similar).toEqual([]);
  });
});
