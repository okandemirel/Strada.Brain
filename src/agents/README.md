# src/agents/

The agents directory contains the orchestrator (the "brain"), AI providers, tools, the autonomy layer, and the plugin system.

## Agent Orchestration System Overview

The `Orchestrator` class implements a standard agent loop with per-session concurrency control. Each incoming message is routed through:

```
User message
  -> Check rate limits
  -> Retrieve memory + RAG context
  -> Inject system prompt + context
  -> LLM call (with tool definitions)
  -> If tool calls: execute tools, feed results back to LLM
  -> Autonomy layer: error recovery, stall detection, self-verification
  -> Repeat until LLM returns end_turn or max iterations (50)
  -> Send final response to channel
```

Session management uses an LRU map capped at 100 concurrent sessions. Messages within the same chat are serialized via per-session locks to prevent race conditions. Streaming is supported when both the provider and channel implement their respective streaming interfaces.

## Tool Registration and Interface

Tools implement the `ITool` interface defined in `tools/tool.interface.ts`:

```typescript
interface ITool {
  name: string;
  description: string;
  inputSchema: object;         // JSON Schema for input validation
  execute(input, context): Promise<ToolResult>;
}
```

The `ToolContext` provides `projectPath`, `workingDirectory`, and a `readOnly` flag. Tools that modify the file system must check `readOnly` before proceeding. Write operations require user confirmation when `requireConfirmation` is enabled.

All tool outputs are sanitized before being fed back to the LLM -- API key patterns are redacted and content is capped at 8192 characters.

## Key Files and Their Purposes

```
agents/
  orchestrator.ts          # Core agent loop, session management, streaming
  autonomy/                # Error recovery, task planner, self-verification
    error-recovery.ts      # Analyzes tool failures, suggests recovery actions
    task-planner.ts        # Tracks tool calls, detects stalls, budget warnings
    self-verification.ts   # Verification gate before final response
    constants.ts           # Write operation set, shared constants
  context/
    strata-knowledge.ts    # System prompt, project context builder
  plugins/
    plugin-loader.ts       # Dynamic tool loading from plugins directory
  providers/               # AI provider implementations
    claude.ts              # Anthropic Claude (primary)
    openai.ts              # OpenAI-compatible
    openai-compat.ts       # Generic OpenAI-compatible adapter
    ollama.ts              # Local Ollama models
    fallback-chain.ts      # Provider chain with automatic failover
    provider.interface.ts  # IAIProvider, IStreamingProvider interfaces
  tools/                   # Built-in tools
    tool.interface.ts      # ITool interface and ToolContext
    file-read.ts           # Read files
    file-write.ts          # Write files
    file-edit.ts           # Search-and-replace editing
    file-manage.ts         # Rename, delete, list directories
    git-tools.ts           # Git operations
    shell-exec.ts          # Shell command execution
    code-search.ts         # Grep/glob search
    browser-automation.ts  # Playwright-based browser tools
    memory-search.ts       # Memory retrieval tool
    rag-index.ts           # RAG indexing tool
    dotnet-tools.ts        # .NET/Unity build tools
    strata/                # Strata.Core-specific tools
```

## How to Add New Tools

1. Create a file in `src/agents/tools/` implementing the `ITool` interface.
2. Define `name`, `description`, and `inputSchema` (JSON Schema).
3. Implement `execute(input, context)` -- return `{ content, isError }`.
4. Register the tool in `src/core/bootstrap.ts`.
5. Write tests in a co-located `*.test.ts` file.
