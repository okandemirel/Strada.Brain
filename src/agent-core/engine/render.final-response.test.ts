/**
 * LRN-20b: the interactive terminal answer is the run's final response. It is
 * sent with the run's learned-warning footer and the attribution a reaction on
 * it resolves to; a deps object without `runResponse` sends it bare.
 */
import { describe, expect, it, vi } from "vitest";
import { emitVisibleBoundary, type RenderDeps } from "./render.js";
import type { Session } from "../../agents/orchestrator-session-manager.js";

function deps(runResponse?: RenderDeps["runResponse"]) {
  const sendVisibleAssistantMarkdown = vi.fn().mockResolvedValue(undefined);
  return {
    sendVisibleAssistantMarkdown,
    deps: {
      sessionManager: { sendVisibleAssistantMarkdown },
      defaultLanguage: "en",
      ...(runResponse ? { runResponse } : {}),
    } as unknown as RenderDeps,
  };
}

const session = { messages: [] } as unknown as Session;

describe("emitVisibleBoundary sends the run's final response (LRN-20b)", () => {
  it("passes the run's footer and attribution with the answer", async () => {
    const attribution = { instinctIds: ["a"], warnedRules: [], runId: "run-1", requesterUserId: "u1" };
    const runResponse = vi.fn(() => ({ attribution, footer: "⚠️ Learned rule warned before x: y" }));
    const { deps: d, sendVisibleAssistantMarkdown } = deps(runResponse);

    await emitVisibleBoundary(d, "chat-1", session, "Done.");

    expect(runResponse).toHaveBeenCalledWith("chat-1");
    expect(sendVisibleAssistantMarkdown).toHaveBeenCalledWith("chat-1", session, "Done.", {
      footer: "⚠️ Learned rule warned before x: y",
      responseAttribution: attribution,
    });
  });

  it("sends the answer bare without a runResponse dep, and nothing for an empty answer", async () => {
    const bare = deps();
    await emitVisibleBoundary(bare.deps, "chat-1", session, "Done.");
    expect(bare.sendVisibleAssistantMarkdown).toHaveBeenCalledWith("chat-1", session, "Done.", undefined);

    const runResponse = vi.fn();
    const empty = deps(runResponse);
    await emitVisibleBoundary(empty.deps, "chat-1", session, "");
    expect(empty.sendVisibleAssistantMarkdown).not.toHaveBeenCalled();
    expect(runResponse).not.toHaveBeenCalled();
  });
});
