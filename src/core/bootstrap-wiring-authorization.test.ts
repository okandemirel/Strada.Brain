/**
 * The path the user named has to be remembered where the message arrives.
 *
 * Measured live: a path the user named in the message that started a run was
 * refused on every read with "Path resolves outside the project directory" —
 * the file the request pointed at, refused to the agent doing the work.
 *
 * Three fixes missed it, each one layer too deep: the extractor was fine, the
 * seeding in handleMessage was fine, sharing the store between orchestrators
 * was necessary but not sufficient. The CLI never calls handleMessage at all —
 * it routes through the message router into a task — so nothing ever wrote the
 * authorization down in the first place, and the stores being shared just
 * shared an empty one.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { extractUserAuthorizedPaths } from "../security/user-authorized-paths.js";

describe("what the wiring must remember before routing", () => {
  const REQUEST =
    "Summarise the brief at /srv/inbox/orchard-irrigation-brief.pdf and draft tasks from it.";

  it("finds the path in the request that starts a run", () => {
    // Resolved: on Windows a rooted path lands on the current drive.
    expect(extractUserAuthorizedPaths(REQUEST)).toEqual([
      resolve("/srv/inbox/orchard-irrigation-brief.pdf"),
    ]);
  });

  it("finds nothing in a request that names no path", () => {
    expect(extractUserAuthorizedPaths("carry on with the task")).toEqual([]);
  });

  it("is called before routing, not inside handleMessage", async () => {
    // The regression this guards: moving the seeding back into a method the
    // CLI does not reach would restore the refused-read failure.
    const { readFileSync } = await import("node:fs");
    const wiring = readFileSync("src/core/bootstrap-wiring.ts", "utf8");
    const seedAt = wiring.indexOf("seedUserAuthorizedPaths");
    const routeAt = wiring.indexOf("messageRouter.route");

    expect(seedAt, "the wiring never seeds the authorization").toBeGreaterThan(-1);
    expect(seedAt, "the authorization is seeded after routing has already run").toBeLessThan(routeAt);
  });

  it("the multi-agent channel handler seeds it before routing too", async () => {
    // Runs no longer derive the authorization from their own prompt, so a
    // channel handler that skips this leaves the user's named file unreadable.
    const { readFileSync } = await import("node:fs");
    const bootstrap = readFileSync("src/core/bootstrap.ts", "utf8");
    const routeAt = bootstrap.indexOf("agentManager!.routeMessage(normalizedMsg)");
    const handlerAt = bootstrap.lastIndexOf("channel.onMessage(", routeAt);
    const seedAt = bootstrap.indexOf("seedUserAuthorizedPaths", handlerAt);

    expect(routeAt, "the multi-agent handler moved").toBeGreaterThan(-1);
    expect(seedAt, "the multi-agent handler never seeds the authorization").toBeGreaterThan(handlerAt);
    expect(seedAt, "the authorization is seeded after routing has already run").toBeLessThan(routeAt);
  });
});
