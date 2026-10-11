import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { readJsonBody } from "./json-body.js";
import {
  createChunkedReq,
  createMockReq,
  createMockRes,
  responseJson,
} from "./test-support/mock-http.js";

describe("readJsonBody", () => {
  // Audit dashboard#2: each chunk was decoded on its own, so a character the
  // socket cut in two became U+FFFD inside a string that still parsed.
  it("decodes characters cut across chunks, a four-byte one cut twice", async () => {
    const text = "Çalışma notu → 漢字 🎮 son";
    const bytes = Buffer.from(JSON.stringify({ text }), "utf8");
    const at = (character: string) => bytes.indexOf(Buffer.from(character, "utf8"));
    const cuts = [at("ş") + 1, at("漢") + 2, at("🎮") + 1, at("🎮") + 3];
    const chunks = [...cuts, bytes.length].map((cut, i) => bytes.subarray(i === 0 ? 0 : cuts[i - 1], cut));
    const res = createMockRes();

    const parsed = await readJsonBody<{ text: string }>(createChunkedReq(chunks), res, 4096);

    expect(parsed).toEqual({ text });
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it("answers 413 once and resolves null when the body passes the limit", async () => {
    const emitter = new EventEmitter();
    let destroyed = 0;
    (emitter as unknown as { destroy: () => void }).destroy = () => { destroyed++; };
    const res = createMockRes();

    const pending = readJsonBody(emitter as unknown as IncomingMessage, res, 8);
    emitter.emit("data", Buffer.from('{"a":"'));
    emitter.emit("data", Buffer.from('xxxxxx"}'));
    emitter.emit("data", Buffer.from("more"));
    emitter.emit("end");

    expect(await pending).toBeNull();
    expect(destroyed).toBe(1);
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(413);
    expect(responseJson(res)).toEqual({ error: "Request body too large" });
  });

  it("answers 400 for a body that is not JSON, and reads an empty body as {}", async () => {
    const bad = createMockRes();
    expect(await readJsonBody(createMockReq("{nope"), bad, 4096)).toBeNull();
    expect(bad.statusCode).toBe(400);
    expect(responseJson(bad)).toEqual({ error: "Invalid JSON body" });

    const empty = createMockRes();
    expect(await readJsonBody(createMockReq(""), empty, 4096)).toEqual({});
    expect(empty.writeHead).not.toHaveBeenCalled();
  });

  it("answers and resolves when the request fails mid-body instead of hanging", async () => {
    const emitter = new EventEmitter();
    const res = createMockRes();

    const pending = readJsonBody(emitter as unknown as IncomingMessage, res, 4096);
    emitter.emit("data", Buffer.from('{"a":'));
    emitter.emit("error", new Error("aborted"));

    expect(await pending).toBeNull();
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "Request body could not be read" });
  });
});
