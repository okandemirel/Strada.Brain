/**
 * Documentation RAG -- Type Definitions
 *
 * Extends the core RAG types with framework-specific documentation metadata.
 */

import type { DocumentationChunk, SearchOptions } from "../rag.interface.js";

/** Source type for framework documentation ranking */
export type DocSourceType =
  | "framework_readme"
  | "framework_changelog"
  | "framework_docs"
  | "xml_doc_comment"
  | "framework_example"
  | "api_summary"
  | "project_readme"
  | "project_docs";

/** Framework documentation chunk with package version metadata */
export interface FrameworkDocChunk extends DocumentationChunk {
  /** Package identity (e.g., "strada.core") */
  readonly packageName: string;
  /** Semver version string */
  readonly packageVersion: string;
  /** Source type for retrieval ranking */
  readonly docSource: DocSourceType;
}

/** Type guard for FrameworkDocChunk */
export function isFrameworkDocChunk(chunk: unknown): chunk is FrameworkDocChunk {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    "packageName" in chunk &&
    "docSource" in chunk
  );
}

/** Package root for version tagging */
export interface PackageRoot {
  readonly name: string;
  readonly path: string;
  readonly version: string;
}

/** Doc indexing configuration */
export interface DocIndexingConfig {
  readonly packageRoots: PackageRoot[];
  readonly extraDocPaths: string[];
  readonly maxDocChunkChars: number;
  readonly overlapChars: number;
}

/** Framework-aware search options */
export interface FrameworkSearchOptions extends SearchOptions {
  readonly packageFilter?: string[];
  readonly frameworkOnly?: boolean;
  readonly projectOnly?: boolean;
  readonly preferredSources?: DocSourceType[];
}

/** Source priority scores for reranking */
export const DOC_SOURCE_PRIORITY: Record<DocSourceType, number> = {
  framework_readme: 1.0,
  framework_docs: 0.95,
  api_summary: 0.90,
  xml_doc_comment: 0.85,
  framework_example: 0.80,
  framework_changelog: 0.60,
  project_readme: 0.40,
  project_docs: 0.35,
};
