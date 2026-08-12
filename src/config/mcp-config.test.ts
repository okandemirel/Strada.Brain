/**
 * MCP server configuration loading.
 *
 * Strada's config is otherwise environment-only, which cannot express a list of
 * servers each with its own command, args and credentials — so this list is
 * file-backed. These tests exist because a feature nobody can configure is
 * indistinguishable from one that was never built.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function loadWith(fileContents?: string) {
  const path = join(dir, "mcp.json");
  if (fileContents !== undefined) writeFileSync(path, fileContents, "utf8");
  // An env override bypasses the config cache, so each case is independent.
  return loadConfig({ ...process.env, MCP_CONFIG_PATH: path }).mcpServers;
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
