import { describe, it, expect, vi } from "vitest";
import { requestWriteConfirmation } from "./orchestrator-write-gate.js";
import type { IChannelSender } from "../channels/channel-core.interface.js";

function interactiveChannel() {
  const requestConfirmation = vi.fn().mockResolvedValue("Yes");
  const channel = { sendText: vi.fn(), sendMarkdown: vi.fn(), requestConfirmation } as unknown as IChannelSender;
  return { channel, requestConfirmation };
}

describe("requestWriteConfirmation: git_push", () => {
  // The prompt used to read "Confirm git push to remote?" with only the
  // remote in the details, so a human approved a push without seeing what
  // was being pushed.
  it("names the branch and the remote in the question and the details", async () => {
    const { channel, requestConfirmation } = interactiveChannel();

    const outcome = await requestWriteConfirmation(channel, "chat", "user", "git_push", {
      remote: "upstream",
      branch: "feature/login",
      set_upstream: true,
    });

    expect(outcome).toBe("approved");
    const request = requestConfirmation.mock.calls[0]![0] as { question: string; details: string };
    expect(request.question).toContain("feature/login");
    expect(request.question).toContain("upstream");
    expect(request.details).toContain("feature/login");
    expect(request.details).toContain("to upstream");
    expect(request.details).toContain("set it as upstream");
  });

  it("says the current branch and the default remote when neither is given", async () => {
    const { channel, requestConfirmation } = interactiveChannel();

    await requestWriteConfirmation(channel, "chat", "user", "git_push", {});

    const request = requestConfirmation.mock.calls[0]![0] as { question: string; details: string };
    expect(request.question).toContain("current branch");
    expect(request.question).toContain("origin");
  });
});
