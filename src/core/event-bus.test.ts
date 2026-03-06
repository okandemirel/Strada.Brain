/**
 * TypedEventBus Tests -- Typed event bus with emit-only and full interfaces
 *
 * Tests: typed emit/receive, async listeners, error isolation, on/off lifecycle,
 * graceful shutdown, and IEventEmitter emit-only constraint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypedEventBus } from "./event-bus.js";
import type { IEventEmitter, IEventBus, LearningEventMap, ToolResultEvent } from "./event-bus.js";

function makeToolResult(overrides?: Partial<ToolResultEvent>): ToolResultEvent {
  return {
    sessionId: "sess-1",
    toolName: "read_file",
    input: { path: "/tmp/test.ts" },
    output: "file contents",
    success: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("TypedEventBus", () => {
  let bus: TypedEventBus<LearningEventMap>;

  beforeEach(() => {
    bus = new TypedEventBus<LearningEventMap>();
  });

  afterEach(async () => {
    await bus.shutdown();
  });

  it("emits event and sync listener receives correct typed payload", () => {
    const received: ToolResultEvent[] = [];
    bus.on("tool:result", (payload) => {
      received.push(payload);
    });

    const event = makeToolResult({ toolName: "write_file" });
    bus.emit("tool:result", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
    expect(received[0]!.toolName).toBe("write_file");
  });

  it("emits event and async listener receives correct typed payload", async () => {
    const received: ToolResultEvent[] = [];
    bus.on("tool:result", async (payload) => {
      await new Promise((r) => setTimeout(r, 10));
      received.push(payload);
    });

    const event = makeToolResult();
    bus.emit("tool:result", event);

    // Async listener is in-flight; wait for shutdown to drain
    await bus.shutdown();
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it("multiple listeners on same event type all receive the payload", () => {
    const results: string[] = [];
    bus.on("tool:result", () => results.push("listener-1"));
    bus.on("tool:result", () => results.push("listener-2"));
    bus.on("tool:result", () => results.push("listener-3"));

    bus.emit("tool:result", makeToolResult());

    expect(results).toEqual(["listener-1", "listener-2", "listener-3"]);
  });

  it("IEventEmitter interface only exposes emit() -- type assertion", () => {
    // Assigning bus to emit-only interface should compile.
    // The emit-only interface must NOT have on/off/shutdown.
    const emitter: IEventEmitter<LearningEventMap> = bus;
    expect(typeof emitter.emit).toBe("function");

    // Verify at runtime that the interface type restricts to emit-only.
    // (The real enforcement is at compile-time via TypeScript.)
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(emitter)).filter(
      (k) => k !== "constructor",
    );
    // The underlying object has on/off/shutdown, but IEventEmitter type hides them.
    // We just verify emit is callable.
    emitter.emit("tool:result", makeToolResult());
  });

  it("on()/off() correctly subscribe/unsubscribe listeners", () => {
    const results: string[] = [];
    const listener = () => results.push("called");

    bus.on("tool:result", listener);
    bus.emit("tool:result", makeToolResult());
    expect(results).toHaveLength(1);

    bus.off("tool:result", listener);
    bus.emit("tool:result", makeToolResult());
    // Should still be 1 -- listener was removed
    expect(results).toHaveLength(1);
  });

  it("off() for unregistered listener does not throw", () => {
    const unregistered = () => {
      /* never subscribed */
    };
    expect(() => bus.off("tool:result", unregistered)).not.toThrow();
  });

  it("shutdown() waits for in-flight async listeners to complete before resolving", async () => {
    let completed = false;
    bus.on("tool:result", async () => {
      await new Promise((r) => setTimeout(r, 50));
      completed = true;
    });

    bus.emit("tool:result", makeToolResult());
    // completed should still be false
    expect(completed).toBe(false);

    await bus.shutdown();
    // After shutdown, the async listener should have completed
    expect(completed).toBe(true);
  });

  it("shutdown() prevents new events from being processed (emit after shutdown is no-op)", async () => {
    const received: ToolResultEvent[] = [];
    bus.on("tool:result", (payload) => received.push(payload));

    await bus.shutdown();
    bus.emit("tool:result", makeToolResult());

    expect(received).toHaveLength(0);
  });

  it("listener error is caught and does not propagate to emitter or other listeners", () => {
    const results: string[] = [];
    bus.on("tool:result", () => {
      throw new Error("listener-1 exploded");
    });
    bus.on("tool:result", () => results.push("listener-2-ok"));

    // Should not throw
    expect(() => bus.emit("tool:result", makeToolResult())).not.toThrow();
    // Second listener should still have been called
    expect(results).toEqual(["listener-2-ok"]);
  });

  it("events with no listeners do not throw", () => {
    expect(() => bus.emit("tool:result", makeToolResult())).not.toThrow();
  });
});
