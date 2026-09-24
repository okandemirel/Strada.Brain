/**
 * CHN-14: two concurrent POST /api/vaults for the same root register one vault
 * (201) and refuse the other (409); the factory builds exactly one.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { handleVaultRoutes, type VaultFactory } from "./server-vault-routes.js";
import { createMockRes, createStreamReq, type MockRes } from "./test-support/mock-http.js";
import { createFakeVault, createTempDirTracker } from "../test-helpers.js";
import { VaultRegistry } from "../vault/vault-registry.js";
import type { RouteContext } from "./server-types.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

const tmp = createTempDirTracker("vault-routes-race-");
afterAll(() => tmp.cleanup());

describe("POST /api/vaults concurrent registration (CHN-14)", () => {
  it("registers one vault and refuses the concurrent duplicate", async () => {
    const registry = new VaultRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const factory: VaultFactory = {
      create: vi.fn(async (spec: { id: string }) => {
        await gate;
        return createFakeVault({ id: spec.id });
      }),
    };
    const ctx = { vaultRegistry: registry, vaultFactory: factory } as unknown as RouteContext;
    const dir = tmp.makeDir();

    const post = (): MockRes & ServerResponse => {
      const res = createMockRes();
      handleVaultRoutes("/api/vaults", "POST", createStreamReq(JSON.stringify({ name: "V", rootPath: dir })), res, ctx);
      return res;
    };
    const first = post();
    const second = post();
    await vi.waitFor(() => expect(second.end).toHaveBeenCalled());
    release();
    await vi.waitFor(() => expect(first.end).toHaveBeenCalled());

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
  });
});
