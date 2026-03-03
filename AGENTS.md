# Strata Brain - AI Agent Documentation

## Project Overview

**Strata Brain** is an AI-powered Unity development assistant specifically designed for Strada.Core framework projects. It provides an intelligent agent that can understand, analyze, and modify Unity/C# codebases through multiple communication channels (Telegram, WhatsApp, CLI).

The project implements a modular agent architecture with:
- Multi-provider AI support (Claude, OpenAI, DeepSeek, Ollama, and more)
- Tool-based interaction model for file operations
- Retrieval-Augmented Generation (RAG) for code search
- Persistent memory for conversations and project analysis
- Comprehensive security controls

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| Language | TypeScript 5.7 |
| Module System | ESM (ES Modules) |
| AI SDK | @anthropic-ai/sdk |
| Bot Framework | grammy (Telegram) |
| Validation | Zod |
| Testing | Vitest |
| Linting | ESLint 9 |
| Logging | Winston |

## Project Structure

```
src/
├── index.ts                    # Application entry point
├── config/
│   └── config.ts               # Environment configuration with Zod validation
├── agents/
│   ├── orchestrator.ts         # Core agent loop (LLM → Tools → Response)
│   ├── autonomy/               # Self-improvement and error recovery
│   ├── context/                # System prompts and framework knowledge
│   ├── providers/              # AI provider implementations
│   ├── tools/                  # Tool implementations
│   │   ├── tool.interface.ts   # Base tool interface
│   │   ├── file-*.ts           # File operation tools
│   │   ├── git-*.ts            # Git operation tools
│   │   ├── dotnet-*.ts         # .NET build/test tools
│   │   ├── strata/             # Strada-specific code generators
│   │   └── ...
│   └── plugins/                # Plugin loader for custom tools
├── channels/
│   ├── channel.interface.ts    # Channel adapter contract
│   ├── telegram/bot.ts         # Telegram bot implementation
│   ├── whatsapp/client.ts      # WhatsApp implementation
│   └── cli/repl.ts             # CLI/REPL interface
├── security/
│   ├── auth.ts                 # User authentication
│   ├── path-guard.ts           # Path traversal protection
│   └── rate-limiter.ts         # Usage rate limiting
├── memory/
│   ├── memory.interface.ts     # Memory manager contract
│   └── file-memory-manager.ts  # File-based memory implementation
├── rag/                        # Retrieval-Augmented Generation
│   ├── rag.interface.ts        # RAG contracts
│   ├── rag-pipeline.ts         # Main RAG orchestration
│   ├── vector-store.ts         # File-based vector storage
│   ├── chunker.ts              # Code chunking for indexing
│   ├── embeddings/             # Embedding providers
│   └── ...
├── intelligence/               # Code analysis
│   ├── strata-analyzer.ts      # Strada project analysis
│   ├── csharp-parser.ts        # C# parsing utilities
│   └── code-quality.ts         # Code quality analysis
├── dashboard/                  # Monitoring dashboard
│   ├── server.ts               # HTTP dashboard server
│   └── metrics.ts              # Metrics collection
├── gateway/
│   └── daemon.ts               # Daemon process management
├── utils/
│   └── logger.ts               # Winston logger configuration
└── test-helpers.ts             # Shared test utilities
```

## Build and Run Commands

```bash
# Development (watch mode)
npm run dev

# Build for production
npm run build

# Start production build
npm start

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Type checking (no emit)
npm run typecheck

# Linting
npm run lint

# CLI mode (for local testing)
npm run cli

# Start with specific channel
node dist/index.js start --channel telegram
node dist/index.js start --channel whatsapp
node dist/index.js start --channel cli

# Daemon mode (auto-restart)
node dist/index.js daemon --channel telegram
```

## Configuration

Copy `.env.example` to `.env` and configure:

**Required:**
- `ANTHROPIC_API_KEY` - Primary AI provider API key
- `UNITY_PROJECT_PATH` - Absolute path to Unity project (containing Assets/)

**For Telegram:**
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `ALLOWED_TELEGRAM_USER_IDS` - Comma-separated user IDs (security)

**Optional Features:**
- `PROVIDER_CHAIN` - Fallback chain: `claude,deepseek,ollama`
- `MEMORY_ENABLED` - Enable conversation persistence (default: true)
- `RAG_ENABLED` - Enable semantic code search (default: true)
- `DASHBOARD_ENABLED` - Enable monitoring dashboard (default: false)
- `DASHBOARD_PORT` - Dashboard port (default: 3100)
- `RATE_LIMIT_ENABLED` - Enable usage limits (default: false)

See `.env.example` for all available options.

## Testing Guidelines

### Test Framework: Vitest

- Tests are co-located with source files: `*.test.ts`
- Tests exclude: `src/index.ts` (integration entry point)
- Globals enabled (no need to import `describe`, `it`, `expect`)
- Timeout: 10 seconds per test

### Test Patterns

```typescript
// Use test-helpers.ts for common mocks
import { createMockChannel, createMockProvider, createToolContext, withTempDir } from "../test-helpers.js";

// Tool testing pattern
let tempDir: string;
let ctx: ToolContext;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "test-"));
  ctx = { projectPath: tempDir, workingDirectory: tempDir, readOnly: false };
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Use withTempDir for isolated filesystem tests
await withTempDir(async (dir) => {
  // Test with temporary directory
});
```

### Running Tests

```bash
# All tests
npm test

# With coverage
npm test -- --coverage

# Specific file
npm test -- src/agents/tools/file-read.test.ts

# Watch mode
npm run test:watch
```

## Code Style Guidelines

### TypeScript Conventions

- **Strict mode enabled** - All strict compiler options are on
- **ESM modules** - Use `.js` extensions in imports
- **Path aliases** - Use `@/` for src imports: `import { x } from "@/config/config.js"`
- **Explicit types** on public interfaces
- **No unchecked indexed access** - Must handle undefined cases

### Naming Conventions

- **Files**: kebab-case.ts
- **Classes**: PascalCase
- **Interfaces**: PascalCase with `I` prefix for public contracts (`IChannelAdapter`, `ITool`)
- **Functions/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE for true constants

### Code Patterns

**Tool Implementation:**
```typescript
export class MyTool implements ITool {
  readonly name = "my_tool";
  readonly description = "Clear description for LLM";
  readonly inputSchema = {
    type: "object",
    properties: { /* ... */ },
    required: ["param"]
  };

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    // Validate with validatePath() for file operations
    // Return { content: string, isError?: boolean }
  }
}
```

**Provider Implementation:**
```typescript
export class MyProvider implements IAIProvider {
  readonly name = "my-provider";
  
  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse> {
    // Implementation
  }
}
```

### Security Requirements

**All file operations MUST:**
1. Use `validatePath()` from `security/path-guard.ts`
2. Check result: `if (!pathCheck.valid) return { content: `Error: ${pathCheck.error}`, isError: true }`
3. Respect `context.readOnly` for write operations

**Sensitive file patterns are blocked** (see `BLOCKED_PATTERNS` in path-guard.ts):
- `.env` files
- `.git/config`, `.git/credentials`
- SSH keys, certificates
- `node_modules/`

### Error Handling

```typescript
try {
  // Operation
} catch (error) {
  const errMsg = error instanceof Error ? error.message : "Unknown error";
  logger.error("Context", { error: errMsg });
  return { content: "User-friendly error", isError: true };
}
```

## Architecture Overview

### Agent Loop (Orchestrator)

```
User Message → Memory Retrieval → RAG Context → LLM → 
  ├─→ Tool Call(s) → Execute → Back to LLM
  └─→ Final Response → Channel
```

Key constants:
- `MAX_TOOL_ITERATIONS = 50` - Maximum tool calls per conversation
- Session limit: 100 concurrent sessions (LRU eviction)
- Message trim at 40 messages (old messages archived to memory)

### Tool Categories

1. **File Operations**: file_read, file_write, file_edit, file_delete, file_rename
2. **Search**: glob_search, grep_search, list_directory, code_search (RAG)
3. **Strada Codegen**: analyze_project, module_create, component_create, mediator_create, system_create
4. **Git**: git_status, git_diff, git_log, git_commit, git_push, git_branch, git_stash
5. **.NET**: dotnet_build, dotnet_test
6. **Shell**: shell_exec

### Channel Adapters

All channels implement `IChannelAdapter`:
- Telegram: Full feature support including streaming
- WhatsApp: Basic messaging (via Baileys)
- CLI: REPL interface for local development

### Memory System

Three-layer memory:
1. **Session Memory** - In-conversation context (trimmed at 40 msgs)
2. **Persistent Memory** - TF-IDF searchable conversation history
3. **RAG Index** - Vector search over codebase

### RAG Pipeline

- **Chunking**: Structural (classes, methods, constructors)
- **Embeddings**: OpenAI or Ollama
- **Vector Store**: File-based with HNSW-like search
- **Re-ranking**: Cross-encoder style scoring

## Adding New Features

### Adding a New Tool

1. Create file in `src/agents/tools/` or appropriate subdirectory
2. Implement `ITool` interface
3. Export from file and add to `src/index.ts` tools array
4. Add corresponding `.test.ts` file
5. Follow existing patterns for validation and error handling

### Adding a New Provider

1. Create file in `src/agents/providers/`
2. Implement `IAIProvider` interface
3. Add to `provider-registry.ts` and `config.ts`

### Adding a New Channel

1. Create directory in `src/channels/<name>/`
2. Implement `IChannelAdapter` interface
3. Add initialization in `src/index.ts` startBrain function

## Security Considerations

- **Path Guard**: All file paths validated against directory traversal
- **Auth**: Telegram user ID whitelist required
- **Rate Limiting**: Optional per-user and budget controls
- **Confirmation**: Write operations require user confirmation (configurable)
- **Read-Only Mode**: Complete file modification lockdown option
- **Secret Sanitization**: API keys redacted from tool outputs

## Deployment Notes

- Requires Node.js 20+ 
- Memory persistence stored in `.strata-memory/` (configurable)
- WhatsApp requires session persistence (stored in `.whatsapp-session/`)
- Graceful shutdown handles SIGINT/SIGTERM

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | Application bootstrap, DI container |
| `src/agents/orchestrator.ts` | Core agent logic |
| `src/config/config.ts` | Environment validation |
| `src/security/path-guard.ts` | Path security |
| `src/agents/context/strata-knowledge.ts` | LLM system prompt |
| `src/test-helpers.ts` | Test utilities |
