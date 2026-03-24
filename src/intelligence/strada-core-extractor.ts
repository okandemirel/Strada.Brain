/**
 * Strada.Core API Extractor
 *
 * Backward-compatible wrapper around the generalized CSharpFrameworkExtractor.
 * New code should use CSharpFrameworkExtractor directly from framework/index.ts.
 *
 * @deprecated Use CSharpFrameworkExtractor from ./framework/index.js instead.
 */

import { CSharpFrameworkExtractor } from "./framework/framework-extractor-csharp.js";
import { CORE_PACKAGE_CONFIG } from "./framework/framework-package-configs.js";
import type { FrameworkAPISnapshot } from "./framework/framework-types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CoreAPISnapshot {
  /** All discovered namespaces */
  namespaces: string[];
  /** Base classes with their generic variants */
  baseClasses: Map<string, string[]>;
  /** Attributes found (class name -> attribute names) */
  attributes: Map<string, string[]>;
  /** Interfaces */
  interfaces: Array<{ name: string; namespace: string; methods: string[] }>;
  /** Enums */
  enums: Array<{ name: string; namespace: string; values: string[] }>;
  /** Public classes with their base types */
  classes: Array<{ name: string; namespace: string; baseTypes: string[]; isAbstract: boolean }>;
  /** Public structs */
  structs: Array<{ name: string; namespace: string; baseTypes: string[] }>;
  /** Extracted at timestamp */
  extractedAt: Date;
  /** Source path */
  sourcePath: string;
  /** File count */
  fileCount: number;
}

// ─── Conversion ────────────────────────────────────────────────────────────

function toCoreLegacy(snapshot: FrameworkAPISnapshot): CoreAPISnapshot {
  return {
    namespaces: [...snapshot.namespaces],
    baseClasses: new Map(snapshot.baseClasses),
    attributes: new Map(snapshot.attributes),
    interfaces: snapshot.interfaces.map((i) => ({ ...i })),
    enums: snapshot.enums.map((e) => ({ ...e })),
    classes: snapshot.classes.map((c) => ({ ...c })),
    structs: snapshot.structs.map((s) => ({ ...s })),
    extractedAt: snapshot.extractedAt,
    sourcePath: snapshot.sourcePath,
    fileCount: snapshot.fileCount,
  };
}

// ─── Extractor ─────────────────────────────────────────────────────────────

/**
 * @deprecated Use CSharpFrameworkExtractor from ./framework/index.js instead.
 */
export class StradaCoreExtractor {
  private readonly inner: CSharpFrameworkExtractor;

  constructor(corePath: string) {
    this.inner = new CSharpFrameworkExtractor(corePath, CORE_PACKAGE_CONFIG);
  }

  async extract(): Promise<CoreAPISnapshot> {
    const snapshot = await this.inner.extract();
    return toCoreLegacy(snapshot);
  }
}
