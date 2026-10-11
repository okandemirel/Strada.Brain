import { beforeAll, describe, expect, it, vi } from "vitest";
import { MessageRouter } from "./message-router.js";
import { createLogger } from "../utils/logger.js";

/**
 * Measured 2026-09-02 19:23: with MULTI_AGENT_ENABLED the CLI channel is
 * wired to the multi-agent handler, which never called the router, so
 * "kampanya devam" became an ordinary task. preRoute is the shared front
 * every inbound path must run first.
 */
describe("MessageRouter.preRoute", () => {
  beforeAll(() => {
    createLogger("error", "/tmp/strada-message-router-preroute-test.log");
  });

  function routerWith(campaignHandled: boolean, recovered = false) {
    const router = Object.create(MessageRouter.prototype) as MessageRouter;
    const tryHandleIncoming = vi.fn(async () => campaignHandled);
    (router as unknown as { campaignManager: unknown }).campaignManager = { tryHandleIncoming };
    const tryHandleImplicitRecovery = vi.fn(async () => recovered);
    (router as unknown as { commandHandler: unknown }).commandHandler = { tryHandleImplicitRecovery };
    const route = vi.fn(async () => {});
    (router as unknown as { route: unknown }).route = route;
    return { router, tryHandleIncoming, tryHandleImplicitRecovery, route };
  }

  it("consumes a campaign revive so it never becomes a task", async () => {
    const { router, tryHandleIncoming } = routerWith(true);
    const consumed = await router.preRoute({ chatId: "cli-local", text: "kampanya devam", channelType: "cli", userId: "u" } as never);
    expect(consumed).toBe(true);
    expect(tryHandleIncoming).toHaveBeenCalledTimes(1);
  });

  it("routes slash commands through the router", async () => {
    const { router, route } = routerWith(false);
    const consumed = await router.preRoute({ chatId: "c", text: "/status", channelType: "cli", userId: "u" } as never);
    expect(consumed).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("resumes a pending checkpoint on a recovery intent instead of letting it become a task", async () => {
    // The multi-agent handler calls only preRoute: "tekrar dene" after a
    // budget stop was never probed and became a new ordinary task there.
    const { router, tryHandleImplicitRecovery, route } = routerWith(false, true);
    const consumed = await router.preRoute({ chatId: "c", text: "tekrar dene", channelType: "cli", userId: "u" } as never);
    expect(consumed).toBe(true);
    expect(tryHandleImplicitRecovery).toHaveBeenCalledWith("c", "tekrar dene", "u");
    expect(route).not.toHaveBeenCalled();
  });

  it("lets an ordinary message fall through", async () => {
    const { router, route } = routerWith(false);
    const consumed = await router.preRoute({ chatId: "c", text: "implement the board", channelType: "cli", userId: "u" } as never);
    expect(consumed).toBe(false);
    expect(route).not.toHaveBeenCalled();
  });
});
