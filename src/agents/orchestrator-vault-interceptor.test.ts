/**
 * audited 2026-09-02: the orchestrator's vault-first file_read interceptor
 * called vaultFileRead directly and skipped the two guards FileReadTool
 * applies first — the sec-M3 200-char symbol cap and the sec-H2 "vault must
 * sit inside the session project" containment check. On every vault hit the
 * interceptor answered and the tool never ran, so both guards were dead in
 * production. The interceptor now falls through to the tool in both cases.
 *
 * Real disk: validatePath realpaths the project, and vaultFileRead compares
 * the indexed mtime/size to the file on disk, so the fixtures are real files.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

let root: string;
let projectPath: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "vault-intercept-")));
  projectPath = join(root, "project");
  mkdirSync(join(projectPath, "src"), { recursive: true });
  writeFileSync(join(projectPath, "src", "a.ts"), "export const a = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A vault whose index says src/a.ts (relative to its own root) is fresh. */
function vaultAt(rootPath: string, relPath: string) {
  const st = statSync(join(projectPath, "src", "a.ts"));
  return {
    id: `vault-${relPath.split("/").length}`,
    rootPath,
    listFiles: () => [{ path: relPath, mtimeMs: st.mtimeMs, size: st.size }],
    readFile: vi.fn().mockResolvedValue("export const a = 1;\n"),
    findSymbolsByName: vi.fn().mockResolvedValue([]),
  };
}

function build(vault: ReturnType<typeof vaultAt>) {
  const fileRead = {
    name: "file_read",
    description: "file_read",
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: true },
    execute: vi.fn().mockResolvedValue({ content: "tool-ran" }),
  };
  const orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [fileRead] as never,
    channel: createMockChannel() as never,
    projectPath,
    readOnly: false,
    requireConfirmation: false,
    vaultRegistry: { resolveVaultForPath: () => vault } as never,
  } as never);
  const run = (input: Record<string, unknown>) =>
    (
      orch as unknown as {
        executeToolCalls: (
          chatId: string,
          calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
          options: Record<string, unknown>,
        ) => Promise<Array<{ content: string; isError?: boolean }>>;
      }
    ).executeToolCalls("chat1", [{ id: "tc1", name: "file_read", input }], { mode: "interactive" });
  return { run, fileRead, vault };
}

describe("the vault-first file_read interceptor applies FileReadTool's guards", () => {
  it("control: a vault rooted at the project serves a fresh file without running the tool", async () => {
    const { run, fileRead, vault } = build(vaultAt(projectPath, "src/a.ts"));

    const [result] = await run({ path: "src/a.ts" });

    expect(fileRead.execute).not.toHaveBeenCalled();
    expect(vault.readFile).toHaveBeenCalledTimes(1);
    expect(result?.content).toContain("source=vault:");
  });

  it("sec-H2: a vault rooted ABOVE the project does not answer; the tool runs", async () => {
    const { run, fileRead, vault } = build(vaultAt(root, "project/src/a.ts"));

    const [result] = await run({ path: "src/a.ts" });

    expect(vault.readFile, "served from a vault outside the session project").not.toHaveBeenCalled();
    expect(fileRead.execute).toHaveBeenCalledTimes(1);
    expect(result?.content).toBe("tool-ran");
  });

  it("sec-M3: a symbol over 200 characters never reaches the vault's symbol resolver", async () => {
    const { run, fileRead, vault } = build(vaultAt(projectPath, "src/a.ts"));

    const [result] = await run({ path: "src/a.ts", symbol: "A".repeat(201) });

    expect(vault.findSymbolsByName, "an uncapped symbol reached the resolver").not.toHaveBeenCalled();
    expect(fileRead.execute).toHaveBeenCalledTimes(1);
    expect(result?.content).toBe("tool-ran");
  });

  it("a symbol within the cap is still resolved through the vault", async () => {
    const { run, fileRead, vault } = build(vaultAt(projectPath, "src/a.ts"));

    await run({ path: "src/a.ts", symbol: "a" });

    expect(vault.findSymbolsByName).toHaveBeenCalledTimes(1);
    expect(fileRead.execute).not.toHaveBeenCalled();
  });
});
