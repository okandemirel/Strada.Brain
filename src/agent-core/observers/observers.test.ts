import { describe, it, expect, vi, beforeEach } from "vitest";
import { TriggerObserver } from "./trigger-observer.js";
import { UserActivityObserver } from "./user-activity-observer.js";
import { BuildStateObserver } from "./build-state-observer.js";
import { GitStateObserver } from "./git-state-observer.js";
import { FileWatchObserver } from "./file-watch-observer.js";
import { TestResultObserver } from "./test-result-observer.js";

describe("TriggerObserver", () => {
  it("reports fired triggers", () => {
    const registry = {
      getAll: () => [
        { metadata: { name: "daily-check", type: "cron", description: "Run tests" }, getState: () => "fired" },
        { metadata: { name: "backup", type: "cron" }, getState: () => "active" },
      ],
    };
    const observer = new TriggerObserver(registry);
    const obs = observer.collect();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.source).toBe("trigger");
    expect(obs[0]!.summary).toContain("daily-check");
  });

  it("returns empty when no triggers fired", () => {
    const registry = {
      getAll: () => [
        { metadata: { name: "idle", type: "cron" }, getState: () => "active" },
      ],
    };
    const observer = new TriggerObserver(registry);
    expect(observer.collect()).toHaveLength(0);
  });
});

describe("UserActivityObserver", () => {
  it("reports idle state change", () => {
    vi.useFakeTimers();
    const observer = new UserActivityObserver(60_000); // 1 min idle
    observer.recordActivity();

    expect(observer.collect()).toHaveLength(0); // Not idle yet

    vi.advanceTimersByTime(61_000);
    const obs = observer.collect();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.summary).toContain("idle");

    // Second collect — no change, no report
    expect(observer.collect()).toHaveLength(0);

    vi.useRealTimers();
  });

  it("reports return from idle", () => {
    vi.useFakeTimers();
    const observer = new UserActivityObserver(60_000);

    vi.advanceTimersByTime(61_000);
    observer.collect(); // Become idle

    observer.recordActivity(); // Return
    const obs = observer.collect();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.summary).toContain("returned");

    vi.useRealTimers();
  });
});

describe("BuildStateObserver", () => {
  it("reports build failure", () => {
    const buildState = {
      getState: () => ({
        pendingFiles: new Set(["src/foo.cs"]),
        hasCompilableChanges: true,
        lastBuildOk: false,
      }),
    };
    const observer = new BuildStateObserver(buildState);
    const obs = observer.collect();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.priority).toBe(85);
    expect(obs[0]!.summary).toContain("failed");
  });

  it("only reports state changes", () => {
    const buildState = {
      getState: () => ({
        pendingFiles: new Set<string>(),
        hasCompilableChanges: false,
        lastBuildOk: null,
      }),
    };
    const observer = new BuildStateObserver(buildState);
    expect(observer.collect()).toHaveLength(0);
    expect(observer.collect()).toHaveLength(0); // No change
  });
});

describe("GitStateObserver", () => {
  it("has correct name and rate limits checks", () => {
    const observer = new GitStateObserver("/tmp/nonexistent", 120_000);
    expect(observer.name).toBe("git-state-observer");

    // First call runs git (will fail gracefully for nonexistent path)
    const obs1 = observer.collect();
    // Second immediate call should be rate-limited
    const obs2 = observer.collect();
    expect(obs2).toHaveLength(0); // Rate limited
  });
});

describe("FileWatchObserver", () => {
  it("collects buffered file events", () => {
    const observer = new FileWatchObserver();
    observer.pushEvent({ type: "change", path: "src/foo.ts", timestamp: Date.now() });
    observer.pushEvent({ type: "add", path: "src/bar.ts", timestamp: Date.now() });

    const obs = observer.collect();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.source).toBe("file-watch");
    expect(obs[0]!.summary).toContain("1 modified");
    expect(obs[0]!.summary).toContain("1 added");
  });

  it("drains buffer on collect", () => {
    const observer = new FileWatchObserver();
    observer.pushEvent({ type: "change", path: "src/foo.ts", timestamp: Date.now() });

    expect(observer.collect()).toHaveLength(1);
    expect(observer.collect()).toHaveLength(0); // Buffer drained
  });

  it("returns empty when no events", () => {
    const observer = new FileWatchObserver();
    expect(observer.collect()).toHaveLength(0);
  });

  it("caps buffer at MAX_BUFFER", () => {
    const observer = new FileWatchObserver();
    for (let i = 0; i < 150; i++) {
      observer.pushEvent({ type: "change", path: `src/file${i}.ts`, timestamp: Date.now() });
    }
    const obs = observer.collect();
    expect(obs).toHaveLength(1); // Single aggregated observation
    // Context should show capped at 100
    expect((obs[0]!.context as any).eventCount).toBe(100);
  });

  it("assigns higher priority for deletions", () => {
    const observer = new FileWatchObserver();
    observer.pushEvent({ type: "unlink", path: "src/deleted.ts", timestamp: Date.now() });

    const obs = observer.collect();
    expect(obs[0]!.priority).toBe(70);
  });
});

describe("TestResultObserver", () => {
  it("reports test failures", () => {
    const observer = new TestResultObserver();
    observer.pushResult({ passed: 10, failed: 2, skipped: 1, duration: 5000, timestamp: Date.now(), failedTests: ["test_a", "test_b"] });

    const obs = observer.collect();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.priority).toBe(80);
    expect(obs[0]!.summary).toContain("2 test(s) failed");
  });

  it("reports all tests passed with low priority", () => {
    const observer = new TestResultObserver();
    observer.pushResult({ passed: 50, failed: 0, skipped: 3, duration: 10000, timestamp: Date.now() });

    const obs = observer.collect();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.priority).toBe(5);
    expect(obs[0]!.actionable).toBe(false);
  });

  it("only reports once per result", () => {
    const observer = new TestResultObserver();
    observer.pushResult({ passed: 10, failed: 1, skipped: 0, duration: 3000, timestamp: Date.now() });

    expect(observer.collect()).toHaveLength(1);
    expect(observer.collect()).toHaveLength(0); // Already reported
  });

  it("reports again after new result pushed", () => {
    const observer = new TestResultObserver();
    observer.pushResult({ passed: 10, failed: 1, skipped: 0, duration: 3000, timestamp: Date.now() });
    observer.collect();

    observer.pushResult({ passed: 11, failed: 0, skipped: 0, duration: 3000, timestamp: Date.now() });
    expect(observer.collect()).toHaveLength(1);
  });
});
