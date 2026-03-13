import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IdentityStateManager } from "./identity-state.js";

describe("IdentityStateManager", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "identity-test-"));
    dbPath = join(tmpDir, "identity.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first boot generates UUID, sets boot_count=1, first_boot_ts, clean_shutdown=false", () => {
    const manager = new IdentityStateManager(dbPath);
    manager.initialize();
    manager.recordBoot();

    const state = manager.getState();
    expect(state.agentUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(state.bootCount).toBe(1);
    expect(state.firstBootTs).toBeGreaterThan(0);
    expect(state.cleanShutdown).toBe(false);

    manager.close();
  });

  it("second boot preserves UUID, increments boot_count to 2, first_boot_ts unchanged", () => {
    const manager1 = new IdentityStateManager(dbPath);
    manager1.initialize();
    manager1.recordBoot();
    const state1 = manager1.getState();
    manager1.recordShutdown();
    manager1.close();

    const manager2 = new IdentityStateManager(dbPath);
    manager2.initialize();
    manager2.recordBoot();
    const state2 = manager2.getState();

    expect(state2.agentUuid).toBe(state1.agentUuid);
    expect(state2.bootCount).toBe(2);
    expect(state2.firstBootTs).toBe(state1.firstBootTs);

    manager2.close();
  });

  it("updateUptime(1000) then updateUptime(2000) yields cumulative_uptime_ms=3000", () => {
    const manager = new IdentityStateManager(dbPath);
    manager.initialize();
    manager.recordBoot();

    manager.updateUptime(1000);
    manager.updateUptime(2000);

    const state = manager.getState();
    expect(state.cumulativeUptimeMs).toBe(3000);

    manager.close();
  });

  it("recordActivity() updates last_activity_ts to approximately Date.now()", () => {
    const manager = new IdentityStateManager(dbPath);
    manager.initialize();
    manager.recordBoot();

    const before = Date.now();
    manager.recordActivity();
    const after = Date.now();

    const state = manager.getState();
    expect(state.lastActivityTs).toBeGreaterThanOrEqual(before);
    expect(state.lastActivityTs).toBeLessThanOrEqual(after);

    manager.close();
  });

  it("incrementMessages() and incrementTasks() increment their respective counters", () => {
    const manager = new IdentityStateManager(dbPath);
    manager.initialize();
    manager.recordBoot();

    manager.incrementMessages();
    manager.incrementMessages();
    manager.incrementTasks();

    const state = manager.getState();
    expect(state.totalMessages).toBe(2);
    expect(state.totalTasks).toBe(1);

    manager.close();
  });

  it("recordShutdown() sets clean_shutdown=true and flushes uptime", () => {
    const manager = new IdentityStateManager(dbPath);
    manager.initialize();
    manager.recordBoot();
    manager.updateUptime(500);

    manager.recordShutdown();
    const state = manager.getState();
    expect(state.cleanShutdown).toBe(true);
    // Uptime should include at least the 500ms we explicitly added
    expect(state.cumulativeUptimeMs).toBeGreaterThanOrEqual(500);

    manager.close();
  });

  it("all state persists across close+reopen cycle", () => {
    const manager1 = new IdentityStateManager(dbPath);
    manager1.initialize();
    manager1.recordBoot();
    manager1.updateUptime(5000);
    manager1.incrementMessages();
    manager1.incrementMessages();
    manager1.incrementTasks();
    manager1.setProjectContext("/projects/MyGame");
    manager1.recordShutdown();
    const state1 = manager1.getState();
    manager1.close();

    const manager2 = new IdentityStateManager(dbPath);
    manager2.initialize();
    const state2 = manager2.getState();

    expect(state2.agentUuid).toBe(state1.agentUuid);
    expect(state2.firstBootTs).toBe(state1.firstBootTs);
    expect(state2.cumulativeUptimeMs).toBeGreaterThanOrEqual(5000);
    expect(state2.totalMessages).toBe(2);
    expect(state2.totalTasks).toBe(1);
    expect(state2.projectContext).toBe("/projects/MyGame");
    expect(state2.cleanShutdown).toBe(true);

    manager2.close();
  });

  it("agent name defaults to 'Strada Brain', respects constructor agentName param", () => {
    const defaultManager = new IdentityStateManager(dbPath);
    defaultManager.initialize();
    defaultManager.recordBoot();
    expect(defaultManager.getState().agentName).toBe("Strada Brain");
    defaultManager.close();

    // New DB with custom name
    const customDir = mkdtempSync(join(tmpdir(), "identity-custom-"));
    const customPath = join(customDir, "identity.db");
    const customManager = new IdentityStateManager(customPath, "MyBot");
    customManager.initialize();
    customManager.recordBoot();
    expect(customManager.getState().agentName).toBe("MyBot");
    customManager.close();
    rmSync(customDir, { recursive: true, force: true });
  });

  it("wasCrash() returns true when clean_shutdown was false at boot, false when it was true", () => {
    // First boot: simulate crash (no recordShutdown)
    const manager1 = new IdentityStateManager(dbPath);
    manager1.initialize();
    manager1.recordBoot();
    manager1.close(); // close without recordShutdown = crash

    // Second boot: should detect crash
    const manager2 = new IdentityStateManager(dbPath);
    manager2.initialize();
    manager2.recordBoot();
    expect(manager2.wasCrash()).toBe(true);
    manager2.recordShutdown();
    manager2.close();

    // Third boot: clean shutdown happened, should NOT detect crash
    const manager3 = new IdentityStateManager(dbPath);
    manager3.initialize();
    manager3.recordBoot();
    expect(manager3.wasCrash()).toBe(false);
    manager3.close();
  });
});
