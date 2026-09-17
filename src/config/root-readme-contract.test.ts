import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig } from "./config.js";
import { workspaceSkillsDir } from "../skills/skill-loader.js";
import {
  SUPPORTED_PROJECT_LAYOUT,
  SUPPORTED_PROJECT_PACKAGES,
  SUPPORTED_UNITY_VERSIONS,
} from "./strada-deps.js";

/**
 * The root README documents two things the code contradicted (R4 / D69 and
 * 10.1c, plan 0-A.31): where workspace skills are scanned from, and the
 * default of STRADA_DAEMON_DAILY_BUDGET. Both rows are read from the real
 * README and compared with the real code, so neither can drift again
 * without a test naming the row.
 */
const readme = readFileSync(join(import.meta.dirname, "..", "..", "README.md"), "utf8");
const tableRow = (marker: string): string => {
  const line = readme.split("\n").find((l) => l.startsWith("|") && l.includes(marker));
  expect(line, `README table row containing ${marker}`).toBeDefined();
  return line as string;
};

describe("README.md matches the code it documents", () => {
  it("workspace skills row names the directory the loader actually scans", () => {
    const row = tableRow("**workspace**");
    const scanned = relative("/proj", workspaceSkillsDir("/proj")); // "skills"
    expect(row).toContain(`\`${scanned}/\` in your project root`);
    expect(row).not.toContain(".strada/skills");
  });

  it("STRADA_DAEMON_DAILY_BUDGET row says the default is unset and shared, matching loadConfig", () => {
    const config = loadConfig({ UNITY_PROJECT_PATH: process.cwd(), ANTHROPIC_API_KEY: "sk-test-key-123" });
    // Code: no dedicated daemon budget unless the env var is set; the daemon
    // then shares the system wallet.
    expect(config.daemon.budget.limitScope).toBe("system");
    expect(config.daemon.budget.dailyBudgetUsd).not.toBe(1);

    const row = tableRow("`STRADA_DAEMON_DAILY_BUDGET`");
    const cells = row.split("|").map((c) => c.trim());
    const defaultCell = cells[2] ?? "";
    expect(defaultCell).toBe("(unset)");
    expect(row).toContain("STRADA_BUDGET_DAILY_USD");
  });
});

/**
 * The supported project matrix (plan 6.10) is data in `strada-deps.ts`; the
 * README table is a rendering of it and `strada doctor` is a checker of it.
 * Before this, the README's title claimed "Unity" with no bound at all while the
 * code only ever wrote Unity 6 serialized shapes — the title promised a surface
 * no row covered. These cases fail if the three drift apart again.
 */
describe("README.md matches the supported project matrix", () => {
  // Line wrapping is not a contract: assertions about sentences run against the
  // whitespace-collapsed document so re-flowing a paragraph cannot fail a test.
  const readmeFlat = readme.replace(/\s+/gu, " ");
  const matrixRow = (label: string): string => {
    const line = readme
      .split("\n")
      .find((l) => l.startsWith("|") && l.includes(`**${label}**`));
    expect(line, `README matrix row for ${label}`).toBeDefined();
    return line as string;
  };

  it("has an honest title: the h1 tagline names Unity 6, not Unity in general", () => {
    const tagline = readme
      .split("\n")
      .find((line) => line.includes("AI-Powered Development Agent"));
    expect(tagline).toBeDefined();
    expect(tagline).toContain("Unity 6");
    // Claims that need Strada.MCP must not read as unconditional.
    expect(readmeFlat).toContain("the live Unity surface (console reads, Unity builds, playthrough verdicts) needs Strada.MCP");
  });

  it("documents the Unity version range and the tested version the code declares", () => {
    const row = matrixRow("Unity Editor version (project)");
    expect(row).toContain(SUPPORTED_UNITY_VERSIONS.minInclusive);
    for (const tested of SUPPORTED_UNITY_VERSIONS.tested) {
      expect(row).toContain(tested);
    }
    expect(row).toContain("required");
  });

  it("documents every required layout path", () => {
    const row = matrixRow("Unity project layout");
    for (const entry of SUPPORTED_PROJECT_LAYOUT) {
      expect(row).toContain(entry);
    }
  });

  it("gives every Strada package a row with the requirement level the code declares", () => {
    for (const spec of SUPPORTED_PROJECT_PACKAGES) {
      const row = matrixRow(spec.label);
      expect(row, `${spec.label} row states its requirement level`).toContain(spec.requirement);
      if (spec.minVersion === null) {
        // Claiming a floor the code does not enforce is the drift this catches.
        expect(row).toContain("no floor");
      } else {
        expect(row).toContain(spec.minVersion);
      }
    }
  });

  it("claims no Unity version below the supported floor", () => {
    expect(readme).not.toMatch(/Unity\s+20\d\d/u);
  });

  it("says the second machine is NOT MEASURED rather than supported", () => {
    expect(readmeFlat).toContain("NOT MEASURED");
    expect(readmeFlat).toContain("another machine satisfies this matrix");
    expect(readmeFlat).toContain("run `strada doctor` on that machine");
  });
});
