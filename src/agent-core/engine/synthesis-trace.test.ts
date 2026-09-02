import { describe, expect, it } from "vitest";
import { buildResultProjection } from "./synthesis.js";

/**
 * The projection used to stamp summary:"" on every trace entry, which made
 * the worker-path test verdict structurally impossible — background-executor
 * derives the verdict from t.summary (audited 2026-09-02).
 */
describe("buildResultProjection tool trace", () => {
  it("projects the tool's result text into WorkerToolTrace.summary", () => {
    const deps = { providerManager: {} } as never;
    const runCtx = {
      identityKey: "k",
      selfVerification: { getState: () => ({ touchedFiles: [] }) },
      workerCollector: undefined,
      lastAssignment: undefined,
    } as never;
    const proj = buildResultProjection(deps, {
      toolTrace: [
        { toolName: "unity_playmode_verify", toolCallId: "c1", success: true, resultText: "PlayMode verification FAILED — 3 of 40 tests failed" },
        { toolName: "file_read", toolCallId: "c2", success: true },
      ],
      touchedFiles: [],
      status: "completed",
      final: { summary: "done" },
    } as never, runCtx);

    expect(proj.toolTrace[0]!.summary).toContain("3 of 40 tests failed");
    expect(proj.toolTrace[1]!.summary).toBe("");
  });
});
