/**
 * Framework Extractor -- Abstract Base
 *
 * Defines the contract for package-specific extractors.
 * The factory function lives in framework-extractor-factory.ts to avoid
 * circular dependencies (base <-> subclass).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameworkAPISnapshot, FrameworkPackageConfig, SourceOrigin } from "./framework-types.js";

export abstract class FrameworkExtractor {
  /**
   * `sourceOrigin` is the CALLER's knowledge, not an assumption: both
   * extractors used to stamp every snapshot "local", so an API read from a
   * shallow GitHub clone claimed to be the project's own installed source
   * (plan 2.13 / U2+M3 / D51).
   */
  constructor(
    protected readonly sourcePath: string,
    protected readonly packageConfig: FrameworkPackageConfig,
    protected readonly sourceOrigin: SourceOrigin = "local",
  ) {}

  /** Extract a full API snapshot from the package source */
  abstract extract(): Promise<FrameworkAPISnapshot>;

  /** Detect the package version from source (reads package.json by default) */
  protected async detectVersion(): Promise<string | null> {
    const packageJsonPath = join(this.sourcePath, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        /* ignore parse errors */
      }
    }
    return null;
  }

  /** Get git commit hash if available */
  protected detectGitHash(): string | null {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.sourcePath,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }
}
