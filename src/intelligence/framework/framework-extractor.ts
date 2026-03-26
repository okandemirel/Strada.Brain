/**
 * Framework Extractor -- Abstract Base
 *
 * Defines the contract for package-specific extractors and provides
 * a factory function that selects the right implementation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameworkAPISnapshot, FrameworkPackageConfig } from "./framework-types.js";

export abstract class FrameworkExtractor {
  constructor(
    protected readonly sourcePath: string,
    protected readonly packageConfig: FrameworkPackageConfig,
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

/**
 * Factory -- creates the appropriate extractor for a given package config.
 * Uses dynamic imports (ESM) to keep boot cost low.
 */
export async function createExtractor(
  sourcePath: string,
  packageConfig: FrameworkPackageConfig,
): Promise<FrameworkExtractor> {
  switch (packageConfig.sourceLanguage) {
    case "csharp": {
      const { CSharpFrameworkExtractor } = await import("./framework-extractor-csharp.js");
      return new CSharpFrameworkExtractor(sourcePath, packageConfig);
    }
    case "typescript": {
      const { MCPFrameworkExtractor } = await import("./framework-extractor-mcp.js");
      return new MCPFrameworkExtractor(sourcePath, packageConfig);
    }
  }
}
