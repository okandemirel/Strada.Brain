/**
 * The one bounded JSON request-body reader for dashboard routes (audit dashboard#2).
 *
 * A body larger than one socket read arrives in several chunks, cut at whatever
 * byte the read ended on. The route readers decoded each chunk on its own, so a
 * multi-byte character cut in two (Turkish, CJK, an arrow) became U+FFFD. The
 * damage sits inside a JSON string, so the body still parsed and the route
 * stored it with a 200: canvas notes, personality profiles, decision paths.
 * The bytes are kept as bytes and decoded once, at the end.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

function answer(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

/**
 * Parse the request body as JSON, at most `maxBytes` of it. Answers 413, 400 or
 * an unreadable body itself and resolves null; an empty body is `{}`.
 */
export function readJsonBody<T>(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += buf.length;
      if (bytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        req.destroy();
        answer(res, 413, "Request body too large");
        resolve(null);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T);
      } catch {
        answer(res, 400, "Invalid JSON body");
        resolve(null);
      }
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      answer(res, 400, "Request body could not be read");
      resolve(null);
    });
  });
}
