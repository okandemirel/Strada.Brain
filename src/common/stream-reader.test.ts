import { describe, expect, it, vi } from "vitest";
import { releaseStreamReader } from "./stream-reader.js";

describe("releaseStreamReader", () => {
  it("cancels a body the consumer stopped reading early", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const reader = stream.getReader();
    await reader.read();
    releaseStreamReader(reader);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("is harmless on a body read to the end, and when called twice", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    expect(() => {
      releaseStreamReader(reader);
      releaseStreamReader(reader);
    }).not.toThrow();
  });
});
