/**
 * Git State Observer
 * Periodically checks git status for uncommitted changes.
 * Uses async child_process to avoid blocking the event loop.
 * The synchronous collect() returns cached results; refresh runs in background.
 */

import { execFileNoThrow } from "../../utils/execFileNoThrow.js";
import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

export class GitStateObserver implements Observer {
  readonly name = "git-state-observer";
  private lastUncommittedCount = 0;
  private readonly projectPath: string;
  private readonly checkIntervalMs: number;
  private lastCheckMs = 0;
  private pendingResult: AgentObservation[] = [];
  private refreshInFlight = false;

  constructor(projectPath: string, checkIntervalMs = 120_000) {
    this.projectPath = projectPath;
    this.checkIntervalMs = checkIntervalMs;
  }

  collect(): AgentObservation[] {
    const now = Date.now();
    if (now - this.lastCheckMs < this.checkIntervalMs) {
      return []; // Rate limit git commands
    }
    this.lastCheckMs = now;

    // Return cached result and trigger async refresh
    const cached = this.pendingResult;
    this.pendingResult = [];
    this.refreshAsync();
    return cached;
  }

  private refreshAsync(): void {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;

    execFileNoThrow("git", ["-C", this.projectPath, "status", "--porcelain"], 5000)
      .then((result) => {
        if (result.exitCode !== 0) return;

        const status = result.stdout.trim();
        const lines = status ? status.split("\n") : [];
        const uncommittedCount = lines.length;

        if (uncommittedCount === this.lastUncommittedCount) return;

        const prevCount = this.lastUncommittedCount;
        this.lastUncommittedCount = uncommittedCount;

        if (uncommittedCount > 0 && uncommittedCount > prevCount) {
          this.pendingResult = [
            createObservation("git", `${uncommittedCount} uncommitted change(s) detected`, {
              priority: 30,
              context: {
                uncommittedCount,
                files: lines.slice(0, 10).map((l) => l.trim()),
              },
            }),
          ];
        }
      })
      .catch(() => {
        // Git command failed — non-fatal
      })
      .finally(() => {
        this.refreshInFlight = false;
      });
  }
}
