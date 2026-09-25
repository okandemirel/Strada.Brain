import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { setupShutdownHandlers, type ShutdownLog } from "./shutdown-handlers.js";

class FakeProcess extends EventEmitter {
  readonly exits: number[] = [];
  exit(code?: number): void {
    this.exits.push(code ?? 0);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function install(shutdownDone: Promise<void>) {
  const proc = new FakeProcess();
  const logged: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const log: ShutdownLog = { error: (message, meta) => logged.push({ message, meta }) };
  const afterShutdown = vi.fn(async () => undefined);
  const shutdown = vi.fn(() => shutdownDone);
  setupShutdownHandlers({ shutdown, afterShutdown, proc, log, out: { log: () => undefined, error: () => undefined } });
  return { proc, logged, shutdown, afterShutdown };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("setupShutdownHandlers (COR-19)", () => {
  it("a rejection storm's graceful shutdown is not cut short by the rejections that follow", async () => {
    const gate = deferred();
    const { proc, shutdown, afterShutdown } = install(gate.promise);

    for (let i = 0; i < 20; i++) proc.emit("unhandledRejection", new Error(`boom ${i}`));
    expect(shutdown).toHaveBeenCalledTimes(1);

    // The 21st rejection, milliseconds later, used to force-exit here.
    proc.emit("unhandledRejection", new Error("boom 21"));
    proc.emit("uncaughtException", new Error("thrown while draining"));
    await settle();
    expect(proc.exits).toEqual([]);

    gate.resolve();
    await settle();
    expect(afterShutdown).toHaveBeenCalledTimes(1);
    // Fatal cause → non-zero, but only once the cleanup ran.
    expect(proc.exits).toEqual([1]);
  });

  it("a second stop signal still forces the exit", async () => {
    const gate = deferred();
    const { proc } = install(gate.promise);

    proc.emit("SIGTERM");
    await settle();
    expect(proc.exits).toEqual([]);
    proc.emit("SIGINT");
    await settle();
    expect(proc.exits).toEqual([1]);
  });

  it("a stop signal during a crash-path shutdown still forces the exit", async () => {
    const gate = deferred();
    const { proc } = install(gate.promise);

    proc.emit("uncaughtException", new Error("corrupt"));
    await settle();
    proc.emit("SIGTERM");
    await settle();
    expect(proc.exits).toEqual([1]);
  });

  it("reports each rejection once, with secrets redacted", () => {
    const { proc, logged } = install(new Promise(() => undefined));
    const secret = "sk-ant-api03-CANARYSECRETVALUE1234567890abcdefXYZ";

    proc.emit("unhandledRejection", new Error(`provider rejected key ${secret}`));

    expect(logged).toHaveLength(1);
    const text = JSON.stringify(logged[0]);
    expect(text).toContain("provider rejected key");
    expect(text).not.toContain("CANARYSECRETVALUE1234567890abcdefXYZ");
  });
});
