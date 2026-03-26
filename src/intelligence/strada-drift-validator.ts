/**
 * Strada.Core Drift Validator
 *
 * Backward-compatible wrapper around the generalized framework-drift.ts.
 * New code should use validateFrameworkDrift from ./framework/framework-drift.js instead.
 *
 * @deprecated Use validateFrameworkDrift / formatFrameworkDriftReport from
 * ./framework/framework-drift.js instead. This module is retained for
 * backward compatibility with existing tests and the Brain baseline builder.
 */

import { STRADA_API } from "../agents/context/strada-api-reference.js";
import type { CoreAPISnapshot } from "./strada-core-extractor.js";
import {
  validateFrameworkDrift,
  formatFrameworkDriftReport,
} from "./framework/framework-drift.js";
import type {
  FrameworkAPISnapshot,
  DriftIssue as FrameworkDriftIssue,
} from "./framework/framework-types.js";

// ─── Types (kept for backward compat) ───────────────────────────────────────

export type DriftSeverity = "error" | "warning" | "info";

export interface DriftIssue {
  severity: DriftSeverity;
  category: string;
  message: string;
  brainValue?: string;
  coreValue?: string;
}

export interface DriftReport {
  /** Total issues found */
  totalIssues: number;
  /** Issues by severity */
  errors: DriftIssue[];
  warnings: DriftIssue[];
  infos: DriftIssue[];
  /** Overall drift score (0 = no drift, 100 = completely out of sync) */
  driftScore: number;
  /** Validated at timestamp */
  validatedAt: Date;
}

// ─── Snapshot Conversion ────────────────────────────────────────────────────

/**
 * Convert a legacy CoreAPISnapshot into a FrameworkAPISnapshot so it can be
 * consumed by the generalized drift validator.
 */
function coreSnapshotToFramework(snapshot: CoreAPISnapshot): FrameworkAPISnapshot {
  return {
    packageId: "core",
    packageName: "Strada.Core",
    version: null,
    gitHash: null,
    namespaces: [...snapshot.namespaces],
    baseClasses: new Map(snapshot.baseClasses),
    attributes: new Map(snapshot.attributes),
    interfaces: snapshot.interfaces.map((i) => ({ ...i })),
    enums: snapshot.enums.map((e) => ({ ...e })),
    classes: snapshot.classes.map((c) => ({ ...c })),
    structs: snapshot.structs.map((s) => ({ ...s })),
    exportedFunctions: [],
    tools: [],
    resources: [],
    prompts: [],
    extractedAt: snapshot.extractedAt,
    sourcePath: snapshot.sourcePath,
    sourceOrigin: "local",
    sourceLanguage: "csharp",
    fileCount: snapshot.fileCount,
  };
}

/**
 * Build a FrameworkAPISnapshot from Brain's static STRADA_API reference.
 * This represents what Brain currently believes the Core API looks like.
 */
export function buildBrainBaselineSnapshot(): FrameworkAPISnapshot {
  return stradaApiToFrameworkSnapshot();
}

function stradaApiToFrameworkSnapshot(): FrameworkAPISnapshot {
  const namespaces = Object.values(STRADA_API.namespaces) as string[];

  // Collect all known classes from base classes, patterns, etc.
  const classes: Array<{ name: string; namespace: string; baseTypes: string[]; isAbstract: boolean }> = [];
  for (const name of STRADA_API.baseClasses.systems) {
    classes.push({ name, namespace: "", baseTypes: [], isAbstract: true });
  }
  for (const name of STRADA_API.baseClasses.burstSystemVariants) {
    classes.push({ name, namespace: "", baseTypes: [], isAbstract: true });
  }
  for (const name of STRADA_API.baseClasses.patterns) {
    classes.push({ name, namespace: "", baseTypes: [], isAbstract: false });
    // Also add the stripped (non-generic) variant so both forms match
    const stripped = name.replace(/<.*>/, "");
    if (stripped !== name && !classes.some((c) => c.name === stripped)) {
      classes.push({ name: stripped, namespace: "", baseTypes: [], isAbstract: false });
    }
  }

  // Add attribute classes (with "Attribute" suffix) so they participate in class drift.
  // The old validator checked that each STRADA_API attribute existed as a class or
  // in the snapshot.attributes values; the new generic validator uses class-level diff.
  for (const val of Object.values(STRADA_API.systemAttributes)) {
    const match = /^\[(\w+)/.exec(val);
    if (match) {
      const attrClassName = match[1]! + "Attribute";
      if (!classes.some((c) => c.name === attrClassName)) {
        classes.push({ name: attrClassName, namespace: "", baseTypes: [], isAbstract: false });
      }
    }
  }

  // Key interfaces the old validator explicitly checked for
  const keyInterfaces = ["IComponent", "IPoolable", "ITickable", "ILoopRunner"];

  return {
    packageId: "core",
    packageName: "Strada.Core",
    version: null,
    gitHash: null,
    namespaces,
    baseClasses: new Map([
      ["SystemBase", [...STRADA_API.baseClasses.systems]],
      ["BurstSystem", [...STRADA_API.baseClasses.burstSystemVariants]],
    ]),
    attributes: new Map(
      Object.entries(STRADA_API.systemAttributes).map(([key, val]) => {
        const match = /^\[(\w+)/.exec(val);
        return [key, match ? [match[1]!] : [val]];
      }),
    ),
    interfaces: keyInterfaces.map((name) => ({ name, namespace: "", methods: [] })),
    enums: [],
    classes,
    structs: [],
    exportedFunctions: [],
    tools: [],
    resources: [],
    prompts: [],
    extractedAt: new Date(),
    sourcePath: "",
    sourceOrigin: "local",
    sourceLanguage: "csharp",
    fileCount: 0,
  };
}

// ─── Issue Conversion ───────────────────────────────────────────────────────

/**
 * Map a framework DriftIssue (sourceValue) to the legacy DriftIssue (coreValue).
 */
function frameworkIssueToLegacy(issue: FrameworkDriftIssue): DriftIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    message: issue.message,
    brainValue: issue.brainValue,
    coreValue: issue.sourceValue,
  };
}

// ─── Validator ──────────────────────────────────────────────────────────────

/**
 * Validate Brain's STRADA_API against a CoreAPISnapshot.
 * Returns a DriftReport with all discovered inconsistencies.
 *
 * @deprecated Use validateFrameworkDrift from ./framework/framework-drift.js instead.
 */
export function validateDrift(snapshot: CoreAPISnapshot): DriftReport {
  const coreSnapshot = coreSnapshotToFramework(snapshot);
  const brainSnapshot = stradaApiToFrameworkSnapshot();

  // brainSnapshot represents "previous" knowledge, coreSnapshot is "current" reality
  const frameworkReport = validateFrameworkDrift("core", coreSnapshot, brainSnapshot);

  const errors = frameworkReport.errors.map(frameworkIssueToLegacy);
  const warnings = frameworkReport.warnings.map(frameworkIssueToLegacy);
  const infos = frameworkReport.infos.map(frameworkIssueToLegacy);

  return {
    totalIssues: frameworkReport.totalIssues,
    errors,
    warnings,
    infos,
    driftScore: frameworkReport.driftScore,
    validatedAt: frameworkReport.validatedAt,
  };
}

// ─── Report Formatting ──────────────────────────────────────────────────────

/**
 * Format a DriftReport as a human-readable string.
 *
 * @deprecated Use formatFrameworkDriftReport from ./framework/framework-drift.js instead.
 */
export function formatDriftReport(report: DriftReport): string {
  // Build a minimal FrameworkDriftReport to delegate to the new formatter
  const frameworkReport = {
    packageId: "core" as const,
    totalIssues: report.totalIssues,
    errors: report.errors.map((i) => ({
      severity: i.severity,
      category: i.category,
      message: i.message,
      brainValue: i.brainValue,
      sourceValue: i.coreValue,
    })),
    warnings: report.warnings.map((i) => ({
      severity: i.severity,
      category: i.category,
      message: i.message,
      brainValue: i.brainValue,
      sourceValue: i.coreValue,
    })),
    infos: report.infos.map((i) => ({
      severity: i.severity,
      category: i.category,
      message: i.message,
      brainValue: i.brainValue,
      sourceValue: i.coreValue,
    })),
    driftScore: report.driftScore,
    validatedAt: report.validatedAt,
    previousVersion: null,
    currentVersion: null,
    changelog: {
      addedNamespaces: [],
      removedNamespaces: [],
      addedClasses: [],
      removedClasses: [],
      addedInterfaces: [],
      removedInterfaces: [],
    },
  };

  return formatFrameworkDriftReport(frameworkReport);
}
