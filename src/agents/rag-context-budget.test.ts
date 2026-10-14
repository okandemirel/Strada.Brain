/**
 * RAG_CONTEXT_MAX_TOKENS (documented "default 4000, range 500..16000") was
 * parsed, validated and stored, and nothing read it: the per-turn context build
 * capped retrieved context at a hardcoded 4000 tokens, so an operator who set
 * 12000 to widen RAG context changed nothing.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildSystemPromptWithContext, type ContextBuilderDeps } from "./orchestrator-context-builder.js";
import type { IRAGPipeline, SearchResult } from "../rag/rag.interface.js";
import { createLogger } from "../utils/logger.js";

function hit(id: string): SearchResult {
  return {
    chunk: {
      id,
      filePath: `Assets/${id}.cs`,
      content: `public class ${id} {}`,
      startLine: 1,
      endLine: 1,
      kind: "class",
      symbol: id,
    },
    vectorScore: 0.9,
    finalScore: 0.9,
  } as unknown as SearchResult;
}

function ragPipelineCapped(contextMaxTokens: number) {
  const formatContextWithSpans = vi.fn((results: SearchResult[]) => ({
    text: "rag context",
    included: results,
    dropped: [],
  }));
  const pipeline = {
    contextMaxTokens,
    search: vi.fn(async () => [hit("IrrigationScheduler")]),
    formatContext: vi.fn(() => "rag context"),
    formatContextWithSpans,
  } as unknown as IRAGPipeline;
  return { pipeline, formatContextWithSpans };
}

function deps(ragPipeline: IRAGPipeline): ContextBuilderDeps {
  return {
    systemPrompt: "base",
    defaultLanguage: "en",
    projectPath: "/projects/game",
    ragPipeline,
    soulLoader: null,
    activeGoalTrees: new Map(),
    taskClassifier: { classify: () => ({ type: "general", confidence: 1 }) },
    toolDefinitions: [],
    toolMetadataByName: new Map(),
    trajectoryReplayRetriever: null,
  } as unknown as ContextBuilderDeps;
}

async function build(ragPipeline: IRAGPipeline, providerContextWindow: number) {
  return buildSystemPromptWithContext(deps(ragPipeline), {
    chatId: "chat-1",
    conversationScope: "chat-1",
    identityKey: "user-1",
    prompt: "how does the irrigation scheduler pick a valve",
    profile: null,
    providerContextWindow,
  });
}

describe("RAG context budget reads RAG_CONTEXT_MAX_TOKENS", () => {
  beforeAll(() => {
    createLogger("error", "/tmp/strada-rag-context-budget-test.log");
  });

  it("injects up to the configured cap when the context window has room", async () => {
    const { pipeline, formatContextWithSpans } = ragPipelineCapped(12_000);

    await build(pipeline, 1_000_000);

    expect(formatContextWithSpans).toHaveBeenCalledTimes(1);
    expect(formatContextWithSpans.mock.calls[0]![1]).toMatchObject({ maxTokens: 12_000 });
  });

  it("still keeps retrieved context inside 5% of a small context window", async () => {
    const { pipeline, formatContextWithSpans } = ragPipelineCapped(12_000);

    await build(pipeline, 32_000);

    expect(formatContextWithSpans.mock.calls[0]![1]).toMatchObject({ maxTokens: 1_600 });
  });
});
