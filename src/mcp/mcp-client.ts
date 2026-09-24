/**
 * MCP (Model Context Protocol) client.
 *
 * Connects to external MCP servers over stdio and exposes their tools to the
 * agent as ordinary ITools, so a user can plug in any MCP server — filesystem,
 * git, a database, their own — without Strada shipping code for it.
 *
 * Note this is distinct from strada-mcp-tool-loader.ts, which imports Strada's
 * own tool module directly in-process. That is not the MCP protocol; it is a
 * local module import that happens to share the name. This file speaks the
 * actual JSON-RPC protocol to a separate process.
 *
 * SECURITY: an MCP server is an arbitrary executable that Strada starts. There
 * is no sandbox and none is implied — the server runs with the privileges of
 * the Strada process. What IS constrained is the environment it inherits:
 * spawning with the full process.env would hand every API key in the parent to
 * a third-party binary, which is exactly the leak already fixed for shell_exec,
 * so the same default-deny allowlist is applied here. Only configure servers
 * you would be willing to run yourself.
 */

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../agents/tools/tool.interface.js";
import { buildShellEnv } from "../agents/tools/shell-env-policy.js";
import { getLogger } from "../utils/logger.js";

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

export interface McpServerConfig {
  /** Identifier used to namespace this server's tools. */
  readonly name: string;
  /** Executable to run. */
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * Extra environment for the server, merged over the default-deny allowlist.
   * This is where a server's own credentials go — explicitly, per server,
   * rather than by inheriting everything the parent happens to hold.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds to wait for connect + tool discovery. */
  readonly startupTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/**
 * Tool names are namespaced per server.
 *
 * Two servers exposing `search` would otherwise collide in the registry, and
 * whichever loaded second would silently shadow the first — the agent would
 * call one server believing it called the other. The separator is a double
 * underscore because it cannot appear in the middle of a normal identifier by
 * accident, and the whole name must still match the `^[a-zA-Z0-9_-]+$` that
 * providers accept for function names.
 */
export function namespacedToolName(server: string, tool: string): string {
  const name = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  // Providers also cap function names at 64 characters, and one tool over
  // it made EVERY request that carried the tool list fail with a 400. Keep
  // what fits and make the cut unique with a hash of the full name.
  return name.length <= MAX_TOOL_NAME_LENGTH ? name : withNameHash(name, server, tool);
}

/**
 * The namespaced names for one server's tools, unique within the server.
 * Sanitizing maps `a.b` and `a_b` to the same name; the second registration
 * then failed and that tool silently disappeared. A clash gets a hash suffix.
 */
export function namespacedToolNames(server: string, tools: readonly string[]): string[] {
  const used = new Set<string>();
  return tools.map((tool) => {
    let name = namespacedToolName(server, tool);
    if (used.has(name)) name = withNameHash(name, server, tool);
    used.add(name);
    return name;
  });
}

/** Providers reject function names longer than this (OpenAI, Anthropic). */
const MAX_TOOL_NAME_LENGTH = 64;

function withNameHash(name: string, server: string, tool: string): string {
  const suffix = `_${createHash("sha256").update(`${server}\u0000${tool}`).digest("hex").slice(0, 8)}`;
  return name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
}

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** An MCP server's tool, adapted to Strada's ITool contract. */
class McpTool implements ITool {
  readonly isPlugin = true;

  constructor(
    readonly name: string,
    readonly description: string,
    readonly inputSchema: Record<string, unknown>,
    private readonly remoteName: string,
    private readonly client: Client,
    private readonly serverName: string,
  ) {}

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    try {
      const result = await this.client.callTool({ name: this.remoteName, arguments: input });
      return {
        content: renderContent(result.content),
        // The protocol reports tool-level failure in the payload, not as a
        // transport error, so an isError result must not be read as success.
        ...(result.isError ? { isError: true } : {}),
        metadata: { executionTimeMs: Date.now() - startedAt },
      };
    } catch (err) {
      // A dead server must degrade to a tool error the agent can read and work
      // around, never an exception that unwinds the whole turn.
      getLoggerSafe().warn("[MCP] tool call failed", {
        server: this.serverName,
        tool: this.remoteName,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        content: `MCP tool ${this.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        metadata: { executionTimeMs: Date.now() - startedAt },
      };
    }
  }
}

/**
 * Flattens MCP's content blocks into the single string ITool returns.
 *
 * Non-text blocks (images, embedded resources) are summarised rather than
 * dropped silently: a tool that returned only an image would otherwise look
 * like it returned nothing at all.
 */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content ?? "");
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block) {
      const b = block as { type: string; text?: string; mimeType?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else parts.push(`[${b.type}${b.mimeType ? ` ${b.mimeType}` : ""}]`);
    }
  }
  return parts.join("\n");
}

export interface McpConnection {
  readonly serverName: string;
  readonly tools: readonly ITool[];
  close(): Promise<void>;
}

/**
 * Starts one MCP server and returns its tools.
 *
 * Throws if the server cannot be reached — the caller decides whether one bad
 * server should stop startup (connectMcpServers says no).
 */
export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const { env: baseEnv, withheld } = buildShellEnv(process.env);
  if (withheld.length > 0) {
    getLoggerSafe().debug("[MCP] withheld parent environment from server", {
      server: config.name,
      withheldCount: withheld.length,
    });
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    env: { ...baseEnv, ...(config.env ?? {}) },
  });

  const client = new Client({ name: "strada-brain", version: "1.0.0" }, { capabilities: {} });

  const timeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`MCP server "${config.name}" did not start within ${timeoutMs}ms`)),
      timeoutMs,
    ).unref?.();
  });

  try {
    // A server that never completes the handshake would otherwise hang startup
    // forever, so connect and discovery are both raced against the deadline.
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);

    const names = namespacedToolNames(config.name, listed.tools.map((t) => t.name));
    const tools = listed.tools.map(
      (t, i) =>
        new McpTool(
          names[i]!,
          t.description ?? `MCP tool ${t.name} from ${config.name}`,
          (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          t.name,
          client,
          config.name,
        ),
    );

    getLoggerSafe().info("[MCP] connected", { server: config.name, tools: tools.length });

    return {
      serverName: config.name,
      tools,
      close: async () => {
        await client.close().catch(() => { /* already gone */ });
      },
    };
  } catch (err) {
    // Never leave the child process running behind a failed connect.
    await client.close().catch(() => { /* transport may not have opened */ });
    throw err;
  }
}

/**
 * Connects every configured server, keeping the ones that work.
 *
 * One unreachable server must not stop Strada from starting: an MCP server is
 * optional user configuration, and a typo in one command should cost that
 * server's tools, not the whole session.
 */
export async function connectMcpServers(
  configs: readonly McpServerConfig[],
): Promise<McpConnection[]> {
  const settled = await Promise.allSettled(configs.map((c) => connectMcpServer(c)));
  const connections: McpConnection[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") {
      connections.push(outcome.value);
    } else {
      getLoggerSafe().warn("[MCP] server unavailable, continuing without it", {
        server: configs[i]!.name,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }
  return connections;
}
