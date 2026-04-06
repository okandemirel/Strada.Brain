/**
 * Framework Extractor Factory
 *
 * Separated from the base class to break the circular dependency:
 *   framework-extractor <-> framework-extractor-csharp
 *   framework-extractor <-> framework-extractor-mcp
 *
 * The factory uses dynamic imports so the subclass files import
 * the base class, but the base class does NOT import the subclasses.
 */

import type { FrameworkPackageConfig } from "./framework-types.js";
import type { FrameworkExtractor } from "./framework-extractor.js";

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
