/**
 * CHN-4: the REST monitor and goal reads apply the identity rule the
 * WebSocket path applies to the same boards. On a shared instance identity B
 * must not read identity A's goal tree through /api/monitor/* or /api/goals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMonitorRoute, MonitorActivityLog } from "./monitor-routes.js";
import { handleSystemRoutes } from "./server-system-routes.js";
import type { RouteContext } from "./server-types.js";
import type { GoalStorage } from "../goals/index.js";
import type { GoalNode, GoalNodeId, GoalTree } from "../goals/types.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const OWNER = "owner-profile";
const GUEST = "guest-profile";

function identities(issued: string[] = [OWNER, GUEST]) {
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

function node(id: string, task: string, parentId: string | null): GoalNode {
  return {
    id: id as GoalNodeId,
    parentId: parentId as GoalNodeId | null,
    task,
    dependsOn: [],
    depth: parentId ? 1 : 0,
    status: "executing",
    createdAt: 1,
    updatedAt: 1,
  };
}

function tree(rootId: string, sessionId: string, secret: string): GoalTree {
  const root = node(rootId, `root of ${secret}`, null);
  const child = node(`${rootId}-child`, secret, rootId);
  return {
    rootId: root.id,
    sessionId,
    taskDescription: `plan: ${secret}`,
    nodes: new Map([[root.id, root], [child.id, child]]),
    createdAt: 1,
  };
}

// Most recent first, as getInterruptedTrees orders them: the owner's is newest.
const OWNER_TREE = tree("root-owner", OWNER, "owner private plan");
const GUEST_TREE = tree("root-guest", GUEST, "guest own plan");
const TELEGRAM_TREE = tree("root-tg", "123456789", "telegram chat plan");

const goalStorage = {
  getInterruptedTrees: () => [OWNER_TREE, GUEST_TREE, TELEGRAM_TREE],
  getTree: (id: string) => [OWNER_TREE, GUEST_TREE, TELEGRAM_TREE].find((t) => t.rootId === id) ?? null,
  getTreesBySession: (session: string) => [OWNER_TREE, GUEST_TREE, TELEGRAM_TREE].filter((t) => t.sessionId === session),
} as unknown as GoalStorage;

const taskManager = {
  listAllActiveTasks: () => [
    { id: "task-owner", chatId: "chat-o", channelType: "web", userId: OWNER, title: "owner task text", status: "executing", createdAt: 1, updatedAt: 3 },
    { id: "task-guest", chatId: "chat-g", channelType: "web", userId: GUEST, title: "guest task text", status: "executing", createdAt: 1, updatedAt: 2 },
  ],
};

function request(headers: Record<string, string>): IncomingMessage {
  return { method: "GET", headers } as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(data?: string) { out.body = data ?? ""; },
  } as unknown as ServerResponse;
  return { res, out };
}

function monitor(url: string, headers: Record<string, string>, method = "GET", withGoals = true) {
  const { res, out } = response();
  handleMonitorRoute(url, method, request(headers), res, withGoals ? goalStorage : undefined, taskManager, undefined, new MonitorActivityLog());
  return out;
}

function goals(url: string, headers: Record<string, string>) {
  const { res, out } = response();
  const ctx = { goalStorage } as unknown as RouteContext;
  handleSystemRoutes(url, "GET", request(headers), res, ctx, (o) => o);
  return out;
}

describe("REST monitor/goal reads on a shared instance (CHN-4)", () => {
  beforeEach(() => setInstanceIdentityStore(identities()));
  afterEach(() => setInstanceIdentityStore(null));

  it("/api/monitor/dag and /tasks hand a guest its own tree, never the newer owner tree", () => {
    const dag = monitor("/api/monitor/dag", as(GUEST));
    expect(dag.status).toBe(200);
    expect(dag.body).toContain("guest own plan");
    expect(dag.body).not.toContain("owner private plan");

    const tasks = monitor("/api/monitor/tasks", as(GUEST));
    expect(tasks.body).toContain("guest own plan");
    expect(tasks.body).not.toContain("owner private plan");
  });

  it("naming another identity's root or node answers like an unknown one", () => {
    const tasks = monitor("/api/monitor/tasks?rootId=root-owner", as(GUEST));
    expect(tasks.body).not.toContain("owner private plan");

    const detail = monitor("/api/monitor/task/root-owner-child", as(GUEST));
    expect(detail.status).toBe(404);
    expect(detail.body).not.toContain("owner private plan");
  });

  it("the owner is not given the guest's boards either", () => {
    const detail = monitor("/api/monitor/task/root-guest-child", as(OWNER));
    expect(detail.status).toBe(404);
    expect(monitor("/api/monitor/task/root-owner-child", as(OWNER)).body).toContain("owner private plan");
  });

  it("the export carries only the reader's own boards", () => {
    const out = monitor("/api/monitor/export", as(GUEST), "POST");
    expect(out.body).toContain("guest own plan");
    expect(out.body).not.toContain("owner private plan");
  });

  it("standalone tasks are scoped the same way", () => {
    const tasks = monitor("/api/monitor/tasks", as(GUEST), "GET", false);
    expect(tasks.body).toContain("guest task text");
    expect(tasks.body).not.toContain("owner task text");
  });

  it("an unidentified caller sees only boards that belong to no web identity", () => {
    const dag = monitor("/api/monitor/dag", {});
    expect(dag.body).toContain("telegram chat plan");
    expect(dag.body).not.toContain("owner private plan");
    expect(dag.body).not.toContain("guest own plan");
  });

  it("/api/goals?session= and ?rootId= withhold another identity's trees", () => {
    expect(JSON.parse(goals(`/api/goals?session=${OWNER}`, as(GUEST)).body).trees).toEqual([]);
    expect(JSON.parse(goals("/api/goals?rootId=root-owner", as(GUEST)).body).trees).toEqual([]);
    expect(JSON.parse(goals(`/api/goals?session=${GUEST}`, as(GUEST)).body).trees).toHaveLength(1);
    // A non-web conversation scope is nobody's private traffic.
    expect(JSON.parse(goals("/api/goals?rootId=root-tg", as(GUEST)).body).trees).toHaveLength(1);
  });

  it("answers 503 when the identity state cannot be read", () => {
    setInstanceIdentityStore({
      ...identities(),
      count: () => { throw new Error("database is locked"); },
    });
    expect(monitor("/api/monitor/dag", as(GUEST)).status).toBe(503);
    expect(goals("/api/goals?rootId=root-guest", as(GUEST)).status).toBe(503);
  });
});
