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

describe("requestWriteConfirmation: batch_execute (ORC-22)", () => {
  const request = (requestConfirmation: ReturnType<typeof vi.fn>) =>
    requestConfirmation.mock.calls[0]![0] as { question: string; details: string };

  it("names each operation's command or path, not only the tool counts", async () => {
    const { channel, requestConfirmation } = interactiveChannel();

    await requestWriteConfirmation(channel, "chat", "user", "batch_execute", {
      operations: [
        { tool: "shell_exec", input: { command: "rm -rf Assets/Art" } },
        { tool: "file_write", input: { path: "Assets/Scripts/Player.cs", content: "class Player {}" } },
        { tool: "file_rename", input: { old_path: "Assets/A.cs", new_path: "Assets/B.cs" } },
      ],
    });

    const { question, details } = request(requestConfirmation);
    expect(question).toContain("3 operations");
    expect(details).toContain("shell_exec: rm -rf Assets/Art");
    expect(details).toContain("file_write: Assets/Scripts/Player.cs");
    expect(details).toContain("file_rename: Assets/A.cs → Assets/B.cs");
    expect(details).not.toContain("class Player");
  });

  it("caps the list and the length of each target", async () => {
    const { channel, requestConfirmation } = interactiveChannel();
    const operations = Array.from({ length: 25 }, (_, i) => ({
      tool: "file_write",
      input: { path: `Assets/${"deep/".repeat(40)}File${i}.cs` },
    }));

    await requestWriteConfirmation(channel, "chat", "user", "batch_execute", { operations });

    const { details } = request(requestConfirmation);
    expect(details.split("\n").filter((line) => line.startsWith("- file_write"))).toHaveLength(10);
    expect(details).toContain("…and 15 more");
    expect(details.length).toBeLessThan(2_000);
  });
});
