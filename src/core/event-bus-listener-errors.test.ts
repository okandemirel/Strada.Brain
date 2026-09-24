/**
 * COR-23: a listener that throws on every event was logged at debug only, so
 * it was invisible at LOG_LEVEL=info; and subscribing one listener twice left
 * a wrapper off() could never remove.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger, getLogger } from "../utils/logger.js";
import { TypedEventBus } from "./event-bus.js";
import type { LearningEventMap, ToolResultEvent } from "./event-bus.js";

createLogger("debug", path.join(os.tmpdir(), "strada-event-bus-listener-errors.log"));
const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => getLogger());
const debug = vi.spyOn(getLogger(), "debug").mockImplementation(() => getLogger());

const toolResult = { toolName: "file_read" } as unknown as ToolResultEvent;

describe("TypedEventBus listener hygiene (COR-23)", () => {
  it("reports a failing listener at warn, then rate-limits it to debug", async () => {
    const bus = new TypedEventBus<LearningEventMap>();
    bus.on("tool:result", () => {
      throw new Error("subscriber broke");
    });
    bus.emit("tool:result", toolResult);
    bus.emit("tool:result", toolResult);
    await vi.waitFor(() => expect(warn.mock.calls.length + debug.mock.calls.length).toBe(2));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("TypedEventBus: listener error", expect.objectContaining({
      event: "tool:result",
      error: "subscriber broke",
    }));
    expect(debug).toHaveBeenCalledTimes(1);
    await bus.shutdown();
  });

  it("subscribing the same listener twice is one subscription that off() removes", async () => {
    const bus = new TypedEventBus<LearningEventMap>();
    const listener = vi.fn();
    bus.on("tool:result", listener);
    bus.on("tool:result", listener);
    bus.emit("tool:result", toolResult);
    expect(listener).toHaveBeenCalledTimes(1);

    bus.off("tool:result", listener);
    bus.emit("tool:result", toolResult);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount("tool:result")).toBe(0);
    await bus.shutdown();
  });
});
