/**
 * Framework Drift Validator
 *
 * Compares two FrameworkAPISnapshot instances (previous vs current) to detect
 * API changes. Generalizes the existing strada-drift-validator.ts to work
 * with any Strada package.
 */

import type {
  FrameworkAPISnapshot,
  FrameworkDriftReport,
  FrameworkPackageId,
  DriftIssue,
  DriftChangeSummary,
} from "./framework-types.js";

/**
 * Validate drift between two snapshots of the same package.
 * If `previous` is null, this is the first sync — no drift to report.
 */
export function validateFrameworkDrift(
  packageId: FrameworkPackageId,
  current: FrameworkAPISnapshot,
  previous: FrameworkAPISnapshot | null,
): FrameworkDriftReport {
  if (!previous) {
    return {
      packageId,
      totalIssues: 0,
      errors: [],
      warnings: [],
      infos: [],
      driftScore: 0,
      validatedAt: new Date(),
      previousVersion: null,
      currentVersion: current.version,
      changelog: buildChangelog(null, current),
    };
  }

  const issues: DriftIssue[] = [];

  validateNamespaceDrift(previous, current, issues);
  validateClassDrift(previous, current, issues);
  validateInterfaceDrift(previous, current, issues);

  if (current.sourceLanguage === "csharp") {
    validateAttributeDrift(previous, current, issues);
  }

  if (packageId === "mcp") {
    validateToolDrift(previous, current, issues);
    validateResourceDrift(previous, current, issues);
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");

  const rawScore = errors.length * 10 + warnings.length * 3 + infos.length;

  return {
    packageId,
    totalIssues: issues.length,
    errors,
    warnings,
    infos,
    driftScore: Math.min(100, rawScore),
    validatedAt: new Date(),
    previousVersion: previous.version,
    currentVersion: current.version,
    changelog: buildChangelog(previous, current),
  };
}

/**
 * Format a drift report into a human-readable multi-line string.
 */
export function formatFrameworkDriftReport(report: FrameworkDriftReport): string {
  const label =
    report.driftScore <= 10
      ? "GOOD"
      : report.driftScore <= 30
        ? "MODERATE"
        : "HIGH";

  const lines: string[] = [
    `Framework Drift Report: ${report.packageId}`,
    "\u2501".repeat(40),
    "",
    `Version: ${report.previousVersion ?? "none"} \u2192 ${report.currentVersion ?? "unknown"}`,
    `Drift Score: ${report.driftScore}/100 (${label})`,
    `Total Issues: ${report.totalIssues} (${report.errors.length}E / ${report.warnings.length}W / ${report.infos.length}I)`,
  ];

  if (report.changelog.addedClasses.length > 0) {
    lines.push("", `Added classes: ${report.changelog.addedClasses.join(", ")}`);
  }
  if (report.changelog.removedClasses.length > 0) {
    lines.push(`Removed classes: ${report.changelog.removedClasses.join(", ")}`);
  }

  if (report.errors.length > 0) {
    lines.push("", "ERRORS:");
    for (const issue of report.errors) {
      lines.push(`  [${issue.category}] ${issue.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "WARNINGS:");
    for (const issue of report.warnings) {
      lines.push(`  [${issue.category}] ${issue.message}`);
    }
  }

  return lines.join("\n");
}

// ─── Validation Rules ───────────────────────────────────────────────────────

function validateNamespaceDrift(
  prev: FrameworkAPISnapshot,
  curr: FrameworkAPISnapshot,
  issues: DriftIssue[],
): void {
  const prevSet = new Set(prev.namespaces);
  const currSet = new Set(curr.namespaces);

  for (const ns of prevSet) {
    if (!currSet.has(ns)) {
      issues.push({
        severity: "warning",
        category: "namespace",
        message: `Namespace "${ns}" was removed`,
        sourceValue: ns,
      });
    }
  }
  for (const ns of currSet) {
    if (!prevSet.has(ns)) {
      issues.push({
        severity: "info",
        category: "namespace",
        message: `Namespace "${ns}" was added`,
        sourceValue: ns,
      });
    }
  }
}

function validateClassDrift(
  prev: FrameworkAPISnapshot,
  curr: FrameworkAPISnapshot,
  issues: DriftIssue[],
): void {
  const prevNames = new Set(prev.classes.map((c) => c.name));
  const currNames = new Set(curr.classes.map((c) => c.name));

  for (const name of prevNames) {
    if (!currNames.has(name)) {
      issues.push({
        severity: "error",
        category: "class",
        message: `Class "${name}" was removed (breaking change)`,
        brainValue: name,
      });
    }
  }
  for (const name of currNames) {
    if (!prevNames.has(name)) {
      issues.push({
        severity: "info",
        category: "class",
        message: `Class "${name}" was added`,
        sourceValue: name,
      });
    }
  }
}

function validateInterfaceDrift(
  prev: FrameworkAPISnapshot,
  curr: FrameworkAPISnapshot,
  issues: DriftIssue[],
): void {
  const prevNames = new Set(prev.interfaces.map((i) => i.name));
  const currNames = new Set(curr.interfaces.map((i) => i.name));

  for (const name of prevNames) {
    if (!currNames.has(name)) {
      issues.push({
        severity: "error",
        category: "interface",
        message: `Interface "${name}" was removed (breaking change)`,
        brainValue: name,
      });
    }
  }
  for (const name of currNames) {
    if (!prevNames.has(name)) {
      issues.push({
        severity: "info",
        category: "interface",
        message: `Interface "${name}" was added`,
        sourceValue: name,
      });
    }
  }
}

function validateAttributeDrift(
  prev: FrameworkAPISnapshot,
  curr: FrameworkAPISnapshot,
  issues: DriftIssue[],
): void {
  const prevKeys = new Set([...prev.attributes.keys()]);
  const currKeys = new Set([...curr.attributes.keys()]);

  for (const key of prevKeys) {
    if (!currKeys.has(key)) {
      issues.push({
        severity: "warning",
        category: "attribute",
        message: `Attribute target "${key}" removed`,
        brainValue: key,
      });
    }
  }
}

function validateToolDrift(
  prev: FrameworkAPISnapshot,
  curr: FrameworkAPISnapshot,
  issues: DriftIssue[],
): void {
  const prevTools = new Set(prev.tools.map((t) => t.name));
  const currTools = new Set(curr.tools.map((t) => t.name));

  for (const name of prevTools) {
    if (!currTools.has(name)) {
      issues.push({
        severity: "error",
        category: "mcp_tool",
        message: `MCP tool "${name}" was removed`,
        brainValue: name,
      });
    }
  }
  for (const name of currTools) {
    if (!prevTools.has(name)) {
      issues.push({
        severity: "info",
        category: "mcp_tool",
        message: `MCP tool "${name}" was added`,
        sourceValue: name,
      });
    }
  }
}

function validateResourceDrift(
  prev: FrameworkAPISnapshot,
  curr: FrameworkAPISnapshot,
  issues: DriftIssue[],
): void {
  const prevRes = new Set(prev.resources.map((r) => r.name));
  const currRes = new Set(curr.resources.map((r) => r.name));

  for (const name of prevRes) {
    if (!currRes.has(name)) {
      issues.push({
        severity: "warning",
        category: "mcp_resource",
        message: `MCP resource "${name}" was removed`,
        brainValue: name,
      });
    }
  }
}

// ─── Changelog Builder ──────────────────────────────────────────────────────

function buildChangelog(
  prev: FrameworkAPISnapshot | null,
  curr: FrameworkAPISnapshot,
): DriftChangeSummary {
  if (!prev) {
    return {
      addedNamespaces: [...curr.namespaces],
      removedNamespaces: [],
      addedClasses: curr.classes.map((c) => c.name),
      removedClasses: [],
      addedInterfaces: curr.interfaces.map((i) => i.name),
      removedInterfaces: [],
    };
  }

  const prevNs = new Set(prev.namespaces);
  const currNs = new Set(curr.namespaces);
  const prevCls = new Set(prev.classes.map((c) => c.name));
  const currCls = new Set(curr.classes.map((c) => c.name));
  const prevIface = new Set(prev.interfaces.map((i) => i.name));
  const currIface = new Set(curr.interfaces.map((i) => i.name));

  return {
    addedNamespaces: [...currNs].filter((n) => !prevNs.has(n)),
    removedNamespaces: [...prevNs].filter((n) => !currNs.has(n)),
    addedClasses: [...currCls].filter((c) => !prevCls.has(c)),
    removedClasses: [...prevCls].filter((c) => !currCls.has(c)),
    addedInterfaces: [...currIface].filter((i) => !prevIface.has(i)),
    removedInterfaces: [...prevIface].filter((i) => !currIface.has(i)),
  };
}
