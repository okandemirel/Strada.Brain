/**
 * Agent Core v2 — CapabilityRegistry app bindings + seeding tests (Phase 3b wiring step 1).
 * Pure-function coverage of capabilityForTool (tool→substrate) and seedCapabilities (the trap-free
 * initial-status seeding from boot-time health signals).
 */

import { describe, it, expect } from "vitest";
import { FakeClock } from "./clock.js";
import { CapabilityRegistry } from "./capability-registry.js";
import {
  capabilityForTool,
  seedCapabilities,
  CAPABILITY_IN_PROCESS,
  CAPABILITY_MCP_STRADA,
  CAPABILITY_DOTNET,
  CAPABILITY_NETWORK,
} from "./capability-bindings.js";

describe("capabilityForTool — tool → substrate binding", () => {
  it("requiresBridge → mcp:strada (regardless of category)", () => {
    expect(capabilityForTool({ requiresBridge: true })).toBe(CAPABILITY_MCP_STRADA);
    expect(capabilityForTool({ requiresBridge: true, category: "FILE" })).toBe(CAPABILITY_MCP_STRADA);
  });

  it("DOTNET → dotnet-cli; BROWSER → network (case-insensitive)", () => {
    expect(capabilityForTool({ category: "DOTNET" })).toBe(CAPABILITY_DOTNET);
    expect(capabilityForTool({ category: "dotnet" })).toBe(CAPABILITY_DOTNET);
    expect(capabilityForTool({ category: "BROWSER" })).toBe(CAPABILITY_NETWORK);
  });

  it("everything else (file/search/git/unknown/absent) → in-process", () => {
    expect(capabilityForTool({ category: "FILE" })).toBe(CAPABILITY_IN_PROCESS);
    expect(capabilityForTool({ category: "SEARCH" })).toBe(CAPABILITY_IN_PROCESS);
    expect(capabilityForTool({ category: "GIT" })).toBe(CAPABILITY_IN_PROCESS);
    expect(capabilityForTool({})).toBe(CAPABILITY_IN_PROCESS);
    expect(capabilityForTool(undefined)).toBe(CAPABILITY_IN_PROCESS);
  });
});

describe("seedCapabilities — trap-free initial seeding", () => {
  function mk() {
    return new CapabilityRegistry(new FakeClock(0));
  }

  it("in-process and network always seed live (network has no probe → must never be withheld)", () => {
    const reg = mk();
    seedCapabilities(reg, {}); // no signals
    expect(reg.isLive(CAPABILITY_IN_PROCESS)).toBe(true);
    expect(reg.isLive(CAPABILITY_NETWORK)).toBe(true);
    expect(reg.advertisement(CAPABILITY_NETWORK)).toEqual({ advertise: true, warn: false });
  });

  it("mcp:strada seeds live when the bridge is connected, unknown when not", () => {
    const connected = mk();
    seedCapabilities(connected, { mcpConnected: true });
    expect(connected.isLive(CAPABILITY_MCP_STRADA)).toBe(true);

    const offline = mk();
    seedCapabilities(offline, { mcpConnected: false });
    expect(offline.effectiveStatus(CAPABILITY_MCP_STRADA)).toBe("unknown"); // withheld but revivable
    expect(offline.advertisement(CAPABILITY_MCP_STRADA)).toEqual({ advertise: false, warn: false });
  });

  it("mcp:strada is NEVER seeded down (down is the escalated-failure state, not at-rest disconnected)", () => {
    const reg = mk();
    seedCapabilities(reg, { mcpConnected: false });
    expect(reg.getState(CAPABILITY_MCP_STRADA)?.status).toBe("unknown");
    expect(reg.canAttempt(CAPABILITY_MCP_STRADA)).toBe(true); // unknown is attemptable (revive-eligible), down is not
  });

  it("dotnet-cli seeds live optimistically (absence is handled by the existing ToolMetadata.available gate)", () => {
    const reg = mk();
    seedCapabilities(reg, {});
    expect(reg.isLive(CAPABILITY_DOTNET)).toBe(true);
  });
});
