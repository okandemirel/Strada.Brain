# Strada.Brain — Technical Reference

## Overview

Strada.Brain is an AI-powered development agent for Unity / Strada.Core projects. It runs as a Node.js application (TypeScript, ESM), connects to chat platforms (Telegram, Discord, Slack, WhatsApp, CLI), and operates autonomously: reading code, writing files, running builds, fixing errors, and learning from outcomes.

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ (ESM) |
| Language | TypeScript 5.7 (strict mode) |
| AI SDK | `@anthropic-ai/sdk` (Claude primary) |
| Chat | Grammy (Telegram), discord.js, @slack/bolt, @whiskeysockets/baileys |
| Vector Search | `hnswlib-node` (native C++ bindings) |
| Database | `better-sqlite3` (SQLite) |
| Validation | Zod |
| Testing | Vitest (94 test files, 1560+ tests) |
| Logging | Winston |
| Monitoring | `prom-client` (Prometheus) |

---

## Build and Run

```bash
npm install          # Install dependencies
npm run dev          # Development mode (tsx watch)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled version
npm test             # Run all tests
npm run typecheck    # Type checking only
npm run lint         # ESLint
```

### Start Modes

```bash
npm run dev -- cli                        # Interactive CLI
npm run dev -- start --channel telegram   # Telegram bot
npm run dev -- start --channel discord    # Discord bot
npm run dev -- start --channel slack      # Slack bot
npm run dev -- start --channel whatsapp   # WhatsApp client
node dist/index.js daemon --channel telegram  # Daemon (auto-restart)
```

---

## Configuration

Copy `.env.example` to `.env`. Required variables:

```env
ANTHROPIC_API_KEY=sk-ant-...
UNITY_PROJECT_PATH=/path/to/UnityProject
JWT_SECRET=<openssl rand -hex 64>
```

See the [Configuration Reference in README.md](README.md#configuration-reference) for all variables.

---

## Architecture

### Bootstrap Sequence (`src/core/bootstrap.ts`)

The `bootstrap()` function wires everything in this order:

```
1.  loadConfig()          — Zod-validated environment parsing
2.  initializeAuth()      — AuthManager with platform allowlists
3.  initializeAIProvider() — Claude, or FallbackChainProvider from PROVIDER_CHAIN (supports 11+ providers)
4.  initializeMemory()    — FileMemoryManager (JSON + TF-IDF)
5.  initializeRAG()       — Embedding provider + HNSW vector store + background indexing
6.  initializeLearning()  — LearningStorage + LearningPipeline + ErrorRecovery + TaskPlanner
7.  ToolRegistry.init()   — Register all 30+ built-in tools + plugins
8.  initializeChannel()   — Create channel adapter based on --channel flag
9.  MetricsCollector()    — In-memory counters
10. initializeDashboard() — HTTP/WS/Prometheus servers (if enabled)
11. initializeRateLimiter()
12. new Orchestrator()    — Wire everything together
13. wireMessageHandler()  — channel.onMessage → orchestrator.handleMessage
14. channel.connect()     — Start receiving messages
```

Shutdown reverses the order: stop cleanup interval, learning pipeline, dashboard, save RAG index, flush memory, disconnect channel.

### Agent Loop (`src/agents/orchestrator.ts`)

```
Message arrives
  → Session lock (per-chat serialization)
  → Memory retrieval (top 3 matches, TF-IDF, score >= 0.15)
  → RAG retrieval (top 6 C# code chunks, HNSW, score >= 0.2)
  → Cached project analysis injection
  → Autonomy layer: TaskPlanner provides PLAN-ACT-VERIFY protocol

For up to 50 iterations:
  → LLM call (streaming if provider + channel both support it)
  → If end_turn:
      → Self-verification gate: if .cs files were modified and no
        successful dotnet_build, inject verification reminder and continue
      → Otherwise: send response to channel, exit loop
  → If tool calls:
      → Execute tools serially
      → ErrorRecoveryEngine analyzes failures (categorizes C# errors)
      → TaskPlanner tracks mutations, detects stalls, warns on budget
      → SelfVerification tracks compilable file changes
      → Feed tool results back to LLM

After loop: send timeout message
```

**Key constants:**
- `MAX_TOOL_ITERATIONS = 50` per message
- `MAX_SESSIONS = 100` (LRU eviction)
- Session trim at 40 messages (trimmed content saved to memory)
- Tool result max: 8192 characters
- Streaming update throttle: 500ms

---

## Tool System

### Interface

```typescript
interface ITool {
  name: string;
  description: string;       // Shown to the LLM
  inputSchema: object;       // JSON Schema
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}
```

`ToolContext` provides: `projectPath`, `workingDirectory`, `readOnly`, `userId?`, `chatId?`

### Security Invariants

- All file tools call `validatePath()` before disk I/O (symlink resolution + project root check)
- All tool outputs are scrubbed for API key patterns before feeding back to LLM
- Shell commands are checked against a blocklist of dangerous patterns
- Git arguments are sanitized against injection and shell metacharacters
- Strata codegen tools validate C# identifiers and types before generating code
- Write operations require user confirmation when `requireConfirmation` is enabled

### Adding a New Tool

1. Create `src/agents/tools/my-tool.ts` implementing `ITool`
2. Register in `src/core/tool-registry.ts` inside `registerBuiltinTools()`
3. Write tests in `src/agents/tools/my-tool.test.ts`

### Adding a New Provider

1. Create `src/agents/providers/my-provider.ts` implementing `IAIProvider`
2. Optionally implement `IStreamingProvider` for streaming support
3. Add to `PROVIDER_PRESETS` in `src/agents/providers/provider-registry.ts`
4. Add env var handling to `src/core/bootstrap.ts`

### Adding a New Channel

1. Create `src/channels/my-channel/` directory
2. Implement `IChannelAdapter` (extends `IChannelCore + IChannelSender + IChannelReceiver`)
3. Optionally implement `IChannelStreaming`, `IChannelRichMessaging`, `IChannelInteractive`
4. Add initialization case to `initializeChannel()` in `src/core/bootstrap.ts`

---

## Autonomy Layer

Three components run inside the orchestrator per-message:

### ErrorRecoveryEngine (`src/agents/autonomy/error-recovery.ts`)
Analyzes tool failures. For `dotnet_build`, parses MSBuild error format and categorizes into 14 C# error classes (missing_type, undefined_symbol, type_mismatch, etc.). Produces `[RECOVERY STEPS]` injected into tool result content.

### TaskPlanner (`src/agents/autonomy/task-planner.ts`)
Tracks execution state. Injects warnings when:
- 2+ file mutations without a build → `[VERIFY]`
- 3+ consecutive errors → `[STALL]`
- 40+ iterations used → `[BUDGET]`

### SelfVerification (`src/agents/autonomy/self-verification.ts`)
Tracks `.cs` / `.csproj` / `.sln` file modifications. If compilable files were changed and no successful `dotnet_build` has run, blocks the final response and injects a verification prompt.

---

## Testing Conventions

- **Framework:** Vitest with globals (`describe`, `it`, `expect` available without imports)
- **Co-located:** Tests next to source files: `foo.ts` / `foo.test.ts`
- **Timeout:** 10 seconds per test
- **Helpers:** `src/test-helpers.ts` provides `createMockChannel()`, `createMockProvider()`, `createToolContext()`, `withTempDir()`

```typescript
import { createToolContext, withTempDir } from "../test-helpers.js";

await withTempDir(async (dir) => {
  const ctx = createToolContext(dir);
  const result = await tool.execute({ path: "test.cs" }, ctx);
  expect(result.isError).toBeFalsy();
});
```

---

## Code Conventions

- **Strict TypeScript** — all strict compiler options enabled, `noUncheckedIndexedAccess: true`
- **ESM modules** — use `.js` extensions in imports
- **Path aliases** — `@/` maps to `src/`
- **Files:** `kebab-case.ts`
- **Classes:** `PascalCase`
- **Interfaces:** `I` prefix for public contracts (`IChannelAdapter`, `ITool`)
- **Functions/variables:** `camelCase`
- **Constants:** `UPPER_SNAKE_CASE`

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point (Commander.js commands) |
| `src/core/bootstrap.ts` | All initialization and wiring |
| `src/core/tool-registry.ts` | Tool instantiation and registration |
| `src/agents/orchestrator.ts` | Agent loop, sessions, streaming |
| `src/agents/context/strata-knowledge.ts` | System prompt with Strada.Core knowledge |
| `src/agents/providers/claude.ts` | Primary AI provider (Anthropic SDK) |
| `src/agents/providers/fallback-chain.ts` | Multi-provider failover |
| `src/config/config.ts` | Zod schema, env loading |
| `src/security/path-guard.ts` | Directory traversal prevention |
| `src/security/secret-sanitizer.ts` | Credential masking (24 patterns) |
| `src/memory/file-memory-manager.ts` | Active memory backend |
| `src/rag/rag-pipeline.ts` | RAG orchestration |
| `src/rag/hnsw/hnsw-vector-store.ts` | HNSW vector store (hnswlib-node) |
| `src/test-helpers.ts` | Shared test utilities |
