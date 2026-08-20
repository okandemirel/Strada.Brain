import { describe, it, expect, vi } from "vitest";
import { VaultSyncTool } from "./vault-sync-tool.js";
import type { VaultRegistry } from "../../vault/vault-registry.js";

// =============================================================================
// TESTS — tool registration metadata
// =============================================================================

describe("VaultSyncTool — registration metadata", () => {
  function makeRegistry(overrides: Partial<VaultRegistry> = {}): VaultRegistry {
    return { get: vi.fn(() => undefined), resolve: vi.fn(() => undefined), ids: vi.fn(() => []), ...overrides } as unknown as VaultRegistry;
  }

  it("has name 'vault_sync'", () => {
    const tool = new VaultSyncTool(makeRegistry());
    expect(tool.name).toBe("vault_sync");
  });

  it("has a non-empty description", () => {
    const tool = new VaultSyncTool(makeRegistry());
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("inputSchema type is 'object'", () => {
    const tool = new VaultSyncTool(makeRegistry());
    expect(tool.inputSchema.type).toBe("object");
  });

  it("inputSchema.properties includes 'vaultId'", () => {
    const tool = new VaultSyncTool(makeRegistry());
    expect(tool.inputSchema.properties).toHaveProperty("vaultId");
  });

  it("inputSchema requires 'vaultId'", () => {
    const tool = new VaultSyncTool(makeRegistry());
    expect(tool.inputSchema.required).toContain("vaultId");
  });
});

// =============================================================================
// TESTS — execute()
// =============================================================================

describe("VaultSyncTool — execute()", () => {
  function makeRegistry(vault: unknown): VaultRegistry {
    return { get: vi.fn(() => vault), resolve: vi.fn(() => vault), ids: vi.fn(() => ((vault as { id?: string })?.id ? [(vault as { id: string }).id] : [])) } as unknown as VaultRegistry;
  }

  it("returns isError:true when vaultId is missing from input", async () => {
    const tool = new VaultSyncTool(makeRegistry(undefined));
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("vaultId");
  });

  it("returns isError:true when the vault is not found in the registry", async () => {
    const tool = new VaultSyncTool(makeRegistry(undefined));
    const result = await tool.execute({ vaultId: "unknown-vault" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("calls vault.sync() and returns a success message with changed count and duration", async () => {
    const vault = {
      sync: vi.fn().mockResolvedValue({ changed: 3, durationMs: 42 }),
    };
    const registry = { get: vi.fn(() => vault), resolve: vi.fn(() => vault), ids: vi.fn(() => ((vault as { id?: string })?.id ? [(vault as { id: string }).id] : [])) } as unknown as VaultRegistry;
    const tool = new VaultSyncTool(registry);
    const result = await tool.execute({ vaultId: "my-vault" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("my-vault");
    expect(result.content).toContain("3");
    expect(result.content).toContain("42");
  });

  it("passes the vaultId to the registry resolver", async () => {
    const vault = {
      sync: vi.fn().mockResolvedValue({ changed: 0, durationMs: 5 }),
    };
    const resolve = vi.fn(() => vault);
    const registry = { resolve, ids: vi.fn(() => []) } as unknown as VaultRegistry;
    const tool = new VaultSyncTool(registry);
    await tool.execute({ vaultId: "specific-id" });
    expect(resolve).toHaveBeenCalledWith("specific-id");
  });

  it("returns isError:true when vaultId is undefined (coerced from input)", async () => {
    const tool = new VaultSyncTool(makeRegistry(undefined));
    // vaultId key present but value is undefined
    const result = await tool.execute({ vaultId: undefined });
    expect(result.isError).toBe(true);
  });
});
