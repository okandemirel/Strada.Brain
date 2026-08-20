/**
 * A delegated worker must inherit what the user authorized.
 *
 * Measured 2026-08-20: the run decomposed into multi-agent work and the very
 * first read of /Users/okan/Downloads/PixelFlow_GDD.docx — the document the
 * task was about, named by the user in their own request — came back "Path
 * resolves outside the project directory".
 *
 * The authorization is per-Orchestrator state, and delegation builds a new
 * Orchestrator with an empty map. The evidence of what the user typed did not
 * cross the instance boundary.
 */

import { describe, it, expect } from "vitest";
import { Orchestrator } from "../../orchestrator.js";

function orchestrator(): Orchestrator {
  return Object.create(Orchestrator.prototype, {
    authorizedPathsByChat: { value: new Map<string, readonly string[]>(), writable: true },
  }) as Orchestrator;
}

describe("carrying authorization across a delegation", () => {
  it("hands the parent's paths to the delegate's own chat id", () => {
    const child = orchestrator();

    child.seedUserAuthorizedPaths("delegation-sub-1", ["/Users/okan/Downloads/PixelFlow_GDD.docx"]);

    expect(child.userAuthorizedPathsSnapshot("delegation-sub-1")).toEqual([
      "/Users/okan/Downloads/PixelFlow_GDD.docx",
    ]);
  });

  it("authorizes nothing for a chat that was given nothing", () => {
    const child = orchestrator();

    child.seedUserAuthorizedPaths("delegation-sub-1", ["/a/b.docx"]);

    expect(child.userAuthorizedPathsSnapshot("delegation-sub-2")).toEqual([]);
  });

  it("widens rather than replaces, so a second delegation cannot narrow the first", () => {
    const child = orchestrator();

    child.seedUserAuthorizedPaths("c", ["/a.docx"]);
    child.seedUserAuthorizedPaths("c", ["/b.docx"]);

    expect(child.userAuthorizedPathsSnapshot("c")).toEqual(["/a.docx", "/b.docx"]);
  });

  it("does nothing when the parent held no authorization", () => {
    const child = orchestrator();

    child.seedUserAuthorizedPaths("c", []);

    expect(child.userAuthorizedPathsSnapshot("c")).toEqual([]);
  });

  it("does not duplicate a path handed down twice", () => {
    const child = orchestrator();

    child.seedUserAuthorizedPaths("c", ["/a.docx"]);
    child.seedUserAuthorizedPaths("c", ["/a.docx"]);

    expect(child.userAuthorizedPathsSnapshot("c")).toEqual(["/a.docx"]);
  });
});
