# Contributing to Strada.Brain

Thank you for your interest in contributing. This guide covers the development setup, coding standards, and pull request process.

## Prerequisites

- **Node.js** >= 20.0.0
- **Bun** or **npm** (Bun recommended for faster installs)
- A code editor with TypeScript support (VS Code recommended)

## Development Setup

```bash
# Clone the repository
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Fill in at least ANTHROPIC_API_KEY and JWT_SECRET

# Start in development mode (hot-reload via tsx)
npm run dev -- cli
```

## Code Style

- **TypeScript strict mode** is enabled. All code must pass `npm run typecheck` with zero errors.
- **ESLint** enforces consistent style. Run `npm run lint` before committing.
- Use `import type` for type-only imports.
- Prefer `readonly` properties on interfaces and class fields.
- Use branded types from `src/types/` (e.g., `ChatId`, `MemoryId`, `TimestampMs`) instead of raw primitives.
- Keep functions under 30 lines where possible. Extract helpers for complex logic.
- Use descriptive names: `calculateUserDiscount` over `calcDisc`.
- All new modules should export from an `index.ts` barrel file.

## Architecture Overview

Strada.Brain is organized into these key modules:

| Module | Path | Description |
|--------|------|-------------|
| **Agent Core** | `src/agent-core/` | Autonomous OODA loop, observation engine, multi-provider routing, consensus |
| **Orchestrator** | `src/agents/orchestrator.ts` | PAOR state machine, LLM interaction, tool execution |
| **Providers** | `src/agents/providers/` | 12+ AI provider implementations with fallback chain |
| **Daemon** | `src/daemon/` | HeartbeatLoop, triggers, budget tracking, security policy |
| **Goals** | `src/goals/` | DAG decomposition, wave-based parallel execution |
| **Learning** | `src/learning/` | Event-driven pipeline, instinct lifecycle, chain synthesis |
| **Memory** | `src/memory/` | AgentDB (SQLite + HNSW), session persistence |
| **Tasks** | `src/tasks/` | Task management, background execution, command handling |
| **Auto-Update** | `src/core/auto-updater.ts` | Self-updating system with 3-way install detection, lockfile, idle-aware restart |
| **Setup Wizard** | `src/core/terminal-wizard.ts` | Interactive terminal/web setup for first-time configuration |
| **Config** | `src/config/` | Zod-validated config with 90+ env vars |
| **Channels** | `src/channels/` | Web, Telegram, Discord, Slack, WhatsApp, CLI |
| **Web Portal** | `web-portal/` | React + Vite dashboard (separate package.json) |

### Key Design Patterns

- **PAOR State Machine**: All task execution (interactive AND background) uses Plan → Act → Observe → Reflect cycle
- **Structural Interfaces**: Components use duck-typed interfaces (not concrete imports) to avoid circular dependencies
- **Graceful Degradation**: All optional features (routing, consensus, MCP, embeddings) work with zero config and fail silently
- **Event-Driven Learning**: `TypedEventBus` connects tool execution → learning pipeline → instinct formation
- **Provider Agnostic**: `ConversationMessage[]` is the shared contract — providers normalize internally

## Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/my-feature
   ```
2. Make your changes. Write tests for new functionality.
3. Ensure all checks pass:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   ```
   If you changed Strada-specific prompts, analyzers, or code generation, also run:
   ```bash
   npm run sync:check -- --core-path /path/to/Strada.Core
   ```
4. Commit with a clear message describing the change.
5. Push and open a pull request against `main`.
6. A maintainer will review your PR. Address any feedback, then it will be merged.

## Adding a New Provider

1. Create `src/agents/providers/my-provider.ts` implementing `IAIProvider`
2. Add to `src/agents/providers/provider-registry.ts` factory
3. Add metadata to `src/agents/providers/provider-knowledge.ts` (strengths, context window, cost tier)
4. Add cost/speed tiers to `src/agent-core/routing/provider-router.ts`
5. Run tests: `npx vitest run src/agents/providers/`

## Adding a New Observer

1. Create `src/agent-core/observers/my-observer.ts` implementing `Observer` interface
2. Export from `src/agent-core/observers/index.ts`
3. Register in `src/core/bootstrap.ts` (inside daemon mode block)
4. Add tests to `src/agent-core/observers/observers.test.ts`

## Running Tests

```bash
# Full suite (3450+ tests)
npm test

# Specific module
npx vitest run src/agent-core/
npx vitest run src/agents/
npx vitest run src/daemon/

# Watch mode
npx vitest --watch
```

## Web Portal Development

```bash
cd web-portal
npm install
npm run dev     # Development server with HMR
npm run build   # Production build → src/channels/web/static/
```

## Testing

- Tests use **Vitest** (`npm test`).
- Place test files next to the source file they test, named `*.test.ts`.
- Mock external dependencies (AI providers, file system, network) in unit tests.
- Test edge cases: empty inputs, large inputs, error conditions.
- Integration tests go in `src/` (co-located as `integration.test.ts`).
- For Unity/Strada codegen changes, prefer `npm run test:unity-fixture` when a licensed local Unity editor is available.
- Current test suite: 3120+ tests across 180+ test files.

## Adding a New Tool

1. Create a file in `src/agents/tools/` implementing `ITool` from `tool.interface.ts`.
2. Define `name`, `description`, and `inputSchema` (Zod-compatible JSON Schema).
3. Implement the `execute(input, context)` method.
4. Register the tool in the bootstrap process (`src/core/bootstrap.ts`).
5. Write tests covering success and error paths.

## Adding a New Channel

Strada.Brain supports 6 channels: Web (default), Telegram, Discord, Slack, WhatsApp, and CLI.

1. Create a directory under `src/channels/` (e.g., `src/channels/mychannel/`).
2. Implement the `IChannelAdapter` interface from `channel.interface.ts`.
3. Optionally implement `IChannelStreaming`, `IChannelRichMessaging`, or `IChannelInteractive`.
4. Register the channel in `src/core/bootstrap.ts`.
5. Add the channel type to `SupportedChannelType` in `src/common/constants.ts`.

## Security Guidelines

- Never hardcode secrets or credentials in source files.
- Never commit `.env` files.
- Validate all user input at system boundaries using Zod schemas.
- Sanitize file paths with the path guard before any file system operation.
- When adding tools that execute commands, respect the `readOnly` flag from `ToolContext`.
- Run `npm run security:audit` periodically to check for dependency vulnerabilities.

## Questions?

Open an issue on GitHub if you have questions about contributing.
