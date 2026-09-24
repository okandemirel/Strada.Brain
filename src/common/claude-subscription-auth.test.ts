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

  // Synchronous and on the setup server's status route: without a bound, a
  // wedged `claude auth status` froze every other client of that server.
  it("bounds `claude auth status` and reports a timeout as CLI-unavailable", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      error: Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });

    const inspection = inspectClaudeSubscriptionAuth({ platform: "linux", env: {} });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "claude",
      ["auth", "status"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    const { timeout } = spawnSyncMock.mock.calls[0]![2] as { timeout: number };
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(10_000);
    expect(inspection.ok).toBe(false);
    expect(inspection.issue).toBe("claude-cli-unavailable");
    expect(inspection.detail).toMatch(/did not answer/);
  });
});
