/**
 * Round 14, from the sweep the coordinator asked for rather than from a named
 * finding: the monitor REST gate decisions.
 *
 * `POST /api/monitor/task/:id/approve` and `/skip` push a gate decision onto the
 * workspace bus for whichever task the URL names. The WebSocket twins of these —
 * `monitor:approve_gate`, `monitor:skip_task` — have checked task↔identity
 * ownership since the CWE-639 fix, and the channel refuses a guest there. These
 * two did not check anything: same power, same instance, different transport, and
 * `/api/monitor/` is in the portal proxy's mutable prefixes as well as being
 * reachable straight on the dashboard port.
 *
 * The rule here mirrors the WebSocket path deliberately, including where it is
 * permissive: an id that names no task the process knows (a bare DAG node id) and
 * a task that names no identity are both allowed, because that is what the
 * channel's own resolver does. What is closed is the case the finding class is
 * about — a task that demonstrably belongs to another identity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMonitorRoute, MonitorActivityLog } from "./monitor-routes.js";
import { TypedEventBus } from "../core/event-bus.js";
import type { WorkspaceEventMap } from "./workspace-events.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";

const OWNER = "owner-profile";
const GUEST = "guest-profile";

function identities() {
  const issued = [OWNER, GUEST];
  return {
    verify: (profileId: string, token: string) => issued.includes(profileId) && token === `token-${profileId}`,
    ownerProfileId: () => OWNER,
    has: (profileId: string) => issued.includes(profileId),
    count: () => issued.length,
  };
}

const as = (profileId: string): Record<string, string> => ({
  "x-strada-profile-id": profileId,
  "x-strada-profile-token": `token-${profileId}`,
});

function req(headers: Record<string, string> = {}, body: Record<string, unknown> = { rootId: "root-1" }): IncomingMessage {
  const readable = new Readable({
    read() {
      this.push(JSON.stringify(body));
      this.push(null);
    },
  });
  (readable as unknown as { method: string }).method = "POST";
  (readable as unknown as { headers: Record<string, string> }).headers = headers;
  return readable as unknown as IncomingMessage;
}

function res(): ServerResponse & { _status: number; _body: string } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  }) as unknown as ServerResponse & { _status: number; _body: string; writeHead: unknown; end: unknown };
  writable._status = 0;
  writable._body = "";
  (writable as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { writable._status = s; };
  (writable as unknown as { end: (d?: string) => void }).end = (d?: string) => {
    if (d) chunks.push(Buffer.from(d));
    writable._body = Buffer.concat(chunks).toString();
  };
  return writable;
}

/** A task manager holding one task owned by `userId`. */
function taskManager(userId?: string) {
  return {
    listAllActiveTasks: vi.fn(() => [{
      id: "task-owner",
      chatId: "chat-owner",
      channelType: "web",
      ...(userId ? { userId } : {}),
      title: "the owner's run",
      status: "executing",
      createdAt: 1,
      updatedAt: 2,
    }]),
  } as unknown as Parameters<typeof handleMonitorRoute>[5];
}

let bus: TypedEventBus<WorkspaceEventMap>;
let seen: unknown[];
let log: MonitorActivityLog;

beforeEach(() => {
  bus = new TypedEventBus<WorkspaceEventMap>();
  seen = [];
  bus.on("monitor:gate_response" as keyof WorkspaceEventMap, ((event: unknown) => seen.push(event)) as never);
  log = new MonitorActivityLog();
  setInstanceIdentityStore(identities());
});

afterEach(() => setInstanceIdentityStore(null));

async function call(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const out = res();
  handleMonitorRoute(url, "POST", req(headers), out, undefined, taskManager(OWNER), bus as never, log);
  await new Promise((r) => setTimeout(r, 20));
  return { status: out._status, body: out._body };
}

describe("monitor REST gate decisions belong to the task's identity (round 14 sweep)", () => {
  it("refuses a guest approving or skipping the owner's task, and emits nothing", async () => {
    const approve = await call("/api/monitor/task/task-owner/approve", as(GUEST));
    expect(approve.status).toBe(403);
    expect(approve.body).toContain(GUEST);

    const skip = await call("/api/monitor/task/task-owner/skip", as(GUEST));
    expect(skip.status).toBe(403);

    expect(seen).toEqual([]);
  });

  it("lets the owner decide its own task's gate", async () => {
    const approve = await call("/api/monitor/task/task-owner/approve", as(OWNER));
    expect(approve.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { action: string }).action).toBe("approve");
  });

  it("refuses an unattributed decision once the instance has an owner", async () => {
    const approve = await call("/api/monitor/task/task-owner/approve");
    expect(approve.status).toBe(403);
    expect(seen).toEqual([]);
  });

  // ROUND 15 #4 MOVED THIS LINE. Round 14 mirrored the channel's "an id we cannot
  // resolve is allowed" here; the channel has since stopped saying that, because a
  // task no identity owns is the INSTANCE's own work (the daemon's, a trigger's) —
  // and the instance's work is the owner's, not everybody's. The operator keeps
  // every gate decision it has always had; a guest gets none.
  it("treats a task whose owner cannot be established as the instance's: the owner decides, a guest does not", async () => {
    const refused = res();
    handleMonitorRoute("/api/monitor/task/node-1/approve", "POST", req(as(GUEST)), refused, undefined, taskManager(OWNER), bus as never, log);
    await new Promise((r) => setTimeout(r, 20));
    expect(refused._status).toBe(403);
    expect(seen).toEqual([]);

    const allowed = res();
    handleMonitorRoute("/api/monitor/task/node-1/approve", "POST", req(as(OWNER)), allowed, undefined, taskManager(OWNER), bus as never, log);
    await new Promise((r) => setTimeout(r, 20));
    expect(allowed._status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("answers 503 rather than guessing when the identity state cannot be read", async () => {
    const boom = (): never => { throw new Error("SQLITE_CORRUPT: database disk image is malformed"); };
    setInstanceIdentityStore({ verify: boom, ownerProfileId: boom, has: boom, count: boom });
    const approve = await call("/api/monitor/task/task-owner/approve", as(OWNER));
    expect(approve.status).toBe(503);
    expect(seen).toEqual([]);
  });

  it("keeps an instance that has issued no identity working with no headers", async () => {
    setInstanceIdentityStore({
      verify: () => false,
      ownerProfileId: () => undefined,
      has: () => false,
      count: () => 0,
    });
    const approve = await call("/api/monitor/task/task-owner/approve");
    expect(approve.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});
