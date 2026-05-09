import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "./tool-registry.js";
import type { VaultRegistry } from "../vault/vault-registry.js";
import { createLogger } from "../utils/logger.js";

describe("ToolRegistry vault registration", () => {
  it("registers vault and obsidian tools before initialize resolves", async () => {
    createLogger("error", join(tmpdir(), "strada-tool-registry-vault-test.log"));
    const registry = new ToolRegistry();
    const vaultRegistry = {
      get: vi.fn(),
      list: vi.fn(() => []),
      resolveVaultForPath: vi.fn(),
    } as unknown as VaultRegistry;

    await registry.initialize({} as never, { vaultRegistry });

    expect(registry.has("vault_init")).toBe(true);
    expect(registry.has("vault_sync")).toBe(true);
    expect(registry.has("vault_status")).toBe(true);
    expect(registry.has("vault_search")).toBe(true);
    expect(registry.has("vault_graph_explore")).toBe(true);
    expect(registry.has("vault_write_note")).toBe(true);
    expect(registry.has("obsidian_search")).toBe(true);
    expect(registry.has("obsidian_append")).toBe(true);
  });
});
