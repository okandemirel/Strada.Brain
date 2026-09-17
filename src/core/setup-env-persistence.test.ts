/**
 * Plan 2.1 (audit 10.1b / D24, D29, D30): setup persistence MERGES into the
 * existing .env — hand-added keys and comments survive, wizard-owned keys are
 * replaced in place or removed, defaults never reset a hand-edited value, and
 * the effective file is read back from disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeEffectiveBudget,
  mergeEnvContent,
  parseEnvLines,
  persistSetup,
  redactEffectiveConfig,
} from "./setup-env-persistence.js";

describe("mergeEnvContent", () => {
  const owned = ["UNITY_PROJECT_PATH", "PROVIDER_CHAIN", "KIMI_API_KEY", "DEEPSEEK_API_KEY", "STRADA_BUDGET_DAILY_USD"];
  const defaults = ["LOG_LEVEL"];

  it("replaces owned keys in place, keeps comments and unknown keys, appends the rest", () => {
    const existing = [
      "# header comment",
      "UNITY_PROJECT_PATH=/old",
      "",
      "# hand-added",
      "MY_KEY=keep-me",
      "LOG_LEVEL=debug",
      "",
    ].join("\n");
    const updates = parseEnvLines([
      "# Generated",
      'UNITY_PROJECT_PATH="/new"',
      'PROVIDER_CHAIN="kimi"',
      "LOG_LEVEL=info",
    ]);

    const result = mergeEnvContent(existing, updates, { ownedKeys: owned, defaultKeys: defaults });

    expect(result.content.split("\n")).toEqual([
      "# header comment",
      'UNITY_PROJECT_PATH="/new"',
      "",
      "# hand-added",
      "MY_KEY=keep-me",
      "LOG_LEVEL=debug",
      "",
      "# Added by Strada.Brain Setup Wizard",
      'PROVIDER_CHAIN="kimi"',
      "",
    ]);
    expect(result.replaced).toEqual(["UNITY_PROJECT_PATH"]);
    expect(result.added).toEqual(["PROVIDER_CHAIN"]);
    expect(result.preserved).toEqual(expect.arrayContaining(["MY_KEY", "LOG_LEVEL"]));
  });

  it("removes an owned key the wizard no longer emits, never a foreign one", () => {
    const existing = "DEEPSEEK_API_KEY=sk-stale\nFOREIGN=1\n";
    const result = mergeEnvContent(existing, parseEnvLines(['KIMI_API_KEY="sk-kimi"']), { ownedKeys: owned });
    expect(result.content).not.toContain("DEEPSEEK_API_KEY");
    expect(result.content).toContain("FOREIGN=1");
    expect(result.removed).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it("drops a later duplicate of a rewritten key so the new value is what dotenv reads", () => {
    const existing = "PROVIDER_CHAIN=a\nX=1\nPROVIDER_CHAIN=b\n";
    const result = mergeEnvContent(existing, parseEnvLines(['PROVIDER_CHAIN="kimi"']), { ownedKeys: owned });
    expect(result.content.match(/PROVIDER_CHAIN=/g)).toHaveLength(1);
    expect(result.content).toContain('PROVIDER_CHAIN="kimi"');
  });

  it("moves a multi-line quoted value as one block", () => {
    const existing = 'CERT="line1\nline2"\nUNITY_PROJECT_PATH=/old\n';
    const result = mergeEnvContent(existing, parseEnvLines(['UNITY_PROJECT_PATH="/new"']), { ownedKeys: owned });
    expect(result.content).toBe('CERT="line1\nline2"\nUNITY_PROJECT_PATH="/new"\n');
  });
});

describe("persistSetup", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes generated lines verbatim on a first run and reads the effective map back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-persist-"));
    tmpDirs.push(dir);
    const envPath = path.join(dir, ".env");
    const result = await persistSetup(envPath, ["# Generated", 'KIMI_API_KEY="sk-kimi"', "STRADA_BUDGET_DAILY_USD=0"], { ownedKeys: [] });
    expect(fs.readFileSync(envPath, "utf-8")).toBe('# Generated\nKIMI_API_KEY="sk-kimi"\nSTRADA_BUDGET_DAILY_USD=0\n');
    expect(result.effective).toEqual({ KIMI_API_KEY: "sk-kimi", STRADA_BUDGET_DAILY_USD: "0" });
  });

  it("keeps a hand-added key across a second save (2.1 / D29)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-env-persist-"));
    tmpDirs.push(dir);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "HAND_ADDED=yes\nKIMI_API_KEY=old\n");
    const result = await persistSetup(envPath, ['KIMI_API_KEY="new"'], { ownedKeys: ["KIMI_API_KEY"] });
    expect(result.effective).toEqual({ HAND_ADDED: "yes", KIMI_API_KEY: "new" });
    expect(result.preserved).toEqual(["HAND_ADDED"]);
  });
});

describe("describeEffectiveBudget / redactEffectiveConfig", () => {
  it("shows 0 as zero and only a missing key as unlimited (2.1 / D30)", () => {
    expect(describeEffectiveBudget({ STRADA_BUDGET_DAILY_USD: "0" })).toEqual({ dailyUsd: 0, unlimited: false, display: "$0.00" });
    expect(describeEffectiveBudget({ STRADA_BUDGET_DAILY_USD: "12.5" })).toEqual({ dailyUsd: 12.5, unlimited: false, display: "$12.50" });
    expect(describeEffectiveBudget({})).toEqual({ dailyUsd: null, unlimited: true, display: "unlimited" });
  });

  it("reduces secrets to a presence marker", () => {
    expect(redactEffectiveConfig({ KIMI_API_KEY: "sk-1", ANTHROPIC_AUTH_TOKEN: "t", LOG_LEVEL: "info", EMPTY_API_KEY: "" }))
      .toEqual({ KIMI_API_KEY: "<set>", ANTHROPIC_AUTH_TOKEN: "<set>", LOG_LEVEL: "info", EMPTY_API_KEY: "" });
  });
});
