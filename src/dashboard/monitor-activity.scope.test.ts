/**
 * dashboard#3, the REST half: `GET /api/monitor/activity` returned the whole
 * activity ring to any caller, and `POST /api/monitor/export` copied its review
 * entries into whichever report it wrote — while the dag, tasks and task routes
 * beside them answer only with what the reader may see (CHN-4). The activity
 * entries carry request wording ("Task started: <first 80 characters>"), so on
 * a shared instance every identity could read every other identity's requests.
 *
 * The first test drives the real path: TaskManager events through the task
 * bridge onto the workspace bus, into the DashboardServer's activity log, and
 * out of a real GET.
 */

import { request } from "node:http";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import { createWorkspaceBus } from "./workspace-bus.js";
import { createTaskWorkspaceBridge } from "./task-workspace-bridge.js";
import { handleMonitorRoute, MonitorActivityLog } from "./monitor-routes.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";
import type { GoalTree } from "../goals/types.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const OWNER = "owner-profile";
const GUEST = "guest-profile";

const as = (profileId: string): Record<string, string> => ({
  "x-strada-profile-id": profileId,
  "x-strada-profile-token": `token-${profileId}`,
});

beforeEach(() => {
  const issued = [OWNER, GUEST];
  setInstanceIdentityStore({
    verify: (profileId: string, token: string) => issued.includes(profileId) && token === `token-${profileId}`,
    ownerProfileId: () => OWNER,
    has: (profileId: string) => issued.includes(profileId),
    count: () => issued.length,
  });
});

afterEach(() => setInstanceIdentityStore(null));

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`no answer for GET ${path}`)));
    req.end();
  });
}

describe("GET /api/monitor/activity answers with what the reader may see (dashboard#3)", () => {
  let server: DashboardServer;
  let port = 0;
  let taskManager: EventEmitter;
  let bridge: ReturnType<typeof createTaskWorkspaceBridge>;

  beforeEach(async () => {
    server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1", []);
    const bus = createWorkspaceBus();
    server.setWorkspaceBus(bus);
    taskManager = new EventEmitter();
    bridge = createTaskWorkspaceBridge(taskManager, bus);
    bridge.start();
    await server.start();
    port = ((server as unknown as { server: { address(): AddressInfo } }).server.address()).port;

    taskManager.emit("task:created", {
      id: "task-owner", chatId: "chat-owner", userId: OWNER, conversationId: OWNER,
      title: "the owner's private request", prompt: "the owner's private request",
    });
    taskManager.emit("task:created", {
      id: "task-guest", chatId: "chat-guest", userId: GUEST, conversationId: GUEST,
      title: "the guest's private request", prompt: "the guest's private request",
    });
    // Nobody's: a supervisor update names no identity and stays visible to all.
    bus.emit("monitor:agent_activity", { action: "supervisor_update", detail: "Stage: analysis", timestamp: 1 });
  });

  afterEach(async () => {
    bridge.stop();
    await server.stop();
  });

  it("does not hand the owner the guest's request, nor the guest the owner's", async () => {
    const owner = await get(port, "/api/monitor/activity", as(OWNER));
    expect(owner.status).toBe(200);
    expect(owner.body).toContain("the owner's private request");
    expect(owner.body).not.toContain("the guest's private request");
    expect(owner.body).toContain("Stage: analysis");

    const guest = await get(port, "/api/monitor/activity", as(GUEST));
    expect(guest.status).toBe(200);
    expect(guest.body).toContain("the guest's private request");
    expect(guest.body).not.toContain("the owner's private request");
    expect(guest.body).toContain("Stage: analysis");
  });

  it("applies the limit to what the reader may see, not to the whole ring", async () => {
    const owner = await get(port, "/api/monitor/activity?limit=2", as(OWNER));
    const { entries } = JSON.parse(owner.body) as { entries: Array<{ detail: string }> };
    expect(entries.map((entry) => entry.detail)).toEqual([
      "Task started: the owner's private request",
      "Stage: analysis",
    ]);
  });
});

describe("POST /api/monitor/export copies only the reader's review entries (dashboard#3)", () => {
  function req(headers: Record<string, string>): IncomingMessage {
    const readable = new Readable({ read() { this.push(null); } });
    (readable as unknown as { method: string }).method = "POST";
    (readable as unknown as { headers: Record<string, string> }).headers = headers;
    return readable as unknown as IncomingMessage;
  }

  function res(): ServerResponse & { _status: number; _body: string } {
    const out = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as ServerResponse & { _status: number; _body: string };
    out._status = 0;
    out._body = "";
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out._status = s; };
    (out as unknown as { end: (d?: string) => void }).end = (d?: string) => { out._body = d ?? ""; };
    return out;
  }

  it("leaves another identity's review entry out of the owner's report", () => {
    const tree = {
      rootId: "root-owner",
      sessionId: OWNER,
      taskDescription: "the owner's goal",
      nodes: new Map([["root-owner", { id: "root-owner", status: "executing", depth: 0, dependsOn: [] }]]),
      createdAt: 1,
    } as unknown as GoalTree;
    const goalStorage = { getInterruptedTrees: () => [tree] } as unknown as Parameters<typeof handleMonitorRoute>[4];
    const log = new MonitorActivityLog();
    log.push({ action: "review_result", detail: "owner review: the owner's finding", timestamp: 1, conversationId: OWNER });
    log.push({ action: "review_result", detail: "guest review: the guest's secret finding", timestamp: 2, conversationId: GUEST });

    const out = res();
    handleMonitorRoute("/api/monitor/export", "POST", req(as(OWNER)), out, goalStorage, undefined, undefined, log);

    expect(out._status).toBe(200);
    expect(out._body).toContain("the owner's finding");
    expect(out._body).not.toContain("the guest's secret finding");
  });
});
