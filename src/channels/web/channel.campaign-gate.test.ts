/**
 * CHN-8: GET /api/campaign is answered before the portal proxy, so it applies
 * the proxy's GET origin rule itself, and `measure=1` (a project-tree walk)
 * runs at most once at a time, reusing a recent result.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

import { WebChannel } from "./channel.js";

async function get(channel: WebChannel, url: string, headers: Record<string, string> = {}) {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(body?: string) {
      this.body = body ?? "";
      return this;
    },
  };
  const req = { method: "GET", url, headers, on: () => req };
  await (channel as unknown as { handleHttp: (req: unknown, res: unknown) => Promise<void> }).handleHttp(req, res);
  return res;
}

describe("GET /api/campaign gates (CHN-8)", () => {
  it("runs one measurement for a burst of concurrent measure=1 requests", async () => {
    const channel = new WebChannel(3000, 3100);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = vi.fn(async ({ measure }: { measure: boolean }) => {
      if (measure) await gate;
      return { measurement: measure ? { walked: true } : null };
    });
    channel.setBuildStatusProvider(provider);

    const burst = Array.from({ length: 5 }, () => get(channel, "/api/campaign?measure=1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const responses = await Promise.all(burst);

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(provider.mock.calls.filter(([opts]) => opts.measure)).toHaveLength(1);

    // A request right after reuses the fresh result instead of walking again.
    await get(channel, "/api/campaign?measure=1");
    expect(provider.mock.calls.filter(([opts]) => opts.measure)).toHaveLength(1);
  });

  it("refuses a request from a foreign origin before touching the provider", async () => {
    const channel = new WebChannel(3000, 3100);
    const provider = vi.fn(async () => ({}));
    channel.setBuildStatusProvider(provider);

    const res = await get(channel, "/api/campaign?measure=1", { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(provider).not.toHaveBeenCalled();

    const own = await get(channel, "/api/campaign", { origin: "http://localhost:3000" });
    expect(own.statusCode).toBe(200);
  });
});
