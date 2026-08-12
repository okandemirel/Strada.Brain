/**
 * MCP client tests.
 *
 * These run against a real MCP server in a real child process
 * (tests/fixtures/mcp/probe-server.mjs), not a mock of the SDK. The whole point
 * of this module is that it speaks JSON-RPC over stdio to a foreign binary, so
 * mocking the transport would test the mock and leave every protocol mistake
 * in place.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import { connectMcpServer, connectMcpServers, namespacedToolName } from "./mcp-client.js";
import type { ToolContext } from "../agents/tools/tool.interface.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const FIXTURE = resolve(import.meta.dirname, "..", "..", "tests", "fixtures", "mcp", "probe-server.mjs");

const CONTEXT: ToolContext = {
  projectPath: "/tmp",
  workingDirectory: "/tmp",
  readOnly: false,
};

function serverConfig(name = "probe") {
  return { name, command: process.execPath, args: [FIXTURE], startupTimeoutMs: 20_000 };
}

describe("namespacedToolName", () => {
  it("namespaces per server so two servers cannot shadow each other", () => {
    expect(namespacedToolName("files", "search")).toBe("mcp__files__search");
    expect(namespacedToolName("git", "search")).not.toBe(namespacedToolName("files", "search"));
  });

  it("produces a name providers will accept as a function name", () => {
    // Providers reject function names outside [a-zA-Z0-9_-], so a server named
    // with a path or an @scope must not produce an unusable tool.
    expect(namespacedToolName("@scope/my server", "do.thing")).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("connectMcpServer", () => {
  it("discovers the server's tools over the protocol", async () => {
    const conn = await connectMcpServer(serverConfig());
    try {
      expect(conn.tools.map((t) => t.name).sort()).toEqual([
        "mcp__probe__boom",
        "mcp__probe__echo",
        "mcp__probe__image_only",
        "mcp__probe__report_env",
      ]);
      const echo = conn.tools.find((t) => t.name.endsWith("__echo"))!;
      expect(echo.description).toBe("Echoes its input");
      expect(echo.inputSchema).toMatchObject({ type: "object" });
    } finally {
      await conn.close();
    }
  }, 30_000);

  it("calls a tool and returns its text", async () => {
    const conn = await connectMcpServer(serverConfig());
    try {
      const echo = conn.tools.find((t) => t.name.endsWith("__echo"))!;
      const result = await echo.execute({ text: "hello" }, CONTEXT);
      expect(result.content).toBe("echo: hello");
      expect(result.isError).toBeUndefined();
    } finally {
      await conn.close();
    }
  }, 30_000);

  it("does not hand the parent's secrets to the server process", async () => {
    // An MCP server is a third-party binary. Spawning it with the full
    // process.env would give it every API key the agent holds — the same leak
    // already fixed for shell_exec, which is why that allowlist is reused here.
    process.env["CANARY_MCP_SECRET"] = "must-not-leak";
    try {
      const conn = await connectMcpServer(serverConfig());
      try {
        const report = conn.tools.find((t) => t.name.endsWith("__report_env"))!;
        expect((await report.execute({}, CONTEXT)).content).toBe("clean");
      } finally {
        await conn.close();
      }
    } finally {
      delete process.env["CANARY_MCP_SECRET"];
    }
  }, 30_000);

  it("passes a server's own configured env through", async () => {
    // The allowlist blocks inheritance, not explicit configuration — a server
    // that needs a credential must still be able to receive one.
    const conn = await connectMcpServer({ ...serverConfig(), env: { CANARY_EXPLICIT: "yes" } });
    try {
      const report = conn.tools.find((t) => t.name.endsWith("__report_env"))!;
      expect((await report.execute({}, CONTEXT)).content).toBe("LEAKED:CANARY_EXPLICIT");
    } finally {
      await conn.close();
    }
  }, 30_000);

  it("surfaces a tool-level failure as an error result", async () => {
    // MCP reports tool failure inside the payload, not as a transport error.
    // Reading only the transport would score this call a success.
    const conn = await connectMcpServer(serverConfig());
    try {
      const boom = conn.tools.find((t) => t.name.endsWith("__boom"))!;
      const result = await boom.execute({}, CONTEXT);
      expect(result.isError).toBe(true);
      expect(result.content).toBe("deliberate failure");
    } finally {
      await conn.close();
    }
  }, 30_000);

  it("summarises non-text content instead of returning nothing", async () => {
    const conn = await connectMcpServer(serverConfig());
    try {
      const img = conn.tools.find((t) => t.name.endsWith("__image_only"))!;
      expect((await img.execute({}, CONTEXT)).content).toBe("[image image/png]");
    } finally {
      await conn.close();
    }
  }, 30_000);

  it("fails rather than hanging when the server never starts", async () => {
    await expect(
      connectMcpServer({
        name: "missing",
        command: "definitely-not-a-real-binary-xyz",
        args: [],
        startupTimeoutMs: 5_000,
      }),
    ).rejects.toThrow();
  }, 30_000);
});

describe("connectMcpServers", () => {
  it("keeps the working servers when one is unreachable", async () => {
    // A typo in one server's command should cost that server's tools, not the
    // whole session.
    const connections = await connectMcpServers([
      serverConfig("good"),
      { name: "broken", command: "definitely-not-a-real-binary-xyz", args: [], startupTimeoutMs: 5_000 },
    ]);
    try {
      expect(connections.map((c) => c.serverName)).toEqual(["good"]);
      expect(connections[0]!.tools.length).toBeGreaterThan(0);
    } finally {
      for (const c of connections) await c.close();
    }
  }, 30_000);
});
