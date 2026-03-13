/**
 * Strada.Core Drift Validator
 *
 * Compares Brain's STRADA_API knowledge against a CoreAPISnapshot
 * extracted from actual Strada.Core source code.
 */

import { STRADA_API } from "../agents/context/strada-api-reference.js";
import type { CoreAPISnapshot } from "./strada-core-extractor.js";

// ─── Types ─────────────────────────────────────────────────────────────────

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

// ─── Validator ─────────────────────────────────────────────────────────────

/**
 * Validate Brain's STRADA_API against a CoreAPISnapshot.
 * Returns a DriftReport with all discovered inconsistencies.
 */
export function validateDrift(snapshot: CoreAPISnapshot): DriftReport {
  const issues: DriftIssue[] = [];

  validateNamespaces(snapshot, issues);
  validateBaseClasses(snapshot, issues);
  validateAttributes(snapshot, issues);
  validateInterfaces(snapshot, issues);

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");

  // Calculate drift score: errors=10pts, warnings=3pts, infos=1pt, capped at 100
  const rawScore = errors.length * 10 + warnings.length * 3 + infos.length;
  const driftScore = Math.min(100, rawScore);

  return {
    totalIssues: issues.length,
    errors,
    warnings,
    infos,
    driftScore,
    validatedAt: new Date(),
  };
}

// ─── Validation Rules ──────────────────────────────────────────────────────

function validateNamespaces(snapshot: CoreAPISnapshot, issues: DriftIssue[]): void {
  const brainNamespaces = new Set(Object.values(STRADA_API.namespaces) as string[]);

  // Check that each Brain namespace actually exists in Core
  for (const [key, ns] of Object.entries(STRADA_API.namespaces) as [string, string][]) {
    if (!snapshot.namespaces.some((coreNs) => coreNs === ns || coreNs.startsWith(ns + "."))) {
      issues.push({
        severity: "warning",
        category: "namespace",
        message: `Brain references namespace "${ns}" (key: ${key}) not found in Core source`,
        brainValue: ns,
      });
    }
  }

  // Check for Core namespaces Brain doesn't know about
  for (const coreNs of snapshot.namespaces) {
    if (coreNs.startsWith("Strada.Core") && !brainNamespaces.has(coreNs)) {
      // Only warn about top-level namespaces, not deep sub-namespaces
      const depth = coreNs.split(".").length;
      if (depth <= 4) {
        issues.push({
          severity: "info",
          category: "namespace",
          message: `Core namespace "${coreNs}" not tracked in STRADA_API`,
          coreValue: coreNs,
        });
      }
    }
  }
}

function validateBaseClasses(snapshot: CoreAPISnapshot, issues: DriftIssue[]): void {
  const brainSystems = new Set(STRADA_API.baseClasses.systems);

  // Check each Brain base class exists in Core
  for (const baseName of brainSystems) {
    const found = snapshot.classes.some(
      (cls) => cls.name === baseName && cls.isAbstract,
    );
    if (!found) {
      issues.push({
        severity: "error",
        category: "base_class",
        message: `Brain references system base class "${baseName}" not found in Core`,
        brainValue: baseName,
      });
    }
  }

  // Check for Core abstract classes Brain doesn't know about
  const coreAbstractSystemBases = snapshot.classes.filter(
    (cls) =>
      cls.isAbstract &&
      (cls.name.endsWith("SystemBase") || cls.name.startsWith("BurstSystem") || cls.name === "SystemBase"),
  );
  for (const cls of coreAbstractSystemBases) {
    if (!brainSystems.has(cls.name)) {
      issues.push({
        severity: "warning",
        category: "base_class",
        message: `Core has abstract system class "${cls.name}" not listed in Brain's base classes`,
        coreValue: cls.name,
      });
    }
  }

  // Check pattern base classes
  {
    const brainPatterns = new Set<string>(STRADA_API.baseClasses.patterns);
    for (const patternName of brainPatterns) {
      // Strip generic args for lookup
      const cleanName = patternName.replace(/<.*>/, "");
      const found = snapshot.classes.some((cls) => cls.name === cleanName);
      if (!found) {
        issues.push({
          severity: "warning",
          category: "pattern_class",
          message: `Brain references pattern class "${patternName}" not found in Core`,
          brainValue: patternName,
        });
      }
    }
  }
}

function validateAttributes(snapshot: CoreAPISnapshot, issues: DriftIssue[]): void {
  // Extract known attribute names from STRADA_API
  const brainAttributes = new Map<string, string>();
  for (const [key, val] of Object.entries(STRADA_API.systemAttributes)) {
    // Extract attribute class name from "[AttrName(args)]" format
    const match = /^\[(\w+)/.exec(val);
    if (match) {
      brainAttributes.set(key, match[1]!);
    }
  }

  // Check each Brain attribute exists somewhere in Core source
  for (const [key, attrName] of brainAttributes) {
    const foundAsClass = snapshot.classes.some(
      (cls) => cls.name === attrName || cls.name === attrName + "Attribute",
    );
    const foundInAttrs = Array.from(snapshot.attributes.values()).some((attrs) =>
      attrs.some((a) => a === attrName || a === attrName + "Attribute"),
    );

    if (!foundAsClass && !foundInAttrs) {
      issues.push({
        severity: "error",
        category: "attribute",
        message: `Brain references attribute [${attrName}] (key: ${key}) not found in Core`,
        brainValue: `[${attrName}]`,
      });
    }
  }
}

function validateInterfaces(snapshot: CoreAPISnapshot, issues: DriftIssue[]): void {
  // Validate key interfaces Brain uses
  const keyInterfaces = ["IComponent", "IPoolable", "ITickable", "ILoopRunner"];

  for (const ifaceName of keyInterfaces) {
    const found = snapshot.interfaces.some((i) => i.name === ifaceName);
    if (!found) {
      // Info-level: interface might be in a sub-namespace we didn't parse
      issues.push({
        severity: "info",
        category: "interface",
        message: `Expected interface "${ifaceName}" not found in Core snapshot`,
        brainValue: ifaceName,
      });
    }
  }
}

// ─── Report Formatting ─────────────────────────────────────────────────────

/**
 * Format a DriftReport as a human-readable string.
 */
export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [
    "Strada.Core Drift Validation Report",
    "\u2501".repeat(40),
    "",
    `Drift Score: ${report.driftScore}/100 (${report.driftScore <= 10 ? "GOOD" : report.driftScore <= 30 ? "MODERATE" : "HIGH"})`,
    `Total Issues: ${report.totalIssues}`,
    `  Errors: ${report.errors.length}`,
    `  Warnings: ${report.warnings.length}`,
    `  Info: ${report.infos.length}`,
    "",
  ];

  if (report.errors.length > 0) {
    lines.push("ERRORS:");
    for (const issue of report.errors) {
      lines.push(`  [${issue.category}] ${issue.message}`);
    }
    lines.push("");
  }

  if (report.warnings.length > 0) {
    lines.push("WARNINGS:");
    for (const issue of report.warnings) {
      lines.push(`  [${issue.category}] ${issue.message}`);
    }
    lines.push("");
  }

  if (report.infos.length > 0) {
    lines.push("INFO:");
    for (const issue of report.infos.slice(0, 10)) {
      lines.push(`  [${issue.category}] ${issue.message}`);
    }
    if (report.infos.length > 10) {
      lines.push(`  ... and ${report.infos.length - 10} more`);
    }
  }

  lines.push("");
  lines.push(`Validated at: ${report.validatedAt.toISOString()}`);

  return lines.join("\n");
}
