/**
 * CHN-21: the built-in dashboard page works once a dashboard token is set —
 * every /api/ call goes through one helper that sends the bearer token, asks
 * for it once on a 401, and keeps it for the tab.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const SCRIPT = readFileSync(new URL("./dashboard.js", import.meta.url), "utf-8");

type FetchInit = { headers?: Record<string, string>; method?: string };

function loadPage(prompt: () => string | null) {
  const store = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    // The page's own first refresh() never settles, so it touches no DOM here.
    fetch: () => new Promise(() => undefined),
    setInterval: () => 0,
    setTimeout,
    document: {},
    console,
    prompt: vi.fn(prompt),
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  };
  runInNewContext(SCRIPT, sandbox);
  const server = vi.fn(async (_path: string, init?: FetchInit) => ({
    status: init?.headers?.["Authorization"] === "Bearer right-token" ? 200 : 401,
  }));
  sandbox["fetch"] = server;
  const apiFetch = sandbox["apiFetch"] as ((path: string, init?: FetchInit) => Promise<{ status: number }>) | undefined;
  return { sandbox, server, store, apiFetch };
}

describe("dashboard page API calls with a dashboard token (CHN-21)", () => {
  it("routes every /api/ call through the token-aware helper", () => {
    expect(SCRIPT.match(/[^i]fetch\('\/api\//g)).toBeNull();
  });

  it("asks for the token once on a 401, retries with it, and reuses it", async () => {
    const { sandbox, server, store, apiFetch } = loadPage(() => "right-token");
    expect(typeof apiFetch).toBe("function");

    expect((await apiFetch!("/api/metrics")).status).toBe(200);
    expect(sandbox["prompt"]).toHaveBeenCalledTimes(1);
    expect(store.get("strada-dashboard-token")).toBe("right-token");

    server.mockClear();
    expect((await apiFetch!("/api/daemon")).status).toBe(200);
    expect(server).toHaveBeenCalledTimes(1);
    expect(server.mock.calls[0]![1]?.headers?.["Authorization"]).toBe("Bearer right-token");
    expect(sandbox["prompt"]).toHaveBeenCalledTimes(1);
  });

  it("stops asking once the user declines", async () => {
    const { sandbox, apiFetch } = loadPage(() => null);
    expect((await apiFetch!("/api/metrics")).status).toBe(401);
    expect((await apiFetch!("/api/metrics")).status).toBe(401);
    expect(sandbox["prompt"]).toHaveBeenCalledTimes(1);
  });
});
