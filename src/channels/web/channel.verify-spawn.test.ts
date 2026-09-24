/**
 * CHN-9: a portal verify check runs `npm run build|test` in the configured
 * project (not the daemon's launch directory), and on Windows through
 * `npm.cmd` with a shell, which Node requires for a `.cmd`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawn = vi.hoisted(() => vi.fn());
const project = vi.hoisted(() => ({ path: "" }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn };
});

vi.mock("../../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, getCachedConfig: () => ({ unityProjectPath: project.path }) };
});

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

import { WebChannel } from "./channel.js";

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  setTimeout(() => child.emit("close", 0, null), 0);
  return child;
}

function mockSocket() {
  const handlers = new Map<string, (payload?: Buffer) => void>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>),
    close: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
    on: (event: string, handler: (payload?: Buffer) => void) => handlers.set(event, handler),
    emit: (event: string, payload?: Buffer) => handlers.get(event)?.(payload),
    sent,
  };
}

async function runBuildCheck(): Promise<{ command: string; args: string[]; options: { cwd?: string; shell?: boolean } }> {
  const channel = new WebChannel(3000, 3100);
  const socket = mockSocket();
  (channel as unknown as { handleWsConnection: (ws: unknown) => void }).handleWsConnection(socket);
  const identity = (channel as unknown as { identityStore: { issue: () => { profileId: string; profileToken: string } } })
    .identityStore.issue();
  socket.emit("message", Buffer.from(JSON.stringify({ type: "session_init", ...identity })));
  const chatId = String(socket.sent.filter((m) => m.type === "connected").at(-1)!.chatId);
  channel.setTaskOwnerResolver(() => chatId);

  await (channel as unknown as { handleWsMessage: (chatId: string, data: Record<string, unknown>) => Promise<void> })
    .handleWsMessage(chatId, { type: "verify:check_criterion", taskId: "task-1", criterionId: "c1", checkType: "build" });
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  await channel.disconnect();
  const [command, args, options] = spawn.mock.calls[0]!;
  return { command, args, options };
}

describe("verify build/test spawn (CHN-9)", () => {
  const platform = process.platform;

  beforeEach(() => {
    project.path = mkdtempSync(join(tmpdir(), "strada-verify-project-"));
    writeFileSync(join(project.path, "package.json"), "{}");
    spawn.mockReset();
    spawn.mockImplementation(fakeChild);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    rmSync(project.path, { recursive: true, force: true });
  });

  it("runs in the configured project directory", async () => {
    const { command, args, options } = await runBuildCheck();
    expect(options.cwd).toBe(project.path);
    if (platform !== "win32") {
      expect(command).toBe("npm");
      expect(args).toEqual(["run", "build"]);
      expect(options.shell).toBe(false);
    }
  });

  it("uses npm.cmd through a shell on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { command, args, options } = await runBuildCheck();
    expect(command).toBe("npm.cmd run build");
    expect(args).toEqual([]);
    expect(options.shell).toBe(true);
    expect(options.cwd).toBe(project.path);
  });
});
