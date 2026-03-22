import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObservationEngine } from "./observation-engine.js";
import {
  createObservation,
  type Observer,
  type AgentObservation,
} from "./observation-types.js";

function makeObserver(
  name: string,
  observations: AgentObservation[],
): Observer {
  return {
    name,
    collect: vi.fn().mockReturnValue(observations),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe("ObservationEngine", () => {
  let engine: ObservationEngine;

  beforeEach(() => {
    engine = new ObservationEngine();
  });

  it("collects from registered observers", () => {
    const obs1 = createObservation("file-watch", "File changed: src/foo.ts", {
      priority: 60,
    });
    const obs2 = createObservation("git", "3 uncommitted changes", {
      priority: 40,
    });

    engine.register(makeObserver("file", [obs1]));
    engine.register(makeObserver("git", [obs2]));

    const result = engine.collect();
    expect(result).toHaveLength(2);
    expect(result[0]!.source).toBe("file-watch"); // Higher priority first
    expect(result[1]!.source).toBe("git");
  });

  it("sorts by priority descending", () => {
    const low = createObservation("user", "User idle", { priority: 10 });
    const high = createObservation("build", "Build failed", { priority: 90 });
    const mid = createObservation("trigger", "Cron fired", { priority: 50 });

    engine.register(makeObserver("mixed", [low, high, mid]));

    const result = engine.collect();
    expect(result[0]!.priority).toBe(90);
    expect(result[1]!.priority).toBe(50);
    expect(result[2]!.priority).toBe(10);
  });

  it("deduplicates same source+summary within window", () => {
    const obs = createObservation("file-watch", "File changed: src/foo.ts");
    engine.register(makeObserver("file", [obs]));

    const first = engine.collect();
    expect(first).toHaveLength(1);

    // Same observation again — should be suppressed
    const second = engine.collect();
    expect(second).toHaveLength(0);
  });

  it("allows same observation after dedup window expires", () => {
    vi.useFakeTimers();
    const obs = createObservation("file-watch", "File changed: src/foo.ts");
    engine.register(makeObserver("file", [obs]));

    engine.collect(); // First time

    vi.advanceTimersByTime(61_000); // Past 60s window

    const result = engine.collect();
    expect(result).toHaveLength(1); // Allowed again

    vi.useRealTimers();
  });

  it("handles observer failures gracefully", () => {
    const good = createObservation("git", "Clean repo");
    const failingObserver: Observer = {
      name: "failing",
      collect: () => {
        throw new Error("Observer crashed");
      },
    };

    engine.register(failingObserver);
    engine.register(makeObserver("git", [good]));

    const result = engine.collect();
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("git");
  });

  it("maintains observation history", () => {
    const obs1 = createObservation("file-watch", "Change 1");
    const obs2 = createObservation("git", "Change 2");

    engine.register(makeObserver("multi", [obs1]));
    engine.collect();

    // Replace observer for second collect
    (engine as any).observers.length = 0;
    engine.register(makeObserver("multi", [obs2]));
    engine.collect();

    const history = engine.getHistory();
    expect(history).toHaveLength(2);
  });

  it("starts and stops all observers", () => {
    const obs1 = makeObserver("a", []);
    const obs2 = makeObserver("b", []);

    engine.register(obs1);
    engine.register(obs2);

    engine.start();
    expect(obs1.start).toHaveBeenCalled();
    expect(obs2.start).toHaveBeenCalled();

    engine.stop();
    expect(obs1.stop).toHaveBeenCalled();
    expect(obs2.stop).toHaveBeenCalled();
  });

  it("returns empty array when no observers registered", () => {
    expect(engine.collect()).toEqual([]);
  });

  it("getObserverCount returns correct count", () => {
    expect(engine.getObserverCount()).toBe(0);
    engine.register(makeObserver("a", []));
    expect(engine.getObserverCount()).toBe(1);
  });

  it("inject() adds synthetic observation to next collect", () => {
    const synthetic = createObservation("task-outcome" as any, "Task succeeded", {
      priority: 40,
      context: { taskId: "task_1", success: true },
    });
    engine.inject(synthetic);

    const result = engine.collect();
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("task-outcome");
    expect(result[0]!.summary).toBe("Task succeeded");

    // Injection buffer is drained after collect
    const second = engine.collect();
    expect(second).toHaveLength(0);
  });

  it("inject() observations merge with observer observations and sort by priority", () => {
    const observerObs = createObservation("build", "Build failed", { priority: 90 });
    engine.register(makeObserver("build", [observerObs]));

    const injected = createObservation("task-outcome" as any, "Task done", { priority: 40 });
    engine.inject(injected);

    const result = engine.collect();
    expect(result).toHaveLength(2);
    // Higher priority first
    expect(result[0]!.source).toBe("build");
    expect(result[1]!.source).toBe("task-outcome");
  });
});

describe("createObservation", () => {
  it("creates observation with defaults", () => {
    const obs = createObservation("git", "test summary");
    expect(obs.source).toBe("git");
    expect(obs.summary).toBe("test summary");
    expect(obs.priority).toBe(50);
    expect(obs.actionable).toBe(true);
    expect(obs.id).toBeTruthy();
    expect(obs.timestamp).toBeGreaterThan(0);
  });

  it("creates observation with custom values", () => {
    const obs = createObservation("build", "Build failed", {
      priority: 90,
      context: { errorCount: 3 },
      actionable: true,
    });
    expect(obs.priority).toBe(90);
    expect(obs.context).toEqual({ errorCount: 3 });
  });
});
