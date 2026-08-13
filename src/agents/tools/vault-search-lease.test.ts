/**
 * vault_search must find the project's vault while the agent works in a lease.
 *
 * Under a workspace lease the tool context's `projectPath` becomes the lease
 * directory — correct for reads and writes, since that is where the work
 * happens, but wrong for anything keyed to the project's identity. The vault is
 * registered against the real project root, so resolving on `projectPath`
 * missed on every leased task and the search silently downgraded to "query all
 * registered vaults".
 *
 * Measured on a live run: `vault_search` for "MatchResolver ScoreService
 * PixelFlow" returned 10 hits `searched=[unity:5b4164ac, self:strada-brain,
 * knowledge:57dbef1a]` carrying the hint "No vault indexed for projectPath". It
 * found the project's code only because the fallback happened to include the
 * project vault — while spending the token budget on Strada.Brain's own source
 * as well, and telling the operator the project was unindexed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { VaultSearchTool } from "./vault-search-tool.js";
import type { ToolContext } from "./tool-core.interface.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const PROJECT = "/tmp/pixelflow";
const LEASE = "/tmp/strada-workspaces/task-abc";

/** A vault that reports which query it was asked, and owns `root`. */
function fakeVault(id: string, root: string, kind = "unity-project") {
  return {
    id,
    kind,
    rootPath: root,
    listFiles: () => [],
    query: async () => ({
      hits: [
        {
          chunk: {
            id: `${id}-c1`,
            path: `${id}/hit.cs`,
            startLine: 1,
            endLine: 2,
            content: "public class Hit {}",
            lang: "csharp",
          },
          scores: { fts: 1, hnsw: null, rrf: 1 },
        },
      ],
      budgetUsed: 10,
      truncated: false,
    }),
  };
}

function registryWith(vaults: ReturnType<typeof fakeVault>[]) {
  return {
    list: () => vaults,
    get: (id: string) => vaults.find((v) => v.id === id),
    resolveVaultForPath: (p: string) =>
      // Longest-prefix ownership, like the real registry.
      vaults.find((v) => p === v.rootPath || p.startsWith(v.rootPath + "/")),
  };
}

function contextFor(registry: unknown, opts: { leased: boolean }): ToolContext {
  return {
    projectPath: opts.leased ? LEASE : PROJECT,
    ...(opts.leased ? { sourceProjectPath: PROJECT } : {}),
    workingDirectory: opts.leased ? LEASE : PROJECT,
    readOnly: false,
    vaultRegistry: registry,
  } as unknown as ToolContext;
}

async function search(context: ToolContext): Promise<string> {
  const tool = new VaultSearchTool();
  const result = await (
    tool as unknown as {
      execute(input: unknown, ctx: ToolContext): Promise<{ content: string }>;
    }
  ).execute({ query: "MatchResolver" }, context);
  return String(result.content);
}

describe("vault_search under a workspace lease", () => {
  it("resolves the project vault from the real root, not the lease path", async () => {
    const registry = registryWith([
      fakeVault("unity:project", PROJECT),
      fakeVault("self:strada-brain", "/opt/strada-brain", "self"),
    ]);

    const content = await search(contextFor(registry, { leased: true }));

    expect(content).toContain("unity:project");
    // The whole point: Strada.Brain's own source must not be dragged in, and
    // the operator must not be told the project is unindexed.
    expect(content).not.toContain("self:strada-brain");
    expect(content).not.toMatch(/No vault indexed for projectPath/);
  });

  it("behaves the same without a lease", async () => {
    const registry = registryWith([
      fakeVault("unity:project", PROJECT),
      fakeVault("self:strada-brain", "/opt/strada-brain", "self"),
    ]);

    const content = await search(contextFor(registry, { leased: false }));

    expect(content).toContain("unity:project");
    expect(content).not.toContain("self:strada-brain");
  });

  it("still falls back, and says so, when no vault owns the project", async () => {
    // The honest case the hint was written for.
    const registry = registryWith([fakeVault("self:strada-brain", "/opt/strada-brain", "self")]);

    const content = await search(contextFor(registry, { leased: true }));

    expect(content).toMatch(/No vault indexed for projectPath/);
  });
});

describe("the orchestrator supplies the real root", () => {
  it("puts sourceProjectPath in the tool context even under a lease", async () => {
    // Without this the fix above is inert: vault_search would read
    // sourceProjectPath, find nothing, and fall back to projectPath — the lease
    // path — exactly as before. Asserting only on the tool would not catch it.
    const { Orchestrator } = await import("../orchestrator.js");
    const seen: ToolContext[] = [];

    const provider = {
      name: "mock",
      capabilities: {
        maxTokens: 4096,
        streaming: false,
        structuredStreaming: false,
        toolCalling: true,
        vision: false,
        systemPrompt: true,
      },
      chat: async () => ({ content: "", toolCalls: [] }),
      healthCheck: async () => true,
    };

    const orchestrator = new Orchestrator({
      providerManager: {
        getProvider: () => provider,
        getProviderByName: () => provider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        listAvailable: () => [{ name: "mock", label: "mock", defaultModel: "default" }],
        shutdown: () => {},
      } as never,
      tools: [
        {
          name: "probe_tool",
          description: "records its context",
          inputSchema: { type: "object" as const, properties: {} },
          execute: async (_input: unknown, ctx: ToolContext) => {
            seen.push(ctx);
            return { content: "ok", isError: false };
          },
        } as never,
      ],
      channel: { sendMessage: () => {}, type: "cli" } as never,
      projectPath: PROJECT,
      readOnly: false,
      requireConfirmation: false,
    });

    await (
      orchestrator as unknown as {
        executeToolCalls(chatId: string, calls: unknown[], options: unknown): Promise<unknown>;
      }
    ).executeToolCalls("test-chat", [{ id: "c1", name: "probe_tool", input: {} }], {
      mode: "auto",
      workspaceLease: { path: LEASE },
    });

    expect(seen, "the probe tool never ran").toHaveLength(1);
    // projectPath is the lease — that is correct, work happens there.
    expect(seen[0]!.projectPath).toBe(LEASE);
    // …and the real root travels alongside it.
    expect(seen[0]!.sourceProjectPath).toBe(PROJECT);
  });
});
