/**
 * The portal's accept/reject transport (Codex round 11 #20).
 *
 * The defect these tests are about is not a wrong value somewhere: it is that
 * rejecting a change in the browser did nothing to the project. The undo existed
 * (src/agents/multi/workspace-change-review.ts), the portal had a decision
 * queue, and no code connected them — no route, no review id, no caller. So
 * every assertion here that matters looks at the FILE ON DISK after a request,
 * not at a store or a response field: a response saying "undone" is exactly the
 * kind of evidence that was missing.
 *
 * The reviews are real ones, recorded by a real lease commit, because a
 * hand-written review.json cannot show that the previous bytes the undo needs
 * were actually kept.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspaceLeaseManager } from "../agents/multi/workspace-lease-manager.js";
import { readChangeReview } from "../agents/multi/workspace-change-review.js";
import {
  handleChangeReviewRoute,
  setChangeReviewIdentityStore,
  type ChangeReviewIdentityStore,
} from "./change-review-routes.js";
import { createMockReq, createMockRes, responseJson, type MockRes } from "./test-support/mock-http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

let source: string;
let leaseRoot: string;

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), "review-route-src-"));
  leaseRoot = mkdtempSync(join(tmpdir(), "review-route-lease-"));
});

afterEach(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(leaseRoot, { recursive: true, force: true });
});

const EXISTING = join("Assets", "Scripts", "Existing.cs");
const NEW = join("Assets", "Scripts", "New.cs");

function put(root: string, rel: string, body: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  return abs;
}

/**
 * A run that overwrote one file and created another, committed into the project
 * — i.e. exactly the state the portal shows a diff for. Returns the review id
 * the daemon recorded, which is the id the portal had no way of learning.
 */
async function publishRun(): Promise<string> {
  put(source, EXISTING, "the user's version");
  const manager = new WorkspaceLeaseManager({
    projectRoot: source,
    leaseRoot,
    preferGitWorktree: false,
    additionalExcludes: ["Library", "Temp", "Logs", "Builds", "obj"],
  });
  const lease = await manager.acquireLease({ label: "t", forceTempCopy: true });
  writeFileSync(join(lease.path, EXISTING), "the run's version", "utf8");
  put(lease.path, NEW, "brand new");
  const result = await lease.commit();
  await lease.release();
  expect(result.changeReview).toBeDefined();
  // The run really is in the project now.
  expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
  expect(readFileSync(join(source, NEW), "utf8")).toBe("brand new");
  return result.changeReview!.id;
}

/** Wait for an async route handler to answer (real fs work, so poll on time). */
async function answered(res: MockRes & ServerResponse): Promise<void> {
  for (let i = 0; i < 400 && !res.end.mock.calls.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(res.end).toHaveBeenCalled();
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  projectRoot: string = source,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = createMockRes();
  const req = createMockReq(body === undefined ? undefined : JSON.stringify(body));
  const handled = handleChangeReviewRoute(url, method, req, res, projectRoot);
  expect(handled).toBe(true);
  await answered(res);
  return { status: (res as MockRes).statusCode, json: responseJson(res) };
}

describe("change-review routes: the review reaches the portal", () => {
  it("hands out the published review id and its entries, in the portal's path form", async () => {
    const reviewId = await publishRun();

    const { status, json } = await call("GET", "/api/workspace/change-review");

    expect(status).toBe(200);
    const review = json["review"] as { reviewId: string; entries: Array<{ path: string; action: string; state: string }>; complete: boolean };
    expect(review.reviewId).toBe(reviewId);
    expect(review.complete).toBe(true);
    expect(review.entries.map((e) => e.path).sort()).toEqual([
      "Assets/Scripts/Existing.cs",
      "Assets/Scripts/New.cs",
    ]);
    expect(review.entries.every((e) => e.state === "ready")).toBe(true);
  });

  it("says there is nothing to review when no run has published", async () => {
    const { status, json } = await call("GET", "/api/workspace/change-review");
    expect(status).toBe(200);
    expect(json["review"]).toBeNull();
  });

  it("previews one review by id, and 404s an id that is not recorded", async () => {
    const reviewId = await publishRun();

    const one = await call("GET", `/api/workspace/change-review/${reviewId}`);
    expect(one.status).toBe(200);
    expect((one.json["review"] as { reviewId: string }).reviewId).toBe(reviewId);

    const missing = await call("GET", "/api/workspace/change-review/not-a-real-review");
    expect(missing.status).toBe(404);
  });

  it("stops offering a review once it has been resolved", async () => {
    const reviewId = await publishRun();
    await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "keep" },
        { path: "Assets/Scripts/New.cs", decision: "keep" },
      ],
    });

    const { json } = await call("GET", "/api/workspace/change-review");
    expect(json["review"]).toBeNull();
  });
});

describe("change-review routes: a rejection reverts the project", () => {
  // THE EXIT CRITERION. Not "a decision was recorded": the bytes on disk.
  it("puts the previous bytes back and removes the created file", async () => {
    const reviewId = await publishRun();

    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(status).toBe(200);
    expect(json["outcome"]).toBe("undone");
    expect((json["applied"] as string[]).sort()).toEqual(["Assets/Scripts/Existing.cs", "Assets/Scripts/New.cs"]);
    expect(json["leftOver"]).toEqual([]);
    // The project, on disk.
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the user's version");
    expect(existsSync(join(source, NEW))).toBe(false);
    // And the record says so, so a reload does not offer the undo again.
    expect(readChangeReview(source, reviewId)!.status).toBe("undone");
  });

  it("reports what it did in terms the portal can trust: only `applied` names a reverted path", async () => {
    const reviewId = await publishRun();
    const { json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });
    const applied = json["applied"] as string[];
    for (const path of applied) {
      const abs = join(source, path);
      // Every path reported as applied really moved: restored to the previous
      // bytes, or gone.
      expect(!existsSync(abs) || readFileSync(abs, "utf8") === "the user's version").toBe(true);
    }
    expect(json["kept"]).toEqual([]);
    expect(json["failed"]).toEqual([]);
  });

  // A human edited the file after the run published it. The undo must refuse,
  // and the refusal must leave the human's bytes exactly where they are.
  it("refuses when a path moved since the run published it, and touches nothing", async () => {
    const reviewId = await publishRun();
    writeFileSync(join(source, EXISTING), "a person edited this afterwards", "utf8");

    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(status).toBe(409);
    expect(String(json["reason"])).toContain("nothing was undone");
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("a person edited this afterwards");
    expect(readFileSync(join(source, NEW), "utf8")).toBe("brand new");
    expect(readChangeReview(source, reviewId)!.status).toBe("open");
  });

  // The user rejected one file of two. Undoing "just that one" is not something
  // the server can do, and silently reverting the other is the damage the review
  // exists to prevent.
  it("refuses a partial rejection, names the paths it would also have reverted, and changes nothing", async () => {
    const reviewId = await publishRun();

    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [{ path: "Assets/Scripts/Existing.cs", decision: "undo" }],
    });

    expect(status).toBe(409);
    expect(json["paths"]).toEqual(["Assets/Scripts/New.cs"]);
    expect(String(json["reason"])).toContain("Assets/Scripts/New.cs");
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
    expect(readFileSync(join(source, NEW), "utf8")).toBe("brand new");
  });

  it("refuses a mixed keep/undo set the same way", async () => {
    const reviewId = await publishRun();

    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "keep" },
      ],
    });

    expect(status).toBe(409);
    expect(String(json["error"])).toContain("as a whole");
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
  });

  it("keeping resolves the review and leaves the run's bytes in place", async () => {
    const reviewId = await publishRun();

    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "keep" },
        { path: "Assets/Scripts/New.cs", decision: "keep" },
      ],
    });

    expect(status).toBe(200);
    expect(json["outcome"]).toBe("kept");
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
    expect(readChangeReview(source, reviewId)!.status).toBe("kept");
  });
});

describe("change-review routes: what they refuse", () => {
  it("a decision for a path this review never touched", async () => {
    const reviewId = await publishRun();
    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [{ path: "Assets/Scripts/Elsewhere.cs", decision: "undo" }],
    });
    expect(status).toBe(409);
    expect(json["paths"]).toEqual(["Assets/Scripts/Elsewhere.cs"]);
  });

  it("an id that is not a review id never reaches the filesystem", async () => {
    const traversal = await call("POST", "/api/workspace/change-review/..%2F..%2Fetc/decisions", {
      decisions: [{ path: "x", decision: "undo" }],
    });
    expect(traversal.status).toBe(400);
    expect(String(traversal.json["error"])).toContain("review id");

    const get = await call("GET", "/api/workspace/change-review/..%2F..%2Fetc");
    expect(get.status).toBe(400);
  });

  it("no decisions, an unknown decision, and a duplicated path", async () => {
    const reviewId = await publishRun();
    const base = `/api/workspace/change-review/${reviewId}/decisions`;
    expect((await call("POST", base, { decisions: [] })).status).toBe(400);
    expect((await call("POST", base, {})).status).toBe(400);
    expect((await call("POST", base, { decisions: [{ path: "a", decision: "maybe" }] })).status).toBe(400);
    expect(
      (
        await call("POST", base, {
          decisions: [
            { path: "a", decision: "undo" },
            { path: "a", decision: "keep" },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it("a method that is not POST on the decisions path", async () => {
    const reviewId = await publishRun();
    const { status } = await call("GET", `/api/workspace/change-review/${reviewId}/decisions`);
    expect(status).toBe(405);
  });

  it("an unconfigured project root", async () => {
    const res = createMockRes();
    expect(handleChangeReviewRoute("/api/workspace/change-review", "GET", createMockReq(), res, undefined)).toBe(true);
    await answered(res);
    expect((res as MockRes).statusCode).toBe(400);
    expect(String(responseJson(res)["error"])).toContain("Project path");
  });

  it("URLs that belong to the file explorer are left alone", () => {
    const res = createMockRes();
    expect(handleChangeReviewRoute("/api/workspace/files?path=.", "GET", createMockReq(), res, source)).toBe(false);
    expect(handleChangeReviewRoute("/api/monitor/tasks", "GET", createMockReq(), res, source)).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("an unknown change-review URL is a 404, not a fall-through", async () => {
    const { status } = await call("GET", "/api/workspace/change-review/a/b/c");
    expect(status).toBe(404);
  });
});

/**
 * Codex round 12 #10, #12, #15, #16 — what the transport itself got wrong.
 *
 * All four are about the REQUEST rather than the undo: who may send one, what a
 * malformed one does, what a repeated one gets back, and what a partial one
 * closes. Each test names the finding it reproduces.
 */

/** A request with headers — the mock req is a bare emitter, which has none. */
function reqWith(headers: Record<string, string>, body?: unknown): IncomingMessage {
  const req = createMockReq(body === undefined ? undefined : JSON.stringify(body));
  return Object.assign(req, { headers }) as IncomingMessage;
}

async function callAs(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = createMockRes();
  const handled = handleChangeReviewRoute(url, method, reqWith(headers, body), res, source);
  expect(handled).toBe(true);
  await answered(res);
  return { status: (res as MockRes).statusCode, json: responseJson(res) };
}

/**
 * The identity store the web channel keeps (src/channels/web/web-identity-store.ts),
 * as this route needs it: verify a pair, name the owner, count the identities.
 */
function identities(opts: { owner?: string | null; issued?: string[] } = {}): ChangeReviewIdentityStore {
  const issued = opts.issued ?? ["owner-profile", "guest-profile"];
  return {
    verify: (profileId, profileToken) => issued.includes(profileId) && profileToken === `token-of-${profileId}`,
    // `owner: null` is an instance that has recorded no owner at all.
    ownerProfileId: () => (opts.owner === null ? undefined : opts.owner ?? "owner-profile"),
    has: (profileId) => issued.includes(profileId),
    count: () => issued.length,
  };
}

const OWNER_HEADERS = {
  "x-strada-profile-id": "owner-profile",
  "x-strada-profile-token": "token-of-owner-profile",
};
const GUEST_HEADERS = {
  "x-strada-profile-id": "guest-profile",
  "x-strada-profile-token": "token-of-guest-profile",
};

describe("change-review routes: who is allowed to decide (round 12 #10)", () => {
  afterEach(() => setChangeReviewIdentityStore(null));

  // THE DEFECT. Admission was the portal's Origin/Referer check and nothing
  // else: any caller it let through could revert another profile's run in the
  // user's project. The handler received no identity and asked no question.
  it("a guest may not revert the owner's run, and the project is untouched", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(identities());

    const { status, json } = await callAs("POST", `/api/workspace/change-review/${reviewId}/decisions`, GUEST_HEADERS, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(status).toBe(403);
    expect(String(json["reason"])).toContain("guest-profile");
    // The run's bytes are still there: a refusal touches nothing.
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
    expect(readFileSync(join(source, NEW), "utf8")).toBe("brand new");
    expect(readChangeReview(source, reviewId)!.status).toBe("open");
  });

  it("a guest may not list or preview the review either", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(identities());

    expect((await callAs("GET", "/api/workspace/change-review", GUEST_HEADERS)).status).toBe(403);
    expect((await callAs("GET", `/api/workspace/change-review/${reviewId}`, GUEST_HEADERS)).status).toBe(403);
  });

  it("the owner may, and the bytes move", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(identities());

    const { status, json } = await callAs("POST", `/api/workspace/change-review/${reviewId}/decisions`, OWNER_HEADERS, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(status).toBe(200);
    expect(json["outcome"]).toBe("undone");
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the user's version");
    expect(existsSync(join(source, NEW))).toBe(false);
  });

  // The identity must be VERIFIED. A profile id is a public value — the portal
  // stores it in localStorage and the server sends it to clients — so naming the
  // owner is not being the owner.
  it("the owner's id with a token that does not verify is not the owner", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(identities());

    const { status, json } = await callAs(
      "POST",
      `/api/workspace/change-review/${reviewId}/decisions`,
      { "x-strada-profile-id": "owner-profile", "x-strada-profile-token": "guessed" },
      { decisions: [{ path: "Assets/Scripts/Existing.cs", decision: "undo" }] },
    );

    expect(status).toBe(403);
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
  });

  it("an unattributed request is refused once the instance is shared", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(identities());

    const { status, json } = await callAs("POST", `/api/workspace/change-review/${reviewId}/decisions`, {}, {
      decisions: [{ path: "Assets/Scripts/Existing.cs", decision: "undo" }],
    });

    expect(status).toBe(403);
    expect(String(json["reason"])).toContain("shared");
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
  });

  // ROUND 13 #9 MOVED THIS LINE, DELIBERATELY. It used to read "a
  // single-identity instance decides with no identity at all", and that was the
  // hole: an instance with one REGISTERED OWNER is not \`shared\`, so an
  // unattributed request was granted the owner's power. Once an owner exists the
  // caller must prove it is the owner — the portal attaches the pair to its own
  // requests (round 13 #7), so the one-person portal keeps working.
  it("refuses an unattributed decision on a one-identity instance that HAS an owner", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(identities({ issued: ["owner-profile"] }));

    const { status, json } = await callAs("POST", `/api/workspace/change-review/${reviewId}/decisions`, {}, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(status).toBe(403);
    expect(String(json["reason"])).toContain("owner");
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
  });

  // …and the direction that would be a defect of its own: the instance that has
  // never issued a web identity at all (no portal, no owner) must keep deciding.
  it("an instance with no identities at all decides with no identity at all", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(identities({ owner: null, issued: [] }));

    const { status } = await callAs("POST", `/api/workspace/change-review/${reviewId}/decisions`, {}, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(status).toBe(200);
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the user's version");
  });
});

// ── Round 13 #14: an unreadable identity store is not an empty one ────────────
//
// THE DEFECT. The identity database was opened lazily and a FAILURE was latched
// in a process-wide flag; from then on the route saw "no store", read that as
// count 0, concluded "not shared" and authorized ANONYMOUS reverts of the user's
// project — permanently, until the daemon restarted. The failure has to be
// answered as a failure.
describe("change-review routes: an unreadable identity store denies (round 13 #14)", () => {
  afterEach(() => setChangeReviewIdentityStore(null));

  function unreadable(): ChangeReviewIdentityStore {
    const boom = (): never => { throw new Error("SQLITE_CORRUPT: database disk image is malformed"); };
    return { verify: boom, ownerProfileId: boom, has: boom, count: boom };
  }

  it("answers 503 and touches nothing, instead of granting the anonymous caller", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(unreadable());

    const { status, json } = await callAs("POST", `/api/workspace/change-review/${reviewId}/decisions`, {}, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(status).toBe(503);
    expect(String(json["code"])).toContain("unavailable");
    // The run's bytes are untouched and the review is still open to be decided.
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the run's version");
    expect(readChangeReview(source, reviewId)!.status).toBe("open");
  });

  it("refuses the reads too, rather than previewing somebody else's run", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(unreadable());

    expect((await callAs("GET", "/api/workspace/change-review", {})).status).toBe(503);
    expect((await callAs("GET", `/api/workspace/change-review/${reviewId}`, {})).status).toBe(503);
  });

  it("recovers as soon as the store is readable again — no restart, no latch", async () => {
    const reviewId = await publishRun();
    setChangeReviewIdentityStore(unreadable());
    expect((await callAs("GET", "/api/workspace/change-review", {})).status).toBe(503);

    setChangeReviewIdentityStore(identities());
    const { status } = await callAs("POST", `/api/workspace/change-review/${reviewId}/decisions`, OWNER_HEADERS, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });
    expect(status).toBe(200);
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the user's version");
  });
});

describe("change-review routes: a malformed id is an answer, not a throw (round 12 #12)", () => {
  // THE DEFECT. decodeURIComponent on "%" throws a URIError, and it was called
  // outside the handler's try — synchronously, before the async body. The
  // dashboard's request handler saw the throw, not a 400.
  it("GET …/change-review/% answers 400", async () => {
    const res = createMockRes();
    expect(() => handleChangeReviewRoute("/api/workspace/change-review/%", "GET", createMockReq(), res, source)).not.toThrow();
    await answered(res);
    expect((res as MockRes).statusCode).toBe(400);
  });

  it("POST …/change-review/%E0%A4%A/decisions answers 400", async () => {
    const res = createMockRes();
    const req = createMockReq(JSON.stringify({ decisions: [{ path: "a", decision: "undo" }] }));
    expect(() =>
      handleChangeReviewRoute("/api/workspace/change-review/%E0%A4%A/decisions", "POST", req, res, source),
    ).not.toThrow();
    await answered(res);
    expect((res as MockRes).statusCode).toBe(400);
  });
});

describe("change-review routes: a repeated decision gets its answer back (round 12 #15)", () => {
  // THE DEFECT. Lose the first successful response and repeat the decision: the
  // paths are already undone, so `applied` comes back empty and the portal —
  // which may only present what `applied` names — shows the finished revert as
  // refused, with the decision still queued.
  it("replays the acknowledgement of an undo that already happened", async () => {
    const reviewId = await publishRun();
    const decisions = [
      { path: "Assets/Scripts/Existing.cs", decision: "undo" },
      { path: "Assets/Scripts/New.cs", decision: "undo" },
    ];
    const first = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, { decisions });
    expect((first.json["applied"] as string[]).sort()).toEqual(["Assets/Scripts/Existing.cs", "Assets/Scripts/New.cs"]);

    const retry = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, { decisions });

    expect(retry.status).toBe(200);
    expect(retry.json["outcome"]).toBe("undone");
    expect((retry.json["applied"] as string[]).sort()).toEqual([
      "Assets/Scripts/Existing.cs",
      "Assets/Scripts/New.cs",
    ]);
    expect(retry.json["replayed"]).toBe(true);
    // Replayed, not re-run: the project was not touched a second time.
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the user's version");
    expect(existsSync(join(source, NEW))).toBe(false);
  });

  it("replays a keep the same way", async () => {
    const reviewId = await publishRun();
    const decisions = [
      { path: "Assets/Scripts/Existing.cs", decision: "keep" },
      { path: "Assets/Scripts/New.cs", decision: "keep" },
    ];
    await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, { decisions });
    const retry = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, { decisions });

    expect(retry.status).toBe(200);
    expect(retry.json["outcome"]).toBe("kept");
    expect((retry.json["applied"] as string[]).sort()).toEqual([
      "Assets/Scripts/Existing.cs",
      "Assets/Scripts/New.cs",
    ]);
    expect(retry.json["replayed"]).toBe(true);
  });

  // A retry is reconciled against ITS OWN decision set. Changing your mind is
  // not a retry, and must not be answered with the old acknowledgement.
  it("a different decision for the same review is not a replay", async () => {
    const reviewId = await publishRun();
    await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "keep" },
        { path: "Assets/Scripts/New.cs", decision: "keep" },
      ],
    });

    const changedMind = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "undo" },
        { path: "Assets/Scripts/New.cs", decision: "undo" },
      ],
    });

    expect(changedMind.json["replayed"]).toBeUndefined();
    expect((changedMind.json["applied"] as string[]).sort()).toEqual([
      "Assets/Scripts/Existing.cs",
      "Assets/Scripts/New.cs",
    ]);
    expect(readFileSync(join(source, EXISTING), "utf8")).toBe("the user's version");
  });
});

describe("change-review routes: keeping is review-wide too (round 12 #16)", () => {
  // THE DEFECT. keepChanges() resolves the RECORD, so keeping one path of a
  // two-path review closed both — and the newest-unresolved lookup then hid the
  // path nobody had decided about. The undo side already refuses this.
  it("keeping one path of two is refused and names the undecided one", async () => {
    const reviewId = await publishRun();

    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [{ path: "Assets/Scripts/Existing.cs", decision: "keep" }],
    });

    expect(status).toBe(409);
    expect(json["paths"]).toEqual(["Assets/Scripts/New.cs"]);
    expect(readChangeReview(source, reviewId)!.status).toBe("open");
    // …and the review is still the one the portal is offered.
    const newest = await call("GET", "/api/workspace/change-review");
    expect((newest.json["review"] as { reviewId: string }).reviewId).toBe(reviewId);
  });

  it("keeping every path still resolves it", async () => {
    const reviewId = await publishRun();
    const { status, json } = await call("POST", `/api/workspace/change-review/${reviewId}/decisions`, {
      decisions: [
        { path: "Assets/Scripts/Existing.cs", decision: "keep" },
        { path: "Assets/Scripts/New.cs", decision: "keep" },
      ],
    });
    expect(status).toBe(200);
    expect(json["outcome"]).toBe("kept");
    expect(readChangeReview(source, reviewId)!.status).toBe("kept");
  });
});
