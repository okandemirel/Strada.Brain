/**
 * A real MCP server, used as a test fixture.
 *
 * Deliberately a separate process speaking the actual protocol rather than an
 * in-process mock: the point of mcp-client is that it talks JSON-RPC over
 * stdio to a foreign binary, and a mock of the SDK would test the mock. It
 * exposes one tool per behaviour the client has to get right — a normal call,
 * a protocol-level error, and a report of what environment leaked into the
 * child.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "probe-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes its input",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "report_env",
      description: "Lists secret-looking environment variables visible to this process",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "boom",
      description: "Always reports a tool-level failure",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "image_only",
      description: "Returns a non-text content block",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${args.text}` }] };
    case "report_env": {
      const leaked = Object.keys(process.env).filter((k) => /CANARY/i.test(k));
      return { content: [{ type: "text", text: leaked.length ? `LEAKED:${leaked.join(",")}` : "clean" }] };
    }
    case "boom":
      return { content: [{ type: "text", text: "deliberate failure" }], isError: true };
    case "image_only":
      return { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] };
    default:
      throw new Error(`unknown tool ${name}`);
  }
});

await server.connect(new StdioServerTransport());
