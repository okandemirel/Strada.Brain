/**
 * Framework Knowledge Layer — Public API
 */

// Types
export type {
  FrameworkPackageId,
  SourceLanguage,
  SourceOrigin,
  FrameworkAPISnapshot,
  FrameworkPackageConfig,
  FrameworkSyncConfig,
  FrameworkSyncResult,
  FrameworkDriftReport,
  DriftSeverity,
  DriftIssue,
  DriftChangeSummary,
  FrameworkPackageMetadata,
  SerializedFrameworkSnapshot,
} from "./framework-types.js";
export { FRAMEWORK_SCHEMA_VERSION } from "./framework-types.js";

// Package configs
export {
  CORE_PACKAGE_CONFIG,
  MODULES_PACKAGE_CONFIG,
  MCP_PACKAGE_CONFIG,
  FRAMEWORK_PACKAGE_CONFIGS,
} from "./framework-package-configs.js";

// Extractors
export { FrameworkExtractor, createExtractor } from "./framework-extractor.js";
export { CSharpFrameworkExtractor } from "./framework-extractor-csharp.js";
export { MCPFrameworkExtractor } from "./framework-extractor-mcp.js";

// Store
export { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";

// Drift validator
export { validateFrameworkDrift, formatFrameworkDriftReport } from "./framework-drift.js";

// Sync pipeline
export { FrameworkSyncPipeline } from "./framework-sync-pipeline.js";

// Prompt generator
export { FrameworkPromptGenerator } from "./framework-prompt-generator.js";

// Schema provider
export {
  FrameworkSchemaProvider,
  getFrameworkSchemaProvider,
  initializeFrameworkSchemaProvider,
} from "./framework-schema-provider.js";
