/**
 * ROUND 11 #1, THE LAST CARRIER — THE PROMPT ITSELF.
 *
 * The leak was only closed once the turn's identity reached the layer that
 * RENDERS artifact guidance. `buildContextLayers` already carried an identity for
 * automatic recall (item 3.9); the "Runtime Self-Improvement" layer below it
 * asked `matchForTask` for guidance with no identity at all, so a private
 * instinct that had been promoted to a runtime artifact was withheld from Bob's
 * instinct retrieval and then written into Bob's system prompt.
 *
 * These tests drive the real LearningStorage and RuntimeArtifactManager, so they
 * measure the text that actually reaches the model.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContextLayers, type ContextBuilderDeps } from "./orchestrator-context-builder.js";
import { LearningStorage } from "../learning/storage/learning-storage.js";
import { RuntimeArtifactManager } from "../learning/runtime-artifact-manager.js";
import type { Instinct, InstinctId } from "../learning/types.js";
import type { TimestampMs } from "../types/index.js";

const PROJECT = "/projects/pixelflow";
const CHAT = "chat-1";
const PROMPT = "Fix the pooling compile error and rerun the build";

let storage: LearningStorage;
let manager: RuntimeArtifactManager;

function makeInstinct(over: Partial<Instinct> & { id: string }): Instinct {
  const now = Date.now() as TimestampMs;
  return {
    id: over.id as InstinctId,
    name: "pooling compile rule",
    type: "tool_usage",
    status: "active",
    confidence: 0.95,
    triggerPattern: "pooling compile error in the build",
    action: "Read the compile output, inspect the pooling files, rerun the build",
    contextConditions: [],
    stats: { timesSuggested: 9, timesApplied: 9, timesFailed: 0, successRate: 1, averageExecutionMs: 10 },
    createdAt: now,
    updatedAt: now,
    sourceTrajectoryIds: [],
    tags: [],
    ...over,
  } as Instinct;
}

/** Materialize the artifact for `instinct` and take it through to 'active'. */
function promoteGuidance(instinct: Instinct): string {
  const { artifact } = manager.materializeShadowArtifact(instinct);
  for (let i = 0; i < 5; i++) {
    manager.recordEvaluation({
      artifactIds: [artifact.id],
      presentedInstinctIds: [String(instinct.id)],
      verdict: "clean",
      blocker: false,
      reason: "Verifier clean with the guidance in the prompt.",
    });
  }
  const promoted = storage.getRuntimeArtifact(artifact.id);
  expect(promoted?.state, "fixture did not reach 'active'").toBe("active");
  return promoted!.guidance;
}

function contextDeps(): ContextBuilderDeps {
  return {
    systemPrompt: "base",
    defaultLanguage: "en",
    projectPath: PROJECT,
    taskClassifier: { classify: () => ({ type: "debugging", confidence: 1 }) },
    toolDefinitions: [],
    toolMetadataByName: new Map(),
    getTaskExecutionContext: () => ({ chatId: CHAT }),
    runtimeArtifactManager: manager,
  } as unknown as ContextBuilderDeps;
}

async function promptFor(userId: string | undefined): Promise<string> {
  const built = await buildContextLayers(
    contextDeps(),
    "goal-scope",
    "exec-scope",
    PROMPT,
    null,
    undefined,
    userId === undefined ? undefined : { userId, projectId: PROJECT },
  );
  return built.context;
}

describe("a private rule's artifact guidance does not reach another person's prompt (r11 #1)", () => {
  beforeEach(() => {
    storage = new LearningStorage(":memory:");
    storage.initialize();
    manager = new RuntimeArtifactManager(storage);
  });

  afterEach(() => {
    storage.close();
  });

  it("PROOF: Alice's promoted private rule is written into her prompt and nobody else's", async () => {
    const alices = makeInstinct({ id: "instinct_alice_prompt", scopeType: "user", userId: "alice" });
    storage.createInstinct(alices, PROJECT);
    const guidance = promoteGuidance(alices);

    // TEETH: this layer asked for guidance with no identity, so the same text
    // landed in every caller's prompt.
    expect(await promptFor("alice")).toContain(guidance);
    expect(await promptFor("bob"), "Alice's private guidance was written into Bob's prompt").not.toContain(guidance);
    expect(await promptFor(undefined), "Alice's private guidance reached an unidentified turn").not.toContain(guidance);
  });

  it("GUARD: shared project guidance still reaches every prompt, identified or not", async () => {
    const shared = makeInstinct({ id: "instinct_shared_prompt", scopeType: "project" });
    storage.createInstinct(shared, PROJECT);
    const guidance = promoteGuidance(shared);

    for (const userId of ["alice", "bob", undefined]) {
      expect(await promptFor(userId), `shared guidance went dark for ${userId ?? "an unidentified turn"}`).toContain(
        guidance,
      );
    }
  });
});
