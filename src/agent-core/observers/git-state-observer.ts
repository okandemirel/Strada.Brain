/**
 * Git State Observer
 * Periodically checks git status for uncommitted changes.
 * Runs git commands via child_process (sync, fast).
 */

import { execSync } from "node:child_process";
import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

export class GitStateObserver implements Observer {
  readonly name = "git-state-observer";
  private lastUncommittedCount = 0;
  private readonly projectPath: string;
  private readonly checkIntervalMs: number;
  private lastCheckMs = 0;

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

    try {
      // Safe: no user input in command string — hardcoded git porcelain call
      const status = execSync("git status --porcelain", {
        cwd: this.projectPath,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      const lines = status ? status.split("\n") : [];
      const uncommittedCount = lines.length;

      // Only report on significant changes
      if (uncommittedCount === this.lastUncommittedCount) {
        return [];
      }

      const prevCount = this.lastUncommittedCount;
      this.lastUncommittedCount = uncommittedCount;

      if (uncommittedCount > 0 && uncommittedCount > prevCount) {
        return [
          createObservation("git", `${uncommittedCount} uncommitted change(s) detected`, {
            priority: 30,
            context: {
              uncommittedCount,
              files: lines.slice(0, 10).map((l) => l.trim()),
            },
          }),
        ];
      }

      return [];
    } catch {
      // Git command failed (not a git repo, git not installed, etc.)
      return [];
    }
  }
}
