/**
 * COR-11 — the setup wizard answers only for Host names it can vouch for.
 *
 * `GET /api/setup/csrf` hands its token to any same-origin caller, and the
 * token is all the write routes check. Binding 127.0.0.1 keeps other machines
 * out, not a page whose own hostname resolves here; that page's requests still
 * carry its hostname in Host, so the wizard refuses them before any route.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./setup-wizard.js";

function send(port: number, method: string, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host, "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

describe("SetupWizard Host validation (COR-11)", () => {
  let wizard: SetupWizard | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await wizard?.shutdown();
    wizard = null;
  });

  async function start(allowedHosts: readonly string[] = []): Promise<number> {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    wizard = new SetupWizard({ port: 0, allowedHosts });
    await wizard.listen();
    return (wizard as unknown as { server: { address: () => { port: number } } }).server.address().port;
  }

  it("refuses the CSRF token and the save route for a foreign Host", async () => {
    const port = await start();

    const csrf = await send(port, "GET", "/api/setup/csrf", `evil.example:${port}`);
    expect(csrf.status).toBe(403);
    expect(csrf.body).not.toContain("token");

    expect((await send(port, "POST", "/api/setup", `evil.example:${port}`)).status).toBe(403);
    expect((await send(port, "GET", "/api/setup/status", `evil.example:${port}`)).status).toBe(403);
  });

  it("still serves the local browser", async () => {
    const port = await start();

    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const csrf = await send(port, "GET", "/api/setup/csrf", host);
      expect(csrf.status).toBe(200);
      expect(JSON.parse(csrf.body)).toHaveProperty("token");
    }
  });

  it("serves an operator-configured host", async () => {
    const port = await start(["setup.example"]);
    expect((await send(port, "GET", "/api/setup/csrf", "setup.example")).status).toBe(200);
  });
});
