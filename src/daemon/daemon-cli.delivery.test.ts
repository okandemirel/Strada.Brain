/**
 * `strada daemon digest` and `strada daemon notify` say what was delivered
 * (daemon#7).
 *
 * Both printed "sent" whatever happened: sendDigest() worked out `delivered`
 * and returned only the markdown, and notify() returned nothing on every path
 * that drops, groups, buffers or fails a notification. Here the real
 * DigestReporter and NotificationRouter sit behind both paths — the command in
 * the runtime process, and the same command from a shell through the real
 * dashboard with the operator credential — in the state every runtime is in
 * after a restart: a chat channel, but no chat bound until someone messages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerDaemonCommands, type DaemonContext } from "./daemon-cli.js";
import { DaemonStorage } from "./daemon-storage.js";
import { DigestReporter } from "./reporting/digest-reporter.js";
import { NotificationRouter } from "./reporting/notification-router.js";
import { TypedEventBus } from "../core/event-bus.js";
import type { DaemonEventMap } from "./daemon-events.js";
import { DashboardServer } from "../dashboard/server.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { resolveDaemonOperatorClient } from "../core/daemon-dashboard-client.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, getLogger: () => logger, getLoggerSafe: () => logger };
});

async function command(
  args: string[],
  getDaemonContext: () => DaemonContext | undefined,
  credentialFile: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | string | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerDaemonCommands(program, getDaemonContext, undefined, () =>
    resolveDaemonOperatorClient(credentialFile, {
      dashboard: { enabled: true, port: 0 },
      websocketDashboard: { enabled: false, port: 0, authToken: undefined },
    }));
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { out.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => { err.push(parts.join(" ")); });
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "strada", "daemon", ...args]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode };
}

describe("strada daemon digest and notify report delivery, in-process and from a shell (daemon#7)", () => {
  let dir = "";
  let file = "";
  let storage: DaemonStorage;
  let server: DashboardServer | null = null;
  let sendMarkdown: ReturnType<typeof vi.fn>;
  let digestReporter: DigestReporter;
  let notificationRouter: NotificationRouter;
  let ctx: DaemonContext;

  async function bothPaths(args: string[]) {
    const inProcess = await command(args, () => ctx, file);
    const fromShell = await command(args, () => undefined, file);
    return { inProcess, fromShell };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "strada-delivery-"));
    file = join(dir, "k.operator.json");
    storage = new DaemonStorage(join(dir, "daemon.db"));
    storage.initialize();
    const eventBus = new TypedEventBus<DaemonEventMap>();
    sendMarkdown = vi.fn(async () => undefined);
    const channelSender = { sendText: vi.fn(async () => undefined), sendMarkdown };
    // As bootstrap builds them: a chat channel, no chat until the first inbound message.
    digestReporter = new DigestReporter({
      config: { enabled: true, schedule: "0 9 * * *", timezone: "UTC", dashboardHistoryDepth: 10 },
      daemonConfig: { timezone: "UTC" },
      storage,
      channelSender,
      chatId: undefined,
      channelType: "telegram",
      eventBus,
      logger: logger as never,
    });
    notificationRouter = new NotificationRouter({
      config: {
        minLevel: "low",
        routing: { silent: ["dashboard"], low: ["dashboard"], medium: ["dashboard"], high: ["chat", "dashboard"], critical: ["chat", "dashboard"] },
        // No grouping between this test's notifications unless a test asks for it.
        groupingWindowMs: 0,
      },
      quietHoursConfig: { enabled: false, startHour: 22, endHour: 8, timezone: "UTC", bufferMax: 100 },
      eventBus,
      storage,
      channelSender,
    });
    ctx = { digestReporter, notificationRouter } as unknown as DaemonContext;
    server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1", [], file);
    server.setDaemonContext({ cliContext: ctx });
    try {
      await server.start();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") server = null;
      else throw error;
    }
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("digest: with no chat bound yet, says nothing was delivered and why, and exits non-zero", async () => {
    if (!server) return;
    const { inProcess, fromShell } = await bothPaths(["digest"]);
    const notDelivered = {
      stdout: "",
      stderr: "Digest not delivered: no chat is bound yet (the digest goes to the first chat that messages Strada after it starts)",
      exitCode: 1,
    };
    expect(inProcess).toEqual(notDelivered);
    expect(fromShell).toEqual(notDelivered);
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("digest: says sent once a chat is bound and the send went through", async () => {
    if (!server) return;
    digestReporter.setChatId("chat-1");
    const { inProcess, fromShell } = await bothPaths(["digest"]);
    const sent = { stdout: "Digest sent to active channel", stderr: "", exitCode: undefined };
    expect(inProcess).toEqual(sent);
    expect(fromShell).toEqual(sent);
    expect(sendMarkdown).toHaveBeenCalledTimes(2);
  });

  it("digest: names a failed chat send", async () => {
    if (!server) return;
    digestReporter.setChatId("chat-1");
    sendMarkdown.mockRejectedValue(new Error("Telegram 403: bot was blocked by the user"));
    const { inProcess, fromShell } = await bothPaths(["digest"]);
    const failed = { stdout: "", stderr: "Digest not delivered: the chat send failed: Telegram 403: bot was blocked by the user", exitCode: 1 };
    expect(inProcess).toEqual(failed);
    expect(fromShell).toEqual(failed);
  });

  it("notify: names where a test notification went, and the routed channel it missed", async () => {
    if (!server) return;
    const { inProcess, fromShell } = await bothPaths(["notify", "--level", "high", "--message", "disk almost full"]);
    const partial = {
      stdout: "Notification sent (level: high) to: dashboard",
      stderr: "Not delivered everywhere this level is routed: chat: no chat is bound yet (the first chat that messages Strada after it starts)",
      exitCode: 1,
    };
    expect(inProcess).toEqual(partial);
    expect(fromShell).toEqual(partial);

    notificationRouter.setChatId("chat-1");
    const reached = await bothPaths(["notify", "--level", "high", "--message", "disk almost full"]);
    const everywhere = { stdout: "Notification sent (level: high) to: chat, dashboard", stderr: "", exitCode: undefined };
    expect(reached.inProcess).toEqual(everywhere);
    expect(reached.fromShell).toEqual(everywhere);
  });

  it("notify: a notification dropped over the per-minute limit is not reported as sent", async () => {
    if (!server) return;
    // low: one per minute.
    expect((await command(["notify", "--level", "low", "--message", "one"], () => ctx, file)).stdout).toBe("Notification sent (level: low) to: dashboard");
    const { inProcess, fromShell } = await bothPaths(["notify", "--level", "low", "--message", "two"]);
    const dropped = { stdout: "", stderr: "Notification not delivered (level: low): over the limit of 1 low notification(s) per minute; dropped", exitCode: 1 };
    expect(inProcess).toEqual(dropped);
    expect(fromShell).toEqual(dropped);
  });
});
