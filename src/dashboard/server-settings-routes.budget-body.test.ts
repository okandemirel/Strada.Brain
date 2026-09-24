/**
 * CHN-18: POST /api/budget/config validates the whole body before anything is
 * stored — a body with one valid and one invalid field changes nothing.
 */
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSettingsRoutes } from "./server-settings-routes.js";
import { BudgetConfigStore } from "../budget/budget-config-store.js";
import type { RouteContext } from "./server-types.js";

function post(body: Record<string, unknown>) {
  const values = new Map<string, string>();
  const store = new BudgetConfigStore({
    getBudgetConfig: (key) => values.get(key),
    setBudgetConfig: (key, value) => { values.set(key, value); },
    getAllBudgetConfig: () => Object.fromEntries(values),
  }, {});
  const ctx = {
    unifiedBudgetManager: {
      updateConfig: (partial: Parameters<BudgetConfigStore["updateConfig"]>[0]) => store.updateConfig(partial),
      getConfig: () => store.getConfig(),
    },
    readJsonBody: vi.fn(async () => body),
  } as unknown as RouteContext;
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(data?: string) { out.body = data ?? ""; },
  } as unknown as ServerResponse;
  handleSettingsRoutes("/api/budget/config", "POST", {} as IncomingMessage, res, ctx);
  return { out, values };
}

describe("POST /api/budget/config (CHN-18)", () => {
  it("stores nothing when any field is invalid", async () => {
    const { out, values } = post({ dailyLimitUsd: 5, monthlyLimitUsd: "abc" });
    await vi.waitFor(() => expect(out.status).not.toBe(0));
    expect(out.status).toBe(400);
    expect(out.body).toContain("monthlyLimitUsd");
    expect(values.size).toBe(0);
  });

  it("refuses a non-numeric warnPct the store's range check let through", async () => {
    const { out, values } = post({ warnPct: "abc" });
    await vi.waitFor(() => expect(out.status).not.toBe(0));
    expect(out.status).toBe(400);
    expect(values.size).toBe(0);
  });

  it("stores a fully valid body", async () => {
    const { out, values } = post({ dailyLimitUsd: 5, monthlyLimitUsd: -1, subLimits: { verificationPct: 0.2 } });
    await vi.waitFor(() => expect(out.status).not.toBe(0));
    expect(out.status).toBe(200);
    expect(values.get("dailyLimitUsd")).toBe("5");
    expect(values.get("monthlyLimitUsd")).toBe("-1");
    expect(values.get("subLimits.verificationPct")).toBe("0.2");
  });
});
