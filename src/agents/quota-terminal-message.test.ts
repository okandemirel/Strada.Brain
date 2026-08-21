/**
 * What a run says when the quota runs out.
 *
 * Measured 2026-08-21: a run ended on Kimi's 403 — "You've reached your usage
 * limit for this billing cycle. Your quota will be refreshed in the next
 * cycle." — and told the user "the AI provider is not responding. Please try
 * again later or switch to a different provider." The provider had responded,
 * precisely, and the advice was wrong. Everything else in the system already
 * knew: QUOTA_LIMIT_RE, recordQuotaExhausted, a long cooldown in the fallback
 * chain. The only place it was not known was the sentence a person reads.
 */

import { describe, expect, it } from "vitest";

import { getResilienceMessage } from "./resilience-messages.js";
import { isFailedTerminalKey } from "./autonomy/terminal-outcome.js";
import { readFileSync } from "node:fs";

import { isQuotaStop } from "./orchestrator-runtime-utils.js";

const KIMI = "You've reached your usage limit for this billing cycle.";

describe("the quota notice", () => {
  it("names the provider and repeats what it said", () => {
    const msg = getResilienceMessage("provider_quota", "en", { provider: "Kimi", detail: KIMI });

    expect(msg).toContain("Kimi");
    expect(msg).toContain("usage limit for this billing cycle");
  });

  it("says the work was not at fault", () => {
    const msg = getResilienceMessage("provider_quota", "en", { provider: "Kimi", detail: KIMI });

    expect(msg).toContain("not a failure of the work");
    // And what actually helps, which "try again later" did not.
    expect(msg).toContain("PROVIDER_CHAIN");
  });

  it("exists in Turkish too, not only English", () => {
    const msg = getResilienceMessage("provider_quota", "tr", { provider: "Kimi", detail: KIMI });

    expect(msg).toContain("kotası kalmadı");
    expect(msg).toContain("PROVIDER_CHAIN");
  });

  it("still counts as a run that did not finish", () => {
    // Not the agent's failure, but reporting success would hide an unfinished run.
    expect(isFailedTerminalKey("provider_quota")).toBe(true);
  });

  it("recognises a quota stop, and only a quota stop", () => {
    expect(isQuotaStop([{ status: "down", lastError: KIMI }])).toBe(true);
    // A provider that is down for another reason is not a quota stop.
    expect(isQuotaStop([{ status: "down", lastError: "connection reset" }])).toBe(false);
    // Nor is a healthy provider whose last error happened to mention a limit.
    expect(isQuotaStop([{ status: "healthy", lastError: KIMI }])).toBe(false);
    expect(isQuotaStop([])).toBe(false);
  });

  it("is what a failed terminal actually consults", () => {
    // The decision above is proved; without this, routing the terminal back to
    // provider_abort would restore the wrong sentence and fail nothing.
    const source = readFileSync("src/agents/orchestrator.ts", "utf8");
    const line = source.split("\n").find((l) => l.includes('status === "failed"') && l.includes("return"));

    expect(line, "the failed terminal no longer chooses a message").toBeDefined();
    expect(line, "a quota stop is reported as a provider that did not respond").toContain("provider_quota");
  });
});
