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

/**
 * Canonical identity of a project: the realpath of its root.
 *
 * The knowledge store is per MACHINE, so every per-project fact in it needs a
 * project to belong to. Realpath, not the configured path, so /var and
 * /private/var are one project (see \`frameworkProjectId\`).
 */
export type FrameworkProjectId = string;

/**
 * The project id legacy rows are attributed to on upgrade: rows written before
 * origin became project-relative belong to no project, and any binding may
 * claim them (see FrameworkKnowledgeStore.reconcileSourceOrigin). Never a real
 * project id — a canonical project root is an absolute path.
 */
export const UNATTRIBUTED_PROJECT_ID: FrameworkProjectId = "(unattributed)";

/**
 * WHICH project is reading, and the source paths it resolves for each package.
 *
 * One knowledge store is per MACHINE (~/.strada-memory/framework-knowledge.db)
 * while a source tree is per project, so "the latest snapshot of core" is a
 * question with no answer once two projects have synced: the package-wide
 * "live" pointer names whichever synced last (r9 finding 29). A reader carries
 * this binding so it asks about ITS project's source instead.
 *
 * \`projectId\` is the other half (r10 finding 11): two projects can resolve the
 * SAME physical directory with opposite installation status — one installs the
 * shared framework cache, the other only falls back to it — so whether that
 * directory is "installed here" is a fact about the (project, package) pair,
 * not a property of the path. Binding the path alone let whichever project
 * synced last decide the answer for both.
 */
export interface FrameworkSourceBinding {
  /** The project whose view of the store this is. */
  readonly projectId: FrameworkProjectId;
  /** This project's source path for a package, or null when it has none. */
  resolve(packageId: FrameworkPackageId): string | null;
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
  /** sha256 of the extracted API content at last sync; null for rows written before 2026-09-02. */
  readonly lastContentHash: string | null;
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
