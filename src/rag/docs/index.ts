/**
 * Documentation RAG Pipeline — Public API
 */

export type {
  FrameworkDocChunk,
  DocSourceType,
  PackageRoot,
  DocIndexingConfig,
  FrameworkSearchOptions,
} from "./doc-rag.interface.js";
export { isFrameworkDocChunk, DOC_SOURCE_PRIORITY } from "./doc-rag.interface.js";

export { chunkMarkdown, chunkXmlDocs, chunkCSharpExample } from "./doc-chunker.js";
export { discoverPackageRoots, readPackageVersion, hasVersionChanged } from "./version-tagger.js";
export { DocRAGPipeline } from "./doc-rag-pipeline.js";
export { rerankWithFrameworkPriority, DEFAULT_FRAMEWORK_RERANKER_CONFIG } from "./framework-reranker.js";
export type { FrameworkRerankerConfig } from "./framework-reranker.js";
export { CompositeRAGPipeline } from "./composite-rag-pipeline.js";
