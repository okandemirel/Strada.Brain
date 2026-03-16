import { describe, it, expect } from "vitest";

describe("BackgroundExecutor.hasRunningTasks", () => {
  it("should return false when no tasks running or queued", async () => {
    const { BackgroundExecutor } = await import(
      "../../tasks/background-executor.js"
    );
    const executor = new BackgroundExecutor({
      orchestrator: { run: async () => ({}) } as any,
      concurrencyLimit: 2,
    });
    expect(executor.hasRunningTasks()).toBe(false);
  });
});
