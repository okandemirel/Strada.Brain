/**
 * MCP server configuration loading.
 *
 * Strada's config is otherwise environment-only, which cannot express a list of
 * servers each with its own command, args and credentials — so this list is
 * file-backed. These tests exist because a feature nobody can configure is
 * indistinguishable from one that was never built.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The minimum a config must carry to validate at all. Supplied explicitly
 * rather than inherited from process.env: spreading the ambient environment
 * made these tests pass locally, where a .env file happens to define
 * UNITY_PROJECT_PATH, and fail in CI, where it does not — the tests were
 * green for a reason that had nothing to do with what they assert.
 */
function requiredEnv(projectPath: string) {
  // UNITY_PROJECT_PATH is checked against the filesystem, not just parsed, so
  // it has to be a directory that actually exists — the per-test temp dir.
  return { ANTHROPIC_API_KEY: "sk-test-key-123", UNITY_PROJECT_PATH: projectPath };
}

function loadWith(fileContents?: string) {
  const path = join(dir, "mcp.json");
  if (fileContents !== undefined) writeFileSync(path, fileContents, "utf8");
  // An env override bypasses the config cache, so each case is independent.
  return loadConfig({ ...requiredEnv(dir), MCP_CONFIG_PATH: path }).mcpServers;
}

describe("MCP server config", () => {
  it("reads the object form other MCP hosts write", () => {
    // Keyed by server name, so the name comes from the key rather than a field
    // — a config copied from another host must work unedited.
    const servers = loadWith(
      JSON.stringify({ mcpServers: { files: { command: "node", args: ["server.js"] } } }),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "files", command: "node", args: ["server.js"] });
  });

  it("reads a bare array", () => {
    const servers = loadWith(JSON.stringify([{ name: "git", command: "mcp-git" }]));
    expect(servers.map((s) => s.name)).toEqual(["git"]);
  });

  it("applies defaults so a minimal entry is usable", () => {
    const servers = loadWith(JSON.stringify([{ name: "min", command: "x" }]));
    expect(servers[0]).toMatchObject({
      args: [],
      env: {},
      enabled: true,
      startupTimeoutMs: 30_000,
    });
  });

  it("keeps a server's own credentials", () => {
    // The per-server env is the whole point: MCP servers do NOT inherit the
    // parent's environment, so a credential has to be declared here or the
    // server never sees it.
    const servers = loadWith(
      JSON.stringify([{ name: "api", command: "x", env: { API_TOKEN: "t" } }]),
    );
    expect(servers[0]!.env).toEqual({ API_TOKEN: "t" });
  });

  it("ignores a malformed file rather than refusing to start", () => {
    // A typo in an optional integration must cost the user their MCP tools,
    // never their ability to run Strada at all.
    expect(loadWith("{ this is not json")).toEqual([]);
  });

  it("ignores a file with an unrecognised shape", () => {
    expect(loadWith(JSON.stringify({ servers: "wrong key" }))).toEqual([]);
  });

  it("returns nothing when no config file exists", () => {
    expect(loadWith()).toEqual([]);
  });
});

// security-config#4: mcp.json is JSON, so `enabled` arrives as a JSON boolean,
// and the strict env-string parser rejected it — the entry was dropped and the
// server's tools vanished behind a warning that gave no reason. Hosts such as
// Cline and Roo write `"disabled": true` instead; zod stripped the unknown key,
// `enabled` defaulted to true and Strada started a server the user had turned
// off, handing it that entry's credentials.
describe("MCP server on/off flags", () => {
  it("reads a JSON boolean `enabled` rather than dropping the server", () => {
    const servers = loadWith(
      JSON.stringify([
        { name: "on", command: "x", enabled: true },
        { name: "off", command: "y", enabled: false },
        { name: "legacy", command: "z", enabled: "false" },
      ]),
    );
    expect(servers.map((s) => [s.name, s.enabled])).toEqual([
      ["on", true],
      ["off", false],
      ["legacy", false],
    ]);
  });

  it("keeps a server another host marked `disabled: true` off", () => {
    const servers = loadWith(
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", env: { GITHUB_TOKEN: "t" }, disabled: true },
          files: { command: "mcp-files", disabled: false },
          // Contradictory flags resolve to off: a server the user disabled
          // anywhere must not start with its credentials.
          both: { command: "x", enabled: true, disabled: true },
        },
      }),
    );
    expect(servers.map((s) => [s.name, s.enabled])).toEqual([
      ["github", false],
      ["files", true],
      ["both", false],
    ]);
    expect(servers[0]).not.toHaveProperty("disabled");
  });

  it("says why it skipped an entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadWith(JSON.stringify([{ name: "bad", command: "x", enabled: "maybe" }]))).toEqual([]);
      const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toMatch(/"bad".*skipping it/);
      expect(message).toMatch(/enabled: expected a boolean/);
    } finally {
      warn.mockRestore();
    }
  });
});

// FND-19: STRADA_HOME is the app home itself (resolveStradaHome), not the
// parent of a `.strada` directory.
describe("MCP config location", () => {
  const server = JSON.stringify([{ name: "files", command: "mcp-files" }]);

  it("reads mcp.json from the app home that STRADA_HOME names", () => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mcp.json"), server, "utf8");

    const servers = loadConfig({ ...requiredEnv(dir), STRADA_HOME: home }).mcpServers;
    expect(servers.map((s) => s.name)).toEqual(["files"]);
  });

  it("still reads a file left at the old <STRADA_HOME>/.strada location", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".strada"), { recursive: true });
    writeFileSync(join(home, ".strada", "mcp.json"), server, "utf8");

    const servers = loadConfig({ ...requiredEnv(dir), STRADA_HOME: home }).mcpServers;
    expect(servers.map((s) => s.name)).toEqual(["files"]);
  });
});
