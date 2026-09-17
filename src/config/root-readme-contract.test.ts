import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig } from "./config.js";
import { workspaceSkillsDir } from "../skills/skill-loader.js";

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
