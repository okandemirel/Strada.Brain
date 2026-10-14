/**
 * A delegated worker must inherit what the user authorized.
 *
 * Measured 2026-08-20: the run decomposed into multi-agent work and the very
 * first read of a document the user had named by absolute path in their own
 * request, outside the project, came back "Path resolves outside the project
 * directory".
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

    child.seedUserAuthorizedPaths("delegation-sub-1", ["/home/tester/inbox/orchard-survey.docx"]);

    expect(child.userAuthorizedPathsSnapshot("delegation-sub-1")).toEqual([
      "/home/tester/inbox/orchard-survey.docx",
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

describe("one store, every orchestrator", () => {
  // Measured 2026-08-20, after seeding the delegate fixed the delegation path
  // and the refusal came back anyway: the run was decomposing into sub-goals,
  // not delegating. Goal decomposition rewrote the user's absolute path into
  // a sub-goal that carried only the bare file name, so the sub-agent's
  // Orchestrator had nothing to derive from and refused the document its task
  // was about.
  //
  // Per-instance memory cannot survive that: the authorization has to be one
  // store, keyed by chat, that every orchestrator in the process reads.
  function withStore(store: Map<string, readonly string[]>): Orchestrator {
    return Object.create(Orchestrator.prototype, {
      authorizedPathsByChat: { value: store, writable: true },
    }) as Orchestrator;
  }

  it("lets a sub-agent see what the root was told", () => {
    const shared = new Map<string, readonly string[]>();
    const root = withStore(shared);
    const sub = withStore(shared);

    root.seedUserAuthorizedPaths("cli-local", ["/home/tester/inbox/orchard-survey.docx"]);

    expect(sub.userAuthorizedPathsSnapshot("cli-local")).toEqual([
      "/home/tester/inbox/orchard-survey.docx",
    ]);
  });

  it("keeps chats apart even when the store is shared", () => {
    const shared = new Map<string, readonly string[]>();
    const root = withStore(shared);
    const sub = withStore(shared);

    root.seedUserAuthorizedPaths("chat-a", ["/a.docx"]);

    expect(sub.userAuthorizedPathsSnapshot("chat-b")).toEqual([]);
  });

  it("an orchestrator given no store keeps its own", () => {
    const shared = new Map<string, readonly string[]>();
    const root = withStore(shared);
    const isolated = withStore(new Map());

    root.seedUserAuthorizedPaths("cli-local", ["/a.docx"]);

    expect(isolated.userAuthorizedPathsSnapshot("cli-local")).toEqual([]);
  });
});
