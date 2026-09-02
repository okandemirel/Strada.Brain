/**
 * What the process-wide build state may still say about a run that is over.
 *
 * Audited 2026-09-02: getLatestGlobalBuildState() preferred ANY failing entry
 * over the newest one with no recency bound, and nothing removed a verifier's
 * entry when its run ended (the only delete was the >64 eviction). So worker
 * A's last red compile — with A's long-gone files — outlived hours of green
 * compiles from B, C and D, and the daemon's BuildStateObserver, which emits
 * only on change, could never say "Build succeeded" again nor announce a NEW
 * real failure while A's entry survived.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildStateObserver } from "../../agent-core/observers/build-state-observer.js";
import { SelfVerification, getLatestGlobalBuildState } from "./self-verification.js";

const created: SelfVerification[] = [];

function verifier(): SelfVerification {
  const v = new SelfVerification();
  created.push(v);
  return v;
}

function compiles(v: SelfVerification, path: string, ok: boolean): void {
  v.track("file_write", { path }, { toolCallId: "w", content: "written", isError: false });
  v.track("unity_verify_change", {}, {
    toolCallId: "v",
    content: ok ? "compile green" : "error CS0103: The name does not exist",
    isError: !ok,
  });
}

afterEach(() => {
  // Retire every publisher this test created so the module-level map does
  // not carry one test's state into the next.
  for (const v of created.splice(0)) v.dispose();
  vi.useRealTimers();
});

describe("getLatestGlobalBuildState — a dead run's failure does not win forever", () => {
  it("stops preferring a failing state once it is older than the staleness window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const a = verifier();
    compiles(a, "Assets/Scripts/A_LongGone.cs", false);
    expect(getLatestGlobalBuildState().lastBuildOk).toBe(false);

    // A's run is over. Eleven minutes later three other workers compile clean.
    vi.setSystemTime(new Date("2026-09-02T00:11:00Z"));
    for (const name of ["B", "C", "D"]) compiles(verifier(), `Assets/Scripts/${name}.cs`, true);

    const state = getLatestGlobalBuildState();
    expect(state.lastBuildOk).toBe(true);
    expect(state.pendingFiles.has("Assets/Scripts/A_LongGone.cs")).toBe(false);
  });

  it("still lets a fresh failure win over a newer clean state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T01:00:00Z"));
    const a = verifier();
    compiles(a, "Assets/Scripts/StillRed.cs", false);
    vi.setSystemTime(new Date("2026-09-02T01:02:00Z"));
    compiles(verifier(), "Assets/Scripts/Green.cs", true);

    // Two minutes is a live worker mid-fix, not a dead run.
    const state = getLatestGlobalBuildState();
    expect(state.lastBuildOk).toBe(false);
    expect(state.pendingFiles.has("Assets/Scripts/StillRed.cs")).toBe(true);
  });

  it("dispose() retires a verifier's published state immediately", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T02:00:00Z"));
    const a = verifier();
    compiles(a, "Assets/Scripts/A.cs", false);
    compiles(verifier(), "Assets/Scripts/B.cs", true);
    expect(getLatestGlobalBuildState().lastBuildOk).toBe(false);

    a.dispose();

    expect(getLatestGlobalBuildState().lastBuildOk).toBe(true);
  });

  it("lets the observer report a recovery after the dead failing publisher ages out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T03:00:00Z"));
    const observer = new BuildStateObserver({ getState: getLatestGlobalBuildState });
    compiles(verifier(), "Assets/Scripts/A_LongGone.cs", false);
    expect(observer.collect().map((o) => o.summary)).toEqual([
      expect.stringContaining("Build failed"),
    ]);

    vi.setSystemTime(new Date("2026-09-02T03:15:00Z"));
    compiles(verifier(), "Assets/Scripts/B.cs", true);

    expect(observer.collect().map((o) => o.summary)).toEqual(["Build succeeded"]);
  });
});
