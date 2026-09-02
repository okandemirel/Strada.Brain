import { describe, expect, it, vi } from "vitest";
import { MessageRouter } from "./message-router.js";

/**
 * Measured 2026-09-02 19:23: with MULTI_AGENT_ENABLED the CLI channel is
 * wired to the multi-agent handler, which never called the router, so
 * "kampanya devam" became an ordinary task. preRoute is the shared front
 * every inbound path must run first.
 */
describe("MessageRouter.preRoute", () => {
  function routerWith(campaignHandled: boolean) {
    const router = Object.create(MessageRouter.prototype) as MessageRouter;
    const tryHandleIncoming = vi.fn(async () => campaignHandled);
    (router as unknown as { campaignManager: unknown }).campaignManager = { tryHandleIncoming };
    const route = vi.fn(async () => {});
    (router as unknown as { route: unknown }).route = route;
    return { router, tryHandleIncoming, route };
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

  it("lets an ordinary message fall through", async () => {
    const { router, route } = routerWith(false);
    const consumed = await router.preRoute({ chatId: "c", text: "implement the board", channelType: "cli", userId: "u" } as never);
    expect(consumed).toBe(false);
    expect(route).not.toHaveBeenCalled();
  });
});
