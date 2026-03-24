import { describe, expect, it } from "vitest";
import {
  LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT,
  buildLoopRecoveryReviewRequest,
} from "./loop-recovery-review.js";

describe("loop-recovery-review", () => {
  it("system prompt requires blocked as absolute last resort", () => {
    expect(LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT).toContain("absolute last resort");
    expect(LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT).toContain("daemon or autonomous mode");
  });

  it("includes daemon mode info when opts provided", () => {
    const brief = {
      fingerprint: "test",
      recoveryEpisode: 1,
      requiredActions: [],
      recentToolSummaries: [],
      touchedFiles: [],
      recentUserFacingProgress: [],
      availableDelegations: [],
    };
    const result = buildLoopRecoveryReviewRequest(brief, { daemonMode: true, maxRecoveryEpisodes: 10 });
    expect(result).toContain("Daemon/autonomous mode: YES");
    expect(result).toContain("Max recovery episodes: 10");
  });
});
