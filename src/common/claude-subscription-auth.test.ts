import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { inspectClaudeSubscriptionAuth } from "./claude-subscription-auth.js";

describe("claude subscription auth helpers", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("accepts an explicit Claude auth token without probing the CLI", () => {
    const inspection = inspectClaudeSubscriptionAuth({
      authToken: "claude-subscription-token-123456",
    });

    expect(inspection.ok).toBe(true);
    expect(inspection.authToken).toBe("claude-subscription-token-123456");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("uses the Windows Claude CLI command with shell execution", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
      }),
    });

    const inspection = inspectClaudeSubscriptionAuth({
      platform: "win32",
    });

    expect(inspection.ok).toBe(false);
    expect(inspection.issue).toBe("missing-auth-token");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "claude.cmd",
      ["auth", "status"],
      expect.objectContaining({
        encoding: "utf8",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });
});
