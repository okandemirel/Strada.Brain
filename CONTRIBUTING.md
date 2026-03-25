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
| **Auto-Update** | `src/core/auto-updater.ts` | Self-updating system with 3-way install detection, atomic lockfile, idle-aware restart, dependency installation, post-update health check with rollback, daemon-aware restart, and webhook-triggered immediate checks (`POST /api/update`) |
| **Setup Wizard** | `src/core/terminal-wizard.ts` | Interactive terminal/web setup for first-time configuration |
| **Config** | `src/config/` | Zod-validated config with 90+ env vars |
| **Channels** | `src/channels/` | Web, Telegram, Discord, Slack, WhatsApp, CLI, Matrix, IRC, Teams |
| **Web Portal** | `web-portal/` | React + Vite dashboard (separate package.json) |

### Key Design Patterns

- **Dual Loop Architecture**:
  - **PAOR** (`src/agents/orchestrator.ts`): Reactive loop — user sends message → Plan → Act → Observe → Reflect. Handles all interactive and background task execution.
  - **OODA** (`src/agent-core/agent-core.ts`): Proactive loop — HeartbeatLoop tick → Observe → Orient → Decide → Act. Monitors environment autonomously without user prompting.
  - Shared infrastructure: Both use `ProviderRouter` from `src/agent-core/routing/` for provider selection.
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
3. Register in `src/core/bootstrap-stages/stage-daemon.ts` (inside daemon mode block)
4. Add tests to `src/agent-core/observers/observers.test.ts`

## Running Tests

```bash
# Full suite (4,413+ tests)
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
- Current test suite: 4,413+ tests across 180+ test files.

## Adding a New Tool

1. Create a file in `src/agents/tools/` implementing `ITool` from `tool.interface.ts`.
2. Define `name`, `description`, and `inputSchema` (Zod-compatible JSON Schema).
3. Implement the `execute(input, context)` method.
4. Register the tool in `src/core/bootstrap-wiring.ts`.
5. Write tests covering success and error paths.

## Adding a New Channel

Strada.Brain supports 9 channels: Web (default), Telegram, Discord, Slack, WhatsApp, CLI, Matrix, IRC, and Teams.

1. Create a directory under `src/channels/` (e.g., `src/channels/mychannel/`).
2. Implement the `IChannelAdapter` interface from `channel.interface.ts`.
3. Optionally implement `IChannelStreaming`, `IChannelRichMessaging`, or `IChannelInteractive`.
4. Register the channel in `src/core/bootstrap-channels.ts`.
5. Add the channel type to `SupportedChannelType` in `src/common/constants.ts`.

## Creating a Skill

Strada.Brain has a skill ecosystem that lets you extend the agent with new tools. Skills are self-contained packages with a manifest, tool implementations, and tests.

### Skill Structure

```
my-skill/
  SKILL.md       # Manifest (required)
  index.ts       # Tool implementations (required)
  my-skill.test.ts  # Tests (required for PRs)
```

### SKILL.md Manifest

The manifest uses YAML frontmatter:

```markdown
---
name: my-skill
version: 1.0.0
description: Short description of what this skill does
author: your-github-username
requires:
  bins: ["some-cli"]
  env: ["MY_API_KEY"]
capabilities: ["domain.action1", "domain.action2"]
---

# My Skill

Human-readable documentation about the skill.
```

**Required fields:** `name`, `version`, `description`
**Optional fields:** `author`, `homepage`, `requires`, `capabilities`

**Requirements gating:**
- `bins`: Binaries that must exist in PATH (e.g., `gh`, `docker`)
- `env`: Environment variables that must be set (e.g., `NOTION_API_KEY`)
- `config`: Strada config keys that must exist
- `skills`: Other skills this depends on

### Tool Implementation

Each skill exports an array of `ITool` objects from `index.ts`:

```typescript
import type { ITool, ToolContext, ToolExecutionResult } from "../../../agents/tools/tool.interface.js";

const myTool: ITool = {
  name: "my_tool_name",
  description: "What this tool does — shown to the AI agent.",
  inputSchema: {
    type: "object" as const,
    properties: {
      param1: { type: "string", description: "Description of param1" },
    },
    required: ["param1"],
  },
  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const param1 = typeof input["param1"] === "string" ? input["param1"] : "";
    // Your logic here
    return { content: `Result: ${param1}` };
  },
};

export const tools = [myTool];
export default tools;
```

**Key rules:**
- Tool names must be unique — they get namespaced as `skill_{skillname}_{toolname}` at runtime
- Always validate input types (the AI may send unexpected values)
- Return `{ content: string }` — the string is shown to the AI agent
- Use `_context: ToolContext` if you don't need context (respects linting)
- For CLI tools, use `execFileNoThrow` from `src/utils/execFileNoThrow.js`

### Testing

Place tests next to `index.ts`, named `{skill-name}.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { tools } from "./index.js";
import type { ToolContext } from "../../../agents/tools/tool.interface.js";

const mockContext = {} as ToolContext;

describe("my-skill", () => {
  it("exports tools array", () => {
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it("my_tool_name returns expected result", async () => {
    const tool = tools.find((t) => t.name === "my_tool_name")!;
    const result = await tool.execute({ param1: "hello" }, mockContext);
    expect(result.content).toContain("hello");
  });

  it("handles missing input gracefully", async () => {
    const tool = tools.find((t) => t.name === "my_tool_name")!;
    const result = await tool.execute({}, mockContext);
    expect(result.content).toBeDefined();
  });
});
```

### Three-Tier Loading

Skills are loaded from three locations (highest precedence first):

1. **Workspace:** `<projectRoot>/skills/` — project-specific skills
2. **Managed:** `~/.strada/skills/` — user-installed skills
3. **Bundled:** `src/skills/bundled/` — shipped with Strada.Brain

Higher-tier skills override lower-tier skills with the same name.

### Publishing to the Registry

To share your skill with the community:

1. Create a GitHub repository for your skill (e.g., `strada-skill-my-skill`)
2. Ensure it has a valid `SKILL.md` and `index.ts` at the root
3. Fork [okandemirel/strada-skill-registry](https://github.com/okandemirel/strada-skill-registry)
4. Add your skill to `registry.json`:
   ```json
   {
     "my-skill": {
       "repo": "https://github.com/your-username/strada-skill-my-skill",
       "description": "Short description",
       "tags": ["category1", "category2"],
       "version": "1.0.0",
       "author": "your-username"
     }
   }
   ```
5. Open a pull request to the registry repository
6. Users can then install via: `strada skill install my-skill`

### Bundled Skill Contributions

To contribute a skill directly to the Strada.Brain repo:

1. Create a directory under `src/skills/bundled/your-skill/`
2. Add `SKILL.md`, `index.ts`, and `your-skill.test.ts`
3. Run tests: `npx vitest run src/skills/bundled/your-skill/`
4. Bundled skills should have **zero external dependencies**

## Cross-Platform Guidelines

- **Path separators:** Never use hardcoded `"/"` in path containment checks (e.g., `startsWith(root + "/")`). Use `path.sep` from `node:path` instead. On Windows, `path.resolve()` produces backslash paths and a hardcoded `/` will always fail the comparison.
- **Absolute path checks:** Use `path.isAbsolute()` instead of `startsWith("/")` — Windows absolute paths start with a drive letter (e.g., `C:\`).
- **Spawning `.cmd` files:** On Windows, spawning `.cmd`/`.bat` files (like `npm.cmd`) requires `shell: true` in the `spawn`/`spawnSync` options on Node.js 22+ (CVE-2024-27980). Use `shell: process.platform === "win32"`.
- **URL escaping in CMD:** When passing URLs to `cmd /c start`, quote the URL to prevent `&` from being interpreted as a command separator.

## Security Guidelines

- Never hardcode secrets or credentials in source files.
- Never commit `.env` files.
- Validate all user input at system boundaries using Zod schemas.
- Sanitize file paths with the path guard before any file system operation.
- When adding tools that execute commands, respect the `readOnly` flag from `ToolContext`.
- Run `npm run security:audit` periodically to check for dependency vulnerabilities.

## Questions?

Open an issue on GitHub if you have questions about contributing.
