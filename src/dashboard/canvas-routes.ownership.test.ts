/**
 * Codex round 14 #2 — A CANVAS BELONGS TO THE IDENTITY WHOSE SESSION IT IS.
 *
 * The portal keys every canvas by the browser's own profile id
 * (`useCanvasStore.setSessionId(profileId)`), and these routes are the only
 * writers there are — so each row IS one identity's work. Nothing checked that:
 * `DELETE /api/canvas/<the owner's profile>` from a guest reached storage and
 * answered 200, `GET` handed back the owner's shapes, and `PUT` wrote whatever
 * `userId` the body claimed, which is an ownership field under the caller's
 * control.
 *
 * Both directions are tested: the guest is refused AND the owner still works,
 * because a canvas the owner cannot save is not a fix.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CanvasStorage } from "./canvas-storage.js";
import { handleCanvasRoute } from "./canvas-routes.js";
import { createMockReq, createMockRes, responseJson, type MockRes } from "./test-support/mock-http.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";

const OWNER = "owner-profile";
const GUEST = "guest-profile";

let dir: string;
let db: Database.Database;
let storage: CanvasStorage;

/** The identity store the instance keeps: owner first, one guest. */
function identities(opts: { issued?: string[]; owner?: string | null } = {}) {
  const issued = opts.issued ?? [OWNER, GUEST];
  return {
    verify: (profileId: string, token: string) => issued.includes(profileId) && token === `token-${profileId}`,
    ownerProfileId: () => (opts.owner === null ? undefined : opts.owner ?? OWNER),
    has: (profileId: string) => issued.includes(profileId),
    count: () => issued.length,
  };
}

const as = (profileId: string): Record<string, string> => ({
  "x-strada-profile-id": profileId,
  "x-strada-profile-token": `token-${profileId}`,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "canvas-ownership-"));
  db = new Database(join(dir, "canvas.db"));
  storage = new CanvasStorage(db);
  setInstanceIdentityStore(identities());
});

afterEach(() => {
  setInstanceIdentityStore(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = createMockRes();
  const req = createMockReq(body === undefined ? undefined : JSON.stringify(body));
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  const handled = handleCanvasRoute(url, method, req, res, storage);
  expect(handled).toBe(true);
  return new Promise((resolve) => {
    const wait = (): void => {
      if ((res as MockRes).end.mock.calls.length > 0) {
        resolve({ status: (res as MockRes).statusCode, json: responseJson(res) });
        return;
      }
      setImmediate(wait);
    };
    wait();
  });
}

/** The owner's canvas, saved the way the portal saves it. */
async function ownerCanvas(): Promise<void> {
  const saved = await call("PUT", `/api/canvas/${OWNER}`, as(OWNER), {
    shapes: [{ id: "s1", type: "note", text: "the owner's plan" }],
  });
  expect(saved.status).toBe(200);
}

describe("canvas routes: one identity's canvas is not another's (round 14 #2)", () => {
  it("refuses a guest DELETE of the owner's canvas, and the canvas survives", async () => {
    await ownerCanvas();

    const refused = await call("DELETE", `/api/canvas/${OWNER}`, as(GUEST));
    expect(refused.status).toBe(403);
    expect(String(refused.json["reason"])).toContain(GUEST);
    expect(storage.getBySession(OWNER)).not.toBeNull();

    // …and the owner deletes its own.
    const allowed = await call("DELETE", `/api/canvas/${OWNER}`, as(OWNER));
    expect(allowed.status).toBe(200);
    expect(storage.getBySession(OWNER)).toBeNull();
  });

  it("refuses a guest PUT over the owner's canvas, and the bytes are unchanged", async () => {
    await ownerCanvas();

    const refused = await call("PUT", `/api/canvas/${OWNER}`, as(GUEST), {
      shapes: [{ id: "s2", type: "note", text: "the guest's overwrite" }],
    });
    expect(refused.status).toBe(403);
    expect(storage.getBySession(OWNER)!.shapes).toContain("the owner's plan");
  });

  it("refuses a guest reading or exporting the owner's canvas", async () => {
    await ownerCanvas();

    const read = await call("GET", `/api/canvas/${OWNER}`, as(GUEST));
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.json)).not.toContain("the owner's plan");

    const exported = await call("POST", `/api/canvas/${OWNER}/export`, as(GUEST));
    expect(exported.status).toBe(403);
    expect(JSON.stringify(exported.json)).not.toContain("the owner's plan");
  });

  it("records the VERIFIED identity as the canvas owner, not the one the body claims", async () => {
    // The guest saves its OWN canvas but claims the owner's userId.
    const saved = await call("PUT", `/api/canvas/${GUEST}`, as(GUEST), {
      shapes: [{ id: "s1", type: "note", text: "mine" }],
      userId: OWNER,
    });
    expect(saved.status).toBe(200);
    expect(storage.getBySession(GUEST)!.userId).toBe(GUEST);
  });

  it("refuses an unattributed mutation once the instance has an owner", async () => {
    await ownerCanvas();
    const refused = await call("DELETE", `/api/canvas/${OWNER}`);
    expect(refused.status).toBe(403);
    expect(storage.getBySession(OWNER)).not.toBeNull();
  });

  it("keeps the guest's own canvas entirely usable", async () => {
    const saved = await call("PUT", `/api/canvas/${GUEST}`, as(GUEST), {
      shapes: [{ id: "g1", type: "note", text: "the guest's plan" }],
    });
    expect(saved.status).toBe(200);

    const read = await call("GET", `/api/canvas/${GUEST}`, as(GUEST));
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.json)).toContain("the guest's plan");

    const exported = await call("POST", `/api/canvas/${GUEST}/export`, as(GUEST));
    expect(exported.status).toBe(200);

    const deleted = await call("DELETE", `/api/canvas/${GUEST}`, as(GUEST));
    expect(deleted.status).toBe(200);
  });

  it("lists only the caller's own canvases for a project", async () => {
    await ownerCanvas();
    await call("PUT", `/api/canvas/${GUEST}`, as(GUEST), {
      shapes: [{ id: "g1", type: "note" }],
      projectFingerprint: "fp-1",
    });
    await call("PUT", `/api/canvas/${OWNER}`, as(OWNER), {
      shapes: [{ id: "s1", type: "note" }],
      projectFingerprint: "fp-1",
      version: 1,
    });

    const listed = await call("GET", "/api/canvas/project/fp-1", as(GUEST));
    expect(listed.status).toBe(200);
    const sessions = (listed.json["canvases"] as Array<{ sessionId: string }>).map((c) => c.sessionId);
    expect(sessions).toEqual([GUEST]);
  });

  it("keeps an instance that has issued no identity working with no headers at all", async () => {
    setInstanceIdentityStore(identities({ issued: [], owner: null }));

    const saved = await call("PUT", "/api/canvas/whoever", undefined as unknown as Record<string, string>, {
      shapes: [{ id: "s1", type: "note" }],
    });
    expect(saved.status).toBe(200);
    expect((await call("GET", "/api/canvas/whoever")).status).toBe(200);
    expect((await call("DELETE", "/api/canvas/whoever")).status).toBe(200);
  });

  it("answers 503 rather than guessing when the identity state cannot be read", async () => {
    await ownerCanvas();
    const boom = (): never => { throw new Error("SQLITE_CORRUPT: database disk image is malformed"); };
    setInstanceIdentityStore({ verify: boom, ownerProfileId: boom, has: boom, count: boom });

    const res = await call("DELETE", `/api/canvas/${OWNER}`, as(OWNER));
    expect(res.status).toBe(503);
    setInstanceIdentityStore(identities());
    expect(storage.getBySession(OWNER)).not.toBeNull();
  });
});
