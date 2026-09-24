/**
 * CHN-1, the exporter's half: its request handler is async, so a failure while
 * the registry serializes used to be a rejection nobody awaited — a hung scrape
 * and fuel for the process's unhandled-rejection shutdown policy. It is now
 * answered as a 500 at the listener.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrometheusMetrics } from "./prometheus.js";
import { MetricsCollector } from "./metrics.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`no answer for ${path}`)));
    req.end();
  });
}

describe("PrometheusMetrics request failures (CHN-1)", () => {
  let prometheus: PrometheusMetrics | null = null;
  const unhandled = vi.fn();

  afterEach(async () => {
    process.off("unhandledRejection", unhandled);
    unhandled.mockReset();
    await prometheus?.stop();
    prometheus = null;
  });

  it("answers 500 when serializing the registry fails, and keeps serving", async () => {
    process.on("unhandledRejection", unhandled);
    prometheus = new PrometheusMetrics(0, new MetricsCollector(), () => undefined, undefined, "127.0.0.1");
    const registry = (prometheus as unknown as { register: { metrics: () => Promise<string> } }).register;
    const metricsSpy = vi.spyOn(registry, "metrics").mockRejectedValueOnce(new Error("collector threw"));
    await prometheus.start();
    const port = (prometheus as unknown as { server: { address: () => { port: number } } }).server.address().port;

    expect(await get(port, "/metrics")).toBe(500);
    expect(unhandled).not.toHaveBeenCalled();

    metricsSpy.mockRestore();
    expect(await get(port, "/metrics")).toBe(200);
  });
});
