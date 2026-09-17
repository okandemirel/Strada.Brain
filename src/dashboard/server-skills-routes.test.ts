import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSkillsRoutes } from "./server-skills-routes.js";
import type { RouteContext } from "./server-types.js";

const { setSkillEnabledMock } = vi.hoisted(() => ({ setSkillEnabledMock: vi.fn() }));
vi.mock("../skills/skill-config.js", () => ({ setSkillEnabled: setSkillEnabledMock }));

function makeRes() {
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse & { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  const body = () => JSON.parse(String(res.end.mock.calls[0]![0])) as Record<string, unknown>;
  const status = () => res.writeHead.mock.calls[0]![0] as number;
  return { res, body, status };
}
const req = {} as IncomingMessage;
const liveEntries = [{ manifest: { name: "unity-build", version: "1.0.0", description: "" }, status: "active", tier: "bundled", path: "/x" }];
const ctx = { skillManager: { getEntries: () => liveEntries } } as unknown as RouteContext;

describe("skills routes enable/disable (R3 / D36)", () => {
  beforeEach(() => { setSkillEnabledMock.mockReset().mockResolvedValue(undefined); });

  it("answers a disable with appliesOnRestart while GET still lists the live (active) entry", async () => {
    const d = makeRes();
    expect(handleSkillsRoutes("/api/skills/unity-build/disable", "POST", req, d.res, ctx)).toBe(true);
    await vi.waitFor(() => expect(d.res.end).toHaveBeenCalled());
    expect(setSkillEnabledMock).toHaveBeenCalledWith("unity-build", false);
    expect(d.status()).toBe(200);
    expect(d.body()).toMatchObject({ success: true, appliesOnRestart: true });
    expect(String(d.body().message)).toContain("restart");

    // The running manager was not touched: the list still says active. That
    // is exactly why the reply has to carry appliesOnRestart.
    const g = makeRes();
    handleSkillsRoutes("/api/skills", "GET", req, g.res, ctx);
    expect((g.body().skills as Array<{ status: string }>)[0]!.status).toBe("active");
  });

  it("answers an enable with appliesOnRestart too", async () => {
    const e = makeRes();
    expect(handleSkillsRoutes("/api/skills/unity-build/enable", "POST", req, e.res, ctx)).toBe(true);
    await vi.waitFor(() => expect(e.res.end).toHaveBeenCalled());
    expect(setSkillEnabledMock).toHaveBeenCalledWith("unity-build", true);
    expect(e.body()).toMatchObject({ success: true, appliesOnRestart: true });
  });

  it("rejects an invalid skill name with 400 and no config write (guard)", () => {
    const d = makeRes();
    expect(handleSkillsRoutes("/api/skills/..%2Fetc/disable", "POST", req, d.res, ctx)).toBe(true);
    expect(d.status()).toBe(400);
    expect(setSkillEnabledMock).not.toHaveBeenCalled();
  });
});
