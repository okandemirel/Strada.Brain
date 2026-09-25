/**
 * ORC-19 — the dependency install prompts: only a real "yes" from the person
 * who was asked installs anything, and the prompts answer inside the chat lock.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

const deps = vi.hoisted(() => ({
  installStradaDep: vi.fn(),
  checkStradaDeps: vi.fn(),
}));

vi.mock("../config/strada-deps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/strada-deps.js")>()),
  installStradaDep: deps.installStradaDep,
  checkStradaDeps: deps.checkStradaDeps,
}));

const { Orchestrator, isInstallConsent } = await import("./orchestrator.js");

const MISSING: StradaDepsStatus = {
  coreInstalled: false,
  corePath: null,
  modulesInstalled: false,
  modulesPath: null,
  mcpInstalled: false,
  mcpPath: null,
  mcpVersion: null,
  warnings: [],
};

beforeAll(() => {
  createLogger("error", "test.log");
});

beforeEach(() => {
  deps.installStradaDep.mockReset().mockResolvedValue({ kind: "ok" });
  deps.checkStradaDeps.mockReset().mockReturnValue({ ...MISSING, coreInstalled: true, modulesInstalled: true });
});

function build() {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: createMockChannel() as never,
    projectPath: "/tmp/deps-setup-test",
    readOnly: false,
    requireConfirmation: false,
    stradaDeps: MISSING,
  });
}

const say = (orch: InstanceType<typeof Orchestrator>, text: string, userId = "alice", chatId = "chat-1") =>
  orch.handleMessage({ channelType: "cli", chatId, userId, text, timestamp: new Date() });

describe("isInstallConsent (ORC-19)", () => {
  it("accepts a reply that starts with the answer word", () => {
    for (const reply of ["yes", "Yes!", "evet", "Evet, kur", "kur", "  yes please"]) {
      expect(isInstallConsent(reply), reply).toBe(true);
    }
  });

  it("does not read a word that merely contains it as consent", () => {
    for (const reply of ["I did this yesterday", "yesterday", "eyes", "okur", "kurşun", "kurmayın", "hayır", "no"]) {
      expect(isInstallConsent(reply), reply).toBe(false);
    }
  });
});

describe("dependency install prompt (ORC-19)", () => {
  it("'yesterday' does not install", async () => {
    const orch = build();
    await say(orch, "hello");
    await say(orch, "I did this yesterday already");

    expect(deps.installStradaDep).not.toHaveBeenCalled();
  });

  it("a real yes from the person who was asked installs", async () => {
    const orch = build();
    await say(orch, "hello");
    await say(orch, "yes");

    expect(deps.installStradaDep).toHaveBeenCalledWith("/tmp/deps-setup-test", "core", undefined);
  });

  it("another member of the chat cannot answer the prompt someone else was shown", async () => {
    const orch = build();
    await say(orch, "hello", "alice");
    await say(orch, "yes", "mallory");

    expect(deps.installStradaDep).not.toHaveBeenCalled();
  });

  it("a message sent during the install waits for it instead of answering again", async () => {
    const orch = build();
    await say(orch, "hello");
    const releases: Array<() => void> = [];
    deps.installStradaDep.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve({ kind: "ok" }))),
    );

    const first = say(orch, "yes");
    const second = say(orch, "yes, and then add a player controller");
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    // Before, the prompts ran outside the chat lock: the second message was
    // read as another answer to the same prompt and started a second install.
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const release of releases) release();
    await Promise.all([first, second]);

    expect(deps.installStradaDep).toHaveBeenCalledTimes(1);
  });
});
