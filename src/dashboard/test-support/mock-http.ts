/**
 * Shared mock-HTTP harness for dashboard route-handler tests.
 *
 * Provides lightweight IncomingMessage / ServerResponse stand-ins so route
 * handlers can be exercised without a real HTTP server.
 */
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Captures writeHead + end calls on a mock ServerResponse. */
export interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

export function createMockRes(): MockRes & ServerResponse {
  const mock: MockRes = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      mock.statusCode = status;
      if (headers) Object.assign(mock.headers, headers);
    }),
    end: vi.fn((data?: string) => {
      if (data) mock.body = data;
    }),
  };
  return mock as unknown as MockRes & ServerResponse;
}

/**
 * Mock IncomingMessage for handlers that never read the request body
 * (GET/DELETE) or that read it via data/end events. Pass `body` to emit it
 * on the next tick so event listeners can attach first.
 */
export function createMockReq(body?: string): IncomingMessage {
  const emitter = new EventEmitter();
  if (body !== undefined) {
    process.nextTick(() => {
      emitter.emit("data", Buffer.from(body));
      emitter.emit("end");
    });
  }
  return emitter as unknown as IncomingMessage;
}

/**
 * Mock IncomingMessage for handlers that read the body themselves via
 * `for await (const chunk of req)` — must be a real async-iterable stream,
 * not a bare EventEmitter.
 *
 * Always attaches a `socket` (with `remoteAddress`) and empty `headers` so
 * handlers that inspect them for per-IP rate limiting work without a second
 * helper. Pass `remoteAddress` to exercise a specific source address.
 */
export function createStreamReq(body: string, remoteAddress = "127.0.0.1"): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]);
  return Object.assign(stream, {
    socket: { remoteAddress },
    headers: {},
  }) as unknown as IncomingMessage;
}

/** Parse the JSON body written to the mock response. */
export function responseJson(res: MockRes & ServerResponse): Record<string, unknown> {
  return JSON.parse((res as MockRes).body) as Record<string, unknown>;
}

/**
 * Flush one macrotask turn so readJsonBody().then(...) chains settle.
 *
 * Use this ONLY when a test asserts that NO response was written yet (e.g.
 * `expect(res.end).not.toHaveBeenCalled()` after a null body) — a single turn
 * is deterministic there. When a test asserts a response WAS written, prefer
 * `waitForResponse(res)` instead, which polls until `res.end` fires rather
 * than betting on one macrotask.
 */
export async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wait until the mock response has been ended (for async handlers). Unlike
 * flushAsync(), this polls until `res.end` fires (up to 50 turns), so it also
 * covers handlers that need more than one macrotask to settle. Use this
 * whenever a test asserts a response WAS written.
 */
export async function waitForResponse(res: MockRes & ServerResponse): Promise<void> {
  for (let i = 0; i < 50 && !(res as MockRes).end.mock.calls.length; i++) {
    await flushAsync();
  }
}
