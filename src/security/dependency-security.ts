/**
 * Dependency Security for Strata.Brain
 * 
 * Provides:
 * - npm audit integration
 * - Snyk compatibility
 * - Vulnerability scanning
 * - License compliance checking
 * - Dependency update recommendations
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../utils/logger.js";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface Vulnerability {
  id: string;
  name: string;
  severity: "info" | "low" | "moderate" | "high" | "critical";
  title: string;
  description: string;
  moduleName: string;
  vulnerableVersions: string;
  patchedVersions?: string;
  recommendation: string;
  cves?: string[];
  cwes?: string[];
  findindPaths?: string[];
  dependencyOf?: string;
}

export interface AuditReport {
  auditReportVersion: number;
  vulnerabilities: Record<string, Vulnerability>;
  metadata: {
    vulnerabilities: {
      info: number;
      low: number;
      moderate: number;
      high: number;
      critical: number;
    };
    dependencies: {
      prod: number;
      dev: number;
      optional: number;
      peer: number;
      peerOptional: number;
      total: number;
    };
  };
  runId: string;
  runDate: string;
}

export interface DependencyInfo {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  license: string;
  licenses?: string[];
  repository?: string;
  homepage?: string;
  author?: string;
  deprecated?: boolean;
  outdated?: boolean;
  latestVersion?: string;
}

export interface LicenseCompliance {
  allowed: string[];
  restricted: string[];
  forbidden: string[];
}

export interface DependencyUpdate {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  location: string;
  type: "dependencies" | "devDependencies" | "peerDependencies";
  changelogUrl?: string;
}

export interface SecurityCheckResult {
  passed: boolean;
  vulnerabilities: {
    total: number;
    bySeverity: Record<string, number>;
    list: Vulnerability[];
  };
  outdated: DependencyUpdate[];
  licenseIssues: Array<{
    package: string;
    license: string;
    issue: string;
  }>;
  recommendations: string[];
}

// =============================================================================
// KNOWN VULNERABILITY DATABASE (Simplified)
// =============================================================================

interface KnownVulnerability {
  id: string;
  affected: string[]; // Package name patterns
  vulnerableVersions: string; // semver range
  patchedVersions: string;
  severity: Vulnerability["severity"];
  description: string;
  cve?: string;
}

// Common vulnerable packages to watch for
const KNOWN_VULNERABILITIES: KnownVulnerability[] = [
  {
    id: "SNYK-JS-LODASH-567890",
    affected: ["lodash", "lodash-es"],
    vulnerableVersions: "<4.17.21",
    patchedVersions: ">=4.17.21",
    severity: "high",
    description: "Prototype Pollution in lodash",
    cve: "CVE-2021-23337",
  },
  {
    id: "SNYK-JS-AXIOS-1038255",
    affected: ["axios"],
    vulnerableVersions: "<0.21.1",
    patchedVersions: ">=0.21.1",
    severity: "high",
    description: "Server-Side Request Forgery in axios",
    cve: "CVE-2020-28168",
  },
  {
    id: "SNYK-JS-EXPRESS-6474509",
    affected: ["express"],
    vulnerableVersions: "<4.17.3",
    patchedVersions: ">=4.17.3",
    severity: "moderate",
    description: "Open redirect in express",
    cve: "CVE-2022-24999",
  },
];

// =============================================================================
// DEPENDENCY SECURITY SCANNER
// =============================================================================

export class DependencySecurityScanner {
  private readonly projectPath: string;
  private readonly logger = getLogger();
  private readonly licenseCompliance: LicenseCompliance;

  constructor(
    projectPath: string,
    licenseCompliance?: Partial<LicenseCompliance>
  ) {
    this.projectPath = projectPath;
    this.licenseCompliance = {
      allowed: ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"],
      restricted: ["GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0"],
      forbidden: ["UNLICENSED", "PROPRIETARY", "Commercial"],
      ...licenseCompliance,
    };
  }

  /**
   * Run npm audit
   */
  async runNpmAudit(): Promise<AuditReport> {
    try {
      const output = execSync("npm audit --json", {
        cwd: this.projectPath,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024, // 50MB
      });

      return JSON.parse(output) as AuditReport;
    } catch (error) {
      // npm audit exits with non-zero code when vulnerabilities found
      if (error instanceof Error && "stdout" in error) {
        try {
          return JSON.parse(String(error.stdout)) as AuditReport;
        } catch {
          // Fall through to throw
        }
      }
      throw new Error(`npm audit failed: ${error}`);
    }
  }

  /**
   * Check for known vulnerabilities in dependencies
   */
  async checkKnownVulnerabilities(): Promise<Vulnerability[]> {
    const packageJsonPath = join(this.projectPath, "package.json");

    if (!existsSync(packageJsonPath)) {
      throw new Error("package.json not found");
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    const vulnerabilities: Vulnerability[] = [];

    for (const [name, version] of Object.entries(allDeps)) {
      const depVersion = String(version).replace(/^\^|^~/, "");

      for (const knownVuln of KNOWN_VULNERABILITIES) {
        if (knownVuln.affected.includes(name)) {
          // Simple version check (in production use semver)
          if (this.isVersionVulnerable(depVersion, knownVuln.vulnerableVersions)) {
            vulnerabilities.push({
              id: knownVuln.id,
              name: knownVuln.id,
              severity: knownVuln.severity,
              title: knownVuln.description,
              description: knownVuln.description,
              moduleName: name,
              vulnerableVersions: knownVuln.vulnerableVersions,
              patchedVersions: knownVuln.patchedVersions,
              recommendation: `Upgrade ${name} to ${knownVuln.patchedVersions}`,
              cves: knownVuln.cve ? [knownVuln.cve] : undefined,
              findindPaths: [`${name}@${depVersion}`],
            });
          }
        }
      }
    }

    return vulnerabilities;
  }

  /**
   * Check for outdated dependencies
   */
  async checkOutdated(): Promise<DependencyUpdate[]> {
    try {
      const output = execSync("npm outdated --json", {
        cwd: this.projectPath,
        encoding: "utf8",
      });

      const outdated = JSON.parse(output || "{}") as Record<string, {
        current: string;
        wanted: string;
        latest: string;
        dependent: string;
        location: string;
      }>;

      return Object.entries(outdated).map(([name, info]) => ({
        name,
        current: info.current,
        wanted: info.wanted,
        latest: info.latest,
        location: info.location,
        type: this.getDependencyType(name),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Check license compliance
   */
  async checkLicenses(): Promise<Array<{ package: string; license: string; issue: string }>> {
    const issues: Array<{ package: string; license: string; issue: string }> = [];

    try {
      const output = execSync("npm ls --json --long", {
        cwd: this.projectPath,
        encoding: "utf8",
      });

      const tree = JSON.parse(output);
      this.extractLicenses(tree, issues);
    } catch (error) {
      this.logger.warn("License check encountered issues", { error });
    }

    return issues;
  }

  /**
   * Run comprehensive security check
   */
  async runSecurityCheck(): Promise<SecurityCheckResult> {
    this.logger.info("Starting dependency security check...");

    let auditReport: AuditReport | null = null;
    const vulnerabilities: Vulnerability[] = [];
    let outdated: DependencyUpdate[] = [];
    let licenseIssues: Array<{ package: string; license: string; issue: string }> = [];
    const recommendations: string[] = [];

    // Run npm audit
    try {
      auditReport = await this.runNpmAudit();
      vulnerabilities.push(...Object.values(auditReport.vulnerabilities));
    } catch (error) {
      this.logger.error("npm audit failed", { error });
      recommendations.push("Run 'npm audit' manually to check for vulnerabilities");
    }

    // Check known vulnerabilities
    try {
      const knownVulns = await this.checkKnownVulnerabilities();
      vulnerabilities.push(...knownVulns);
    } catch (error) {
      this.logger.error("Known vulnerability check failed", { error });
    }

    // Check outdated packages
    try {
      outdated = await this.checkOutdated();
      if (outdated.length > 0) {
        recommendations.push(`Update ${outdated.length} outdated dependencies`);
      }
    } catch (error) {
      this.logger.warn("Outdated check failed", { error });
    }

    // Check licenses
    try {
      licenseIssues = await this.checkLicenses();
      if (licenseIssues.length > 0) {
        recommendations.push(`Review ${licenseIssues.length} license compliance issues`);
      }
    } catch (error) {
      this.logger.warn("License check failed", { error });
    }

    // Count by severity
    const bySeverity: Record<string, number> = {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    };

    for (const vuln of vulnerabilities) {
      bySeverity[vuln.severity] = (bySeverity[vuln.severity] || 0) + 1;
    }

    // Add recommendations based on findings
    if ((bySeverity.critical ?? 0) > 0) {
      recommendations.unshift(`URGENT: Fix ${bySeverity.critical} critical vulnerabilities immediately`);
    }
    if ((bySeverity.high ?? 0) > 0) {
      recommendations.unshift(`HIGH PRIORITY: Address ${bySeverity.high} high severity vulnerabilities`);
    }

    const passed = bySeverity.critical === 0 && bySeverity.high === 0;

    this.logger.info("Dependency security check complete", {
      passed,
      vulnerabilities: vulnerabilities.length,
      outdated: outdated.length,
      licenseIssues: licenseIssues.length,
    });

    return {
      passed,
      vulnerabilities: {
        total: vulnerabilities.length,
        bySeverity,
        list: vulnerabilities,
      },
      outdated,
      licenseIssues,
      recommendations,
    };
  }

  /**
   * Generate security report
   */
  generateReport(result: SecurityCheckResult): string {
    const lines: string[] = [];
    
    lines.push("# Dependency Security Report");
    lines.push("");
    lines.push(`**Status:** ${result.passed ? "✅ PASSED" : "❌ FAILED"}`);
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push("");

    lines.push("## Vulnerabilities");
    lines.push("");
    lines.push(`**Total:** ${result.vulnerabilities.total}`);
    lines.push("");
    lines.push("| Severity | Count |");
    lines.push("|----------|-------|");
    for (const [severity, count] of Object.entries(result.vulnerabilities.bySeverity)) {
      lines.push(`| ${severity} | ${count} |`);
    }
    lines.push("");

    if (result.vulnerabilities.list.length > 0) {
      lines.push("### Details");
      lines.push("");
      for (const vuln of result.vulnerabilities.list.slice(0, 10)) {
        lines.push(`- **${vuln.name}** (${vuln.severity})`);
        lines.push(`  - Package: ${vuln.moduleName}`);
        lines.push(`  - Recommendation: ${vuln.recommendation}`);
      }
      if (result.vulnerabilities.list.length > 10) {
        lines.push(`- ... and ${result.vulnerabilities.list.length - 10} more`);
      }
      lines.push("");
    }

    lines.push("## Outdated Dependencies");
    lines.push("");
    lines.push(`**Total:** ${result.outdated.length}`);
    lines.push("");
    if (result.outdated.length > 0) {
      lines.push("| Package | Current | Latest |");
      lines.push("|---------|---------|--------|");
      for (const dep of result.outdated.slice(0, 10)) {
        lines.push(`| ${dep.name} | ${dep.current} | ${dep.latest} |`);
      }
      lines.push("");
    }

    lines.push("## Recommendations");
    lines.push("");
    for (const rec of result.recommendations) {
      lines.push(`- ${rec}`);
    }

    return lines.join("\n");
  }

  /**
   * Fix vulnerabilities automatically
   */
  async fixVulnerabilities(): Promise<{
    fixed: number;
    remaining: number;
    errors: string[];
  }> {
    const errors: string[] = [];

    try {
      execSync("npm audit fix", {
        cwd: this.projectPath,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      errors.push(String(error));
    }

    // Check remaining vulnerabilities
    const check = await this.runSecurityCheck();

    return {
      fixed: 0, // Would need before/after comparison
      remaining: check.vulnerabilities.total,
      errors,
    };
  }

  private isVersionVulnerable(version: string, vulnerableRange: string): boolean {
    // Simplified version check - in production use semver package
    const match = vulnerableRange.match(/^<(.+)$/);
    if (match?.[1]) {
      const maxVersion = match[1];
      return this.compareVersions(version, maxVersion) < 0;
    }
    return false;
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split(".").map(Number);
    const parts2 = v2.split(".").map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 < p2) return -1;
      if (p1 > p2) return 1;
    }

    return 0;
  }

  private getDependencyType(name: string): DependencyUpdate["type"] {
    const packageJsonPath = join(this.projectPath, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

    if (packageJson.dependencies?.[name]) return "dependencies";
    if (packageJson.devDependencies?.[name]) return "devDependencies";
    if (packageJson.peerDependencies?.[name]) return "peerDependencies";
    return "dependencies";
  }

  private extractLicenses(
    node: Record<string, unknown>,
    issues: Array<{ package: string; license: string; issue: string }>
  ): void {
    if (node.license || node.licenses) {
      const pkg = node.name as string;
      const license = String(node.license || node.licenses);

      if (this.licenseCompliance.forbidden.includes(license)) {
        issues.push({ package: pkg, license, issue: "Forbidden license" });
      } else if (this.licenseCompliance.restricted.includes(license)) {
        issues.push({ package: pkg, license, issue: "Restricted license - review required" });
      }
    }

    if (node.dependencies) {
      for (const dep of Object.values(node.dependencies as Record<string, unknown>)) {
        this.extractLicenses(dep as Record<string, unknown>, issues);
      }
    }
  }
}

// =============================================================================
// SNYK INTEGRATION
// =============================================================================

export class SnykIntegration {
  private readonly apiToken?: string;
  private readonly logger = getLogger();

  constructor(apiToken?: string, _organization?: string) {
    this.apiToken = apiToken;
  }

  /**
   * Run Snyk test
   */
  async runTest(projectPath: string): Promise<{
    vulnerabilities: Vulnerability[];
    summary: { high: number; medium: number; low: number };
  }> {
    if (!this.apiToken) {
      throw new Error("Snyk API token not configured");
    }

    try {
      const output = execSync("snyk test --json", {
        cwd: projectPath,
        encoding: "utf8",
        env: {
          ...process.env,
          SNYK_TOKEN: this.apiToken,
        },
      });

      const result = JSON.parse(output);
      
      return {
        vulnerabilities: result.vulnerabilities || [],
        summary: {
          high: result.summary?.high || 0,
          medium: result.summary?.medium || 0,
          low: result.summary?.low || 0,
        },
      };
    } catch (error) {
      this.logger.error("Snyk test failed", { error });
      throw error;
    }
  }

  /**
   * Monitor project with Snyk
   */
  async monitor(projectPath: string): Promise<{ id: string; url: string }> {
    if (!this.apiToken) {
      throw new Error("Snyk API token not configured");
    }

    const output = execSync("snyk monitor --json", {
      cwd: projectPath,
      encoding: "utf8",
      env: {
        ...process.env,
        SNYK_TOKEN: this.apiToken,
      },
    });

    const result = JSON.parse(output);
    return { id: result.id, url: result.uri };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export const dependencyScanner = new DependencySecurityScanner(process.cwd());
