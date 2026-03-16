/**
 * Test Result Observer
 * Tracks the most recent test execution outcome.
 * External callers push results when tests complete.
 */

import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  timestamp: number;
  failedTests?: string[];
}

export class TestResultObserver implements Observer {
  readonly name = "test-result-observer";
  private lastResult: TestResult | null = null;
  private reported = false;

  /** Push a test result (called externally after test execution) */
  pushResult(result: TestResult): void {
    this.lastResult = result;
    this.reported = false;
  }

  collect(): AgentObservation[] {
    if (!this.lastResult || this.reported) return [];

    this.reported = true;
    const { passed, failed, skipped, failedTests } = this.lastResult;

    if (failed > 0) {
      const failedList = failedTests?.slice(0, 5).join(", ") ?? "";
      return [
        createObservation("test", `${failed} test(s) failed (${passed} passed, ${skipped} skipped)${failedList ? ": " + failedList : ""}`, {
          priority: 80,
          context: { passed, failed, skipped, failedTests: failedTests?.slice(0, 10) },
        }),
      ];
    }

    return [
      createObservation("test", `All ${passed} tests passed (${skipped} skipped)`, {
        priority: 5,
        actionable: false,
      }),
    ];
  }
}
