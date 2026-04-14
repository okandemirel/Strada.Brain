/**
 * Framework Knowledge Layer -- Type Definitions
 *
 * Universal types for extracting, storing, and serving API knowledge
 * from Strada.Core, Strada.Modules, and Strada.MCP packages.
 */

/** Legacy union of known Strada package identifiers (kept for exhaustive-switch sites) */
export type LegacyFrameworkPackageId = "core" | "modules" | "mcp";

/** Identifies which Strada package a snapshot belongs to (open-ended string for extensibility into user Unity vaults) */
export type FrameworkPackageId = string;

/** Source language determines which parser to use */
export type SourceLanguage = "csharp" | "typescript";

/** How the source was obtained */
export type SourceOrigin = "local" | "git-clone" | "cached";

/**
 * Universal API snapshot -- every framework package produces one.
 * Superset of the existing CoreAPISnapshot from strada-core-extractor.ts.
 */
export interface FrameworkAPISnapshot {
  readonly packageId: FrameworkPackageId;
  readonly packageName: string;
  readonly version: string | null;
  readonly gitHash: string | null;
  readonly namespaces: string[];
  readonly baseClasses: Map<string, string[]>;
  readonly attributes: Map<string, string[]>;
  readonly interfaces: ReadonlyArray<{
    readonly name: string;
    readonly namespace: string;
    readonly methods: string[];
  }>;
  readonly enums: ReadonlyArray<{
    readonly name: string;
    readonly namespace: string;
    readonly values: string[];
  }>;
  readonly classes: ReadonlyArray<{
    readonly name: string;
    readonly namespace: string;
    readonly baseTypes: string[];
    readonly isAbstract: boolean;
  }>;
  readonly structs: ReadonlyArray<{
    readonly name: string;
    readonly namespace: string;
    readonly baseTypes: string[];
  }>;
  /** Exported functions (TS/MCP packages only) */
  readonly exportedFunctions: ReadonlyArray<{
    readonly name: string;
    readonly module: string;
    readonly signature: string;
  }>;
  /** MCP tool definitions (MCP only) */
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchemaKeys: string[];
  }>;
  /** MCP resource definitions (MCP only) */
  readonly resources: ReadonlyArray<{
    readonly name: string;
    readonly uri: string;
    readonly description: string;
  }>;
  /** MCP prompt templates (MCP only) */
  readonly prompts: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
  }>;
  readonly extractedAt: Date;
  readonly sourcePath: string;
  readonly sourceOrigin: SourceOrigin;
  readonly sourceLanguage: SourceLanguage;
  readonly fileCount: number;
}

/** Per-package extraction configuration */
export interface FrameworkPackageConfig {
  readonly packageId: FrameworkPackageId;
  readonly displayName: string;
  readonly sourceLanguage: SourceLanguage;
  readonly fileGlob: string;
  readonly ignoreGlobs: string[];
  readonly repoUrl: string;
  readonly versionDetection: "package.json" | "csproj" | "assembly-info";
}

/** Sync pipeline configuration */
export interface FrameworkSyncConfig {
  readonly bootSync: boolean;
  readonly watchEnabled: boolean;
  readonly watchDebounceMs: number;
  readonly gitFallbackEnabled: boolean;
  readonly gitCacheDir: string;
  readonly gitCacheMaxAgeMs: number;
  readonly maxDriftScore: number;
}

/** Result of a sync operation */
export interface FrameworkSyncResult {
  readonly reports: FrameworkDriftReport[];
  readonly syncedAt: Date;
}

/** Drift report for a single package */
export interface FrameworkDriftReport {
  readonly packageId: FrameworkPackageId;
  readonly totalIssues: number;
  readonly errors: DriftIssue[];
  readonly warnings: DriftIssue[];
  readonly infos: DriftIssue[];
  readonly driftScore: number;
  readonly validatedAt: Date;
  readonly previousVersion: string | null;
  readonly currentVersion: string | null;
  readonly changelog: DriftChangeSummary;
}

export type DriftSeverity = "error" | "warning" | "info";

export interface DriftIssue {
  readonly severity: DriftSeverity;
  readonly category: string;
  readonly message: string;
  readonly brainValue?: string;
  readonly sourceValue?: string;
}

export interface DriftChangeSummary {
  readonly addedNamespaces: string[];
  readonly removedNamespaces: string[];
  readonly addedClasses: string[];
  readonly removedClasses: string[];
  readonly addedInterfaces: string[];
  readonly removedInterfaces: string[];
}

/** Per-package metadata stored alongside snapshots */
export interface FrameworkPackageMetadata {
  readonly packageId: FrameworkPackageId;
  readonly lastSyncAt: number;
  readonly lastVersion: string | null;
  readonly lastGitHash: string | null;
  readonly syncCount: number;
}

/** Serializable form for SQLite storage */
export interface SerializedFrameworkSnapshot {
  readonly packageId: FrameworkPackageId;
  readonly packageName: string;
  readonly version: string | null;
  readonly gitHash: string | null;
  readonly snapshotJson: string;
  readonly extractedAt: number;
  readonly sourcePath: string;
  readonly sourceOrigin: SourceOrigin;
  readonly sourceLanguage: SourceLanguage;
  readonly fileCount: number;
  readonly schemaVersion: number;
}

export const FRAMEWORK_SCHEMA_VERSION = 1;
