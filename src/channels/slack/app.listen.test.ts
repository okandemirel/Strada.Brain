/**
 * CHN-13 — Slack's HTTP receiver binds like every other listener.
 *
 * Bolt's HTTPReceiver calls `listen(port)` with no host, i.e. on every
 * interface, and the port was hard-coded to 3000 (the web channel's default).
 * The receiver now gets BIND_HOST's address and a configurable port.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  startCalls: [] as unknown[][],
}));

vi.mock("@slack/bolt", () => {
  class App {
    client = { auth: { test: async () => ({ user_id: "U-bot" }) } };
    receiver = { stop: async () => undefined };
    constructor(opts: Record<string, unknown>) {
      bolt.constructed.push(opts);
    }
    message(): void {}
    action(): void {}
    event(): void {}
    error(): void {}
    command(): void {}
    async start(...args: unknown[]): Promise<void> {
      bolt.startCalls.push(args);
    }
  }
  return { App };
});

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

import { SlackChannel, resolveSlackHttpPort } from "./app.js";

describe("SlackChannel HTTP receiver listen address (CHN-13)", () => {
  let channel: SlackChannel | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await channel?.disconnect();
    channel = null;
    bolt.constructed.length = 0;
    bolt.startCalls.length = 0;
  });

  it("binds loopback by default instead of every interface", async () => {
    vi.stubEnv("BIND_HOST", undefined);
    channel = new SlackChannel({ botToken: "x", signingSecret: "s", socketMode: false });
    await channel.connect();

    expect(bolt.startCalls).toEqual([[{ port: 3000, host: "127.0.0.1" }]]);
    expect(bolt.constructed[0]).toMatchObject({ socketMode: false, port: 3000 });
  });

  it("follows BIND_HOST and a configured port", async () => {
    vi.stubEnv("BIND_HOST", "0.0.0.0");
    channel = new SlackChannel({ botToken: "x", signingSecret: "s", socketMode: false, port: 3200 });
    await channel.connect();

    expect(bolt.startCalls).toEqual([[{ port: 3200, host: "0.0.0.0" }]]);
  });

  it("an explicit host wins (bootstrap passes config.bindHost)", async () => {
    channel = new SlackChannel({ botToken: "x", signingSecret: "s", socketMode: false, host: "::1", port: 3300 });
    await channel.connect();

    expect(bolt.startCalls).toEqual([[{ port: 3300, host: "::1" }]]);
  });

  it("socket mode binds no HTTP port at all", async () => {
    channel = new SlackChannel({ botToken: "x", signingSecret: "s", appToken: "xapp", socketMode: true });
    await channel.connect();

    expect(bolt.startCalls).toEqual([[]]);
    expect(bolt.constructed[0]?.["port"]).toBeUndefined();
  });
});

describe("resolveSlackHttpPort", () => {
  it("defaults to 3000 and reads SLACK_HTTP_PORT", () => {
    expect(resolveSlackHttpPort({})).toBe(3000);
    expect(resolveSlackHttpPort({ SLACK_HTTP_PORT: "3200" })).toBe(3200);
  });

  it.each(["abc", "0", "70000", "3000.5"])("refuses %j rather than falling back", (raw) => {
    expect(() => resolveSlackHttpPort({ SLACK_HTTP_PORT: raw })).toThrow(/SLACK_HTTP_PORT/);
  });
});
