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
import { handleChangeReviewRoute } from "./change-review-routes.js";
import { createMockReq, createMockRes, responseJson, type MockRes } from "./test-support/mock-http.js";
import type { ServerResponse } from "node:http";

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
