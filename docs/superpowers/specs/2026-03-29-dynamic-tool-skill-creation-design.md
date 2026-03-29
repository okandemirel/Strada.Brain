# Dynamic Tool & Skill Creation at Runtime

**Date:** 2026-03-29
**Status:** Approved (autonomous)
**Author:** Claude (autonomous design)

## Problem

Strada.Brain agents cannot create new tools or skills during execution. When the agent encounters a task requiring capabilities beyond its static tool set, it has no mechanism to self-extend. This limits the agent's ability to adapt to novel situations.

## Solution

Add three new tools that enable runtime self-extension:

1. **`create_tool`** — Dynamically create and register executable tools
2. **`create_skill`** — Create persistent skill files on disk for future sessions
3. **`remove_dynamic_tool`** — Unregister dynamically created tools/skills

### Architecture

```
Agent detects missing capability
        ↓
Calls create_tool / create_skill
        ↓
DynamicToolFactory creates ITool from spec
        ↓
ToolContext.registerDynamicTool() callback
        ↓
Orchestrator.registerTool() adds to tools Map + toolDefinitions
        ↓
Next PAOR iteration: LLM sees new tool in function schemas
        ↓
Agent uses the new tool
```

### Design Decisions

1. **ToolContext extension over singleton registry** — Pass `registerDynamicTool` callback through ToolContext. Clean, no new singletons, orchestrator controls registration.

2. **Two strategies: shell + composite** — Shell for CLI wrappers, composite for chaining existing tools. No arbitrary code execution (no `vm` module) — keeps it dependency-free and secure.

3. **`dynamic_` prefix** — All dynamic tool names get prefixed with `dynamic_` to prevent conflicts with built-in tools and make them easily identifiable.

4. **Safety by default** — Dynamic shell tools require confirmation on first use. Parameter sanitization prevents shell injection. Maximum 50 dynamic tools per session.

5. **Skills write to disk** — `create_skill` writes SKILL.md to workspace skills directory (`<project>/skills/`). Available in future sessions via normal discovery. Not immediately loadable as executable tools (requires restart).

## Components

### 1. Types (`src/agents/tools/dynamic/types.ts`)

```typescript
interface DynamicToolSpec {
  name: string;
  description: string;
  parameters: ToolSchemaProperty[];
  strategy: 'shell' | 'composite';
  // Shell strategy
  command?: string;           // Template: "git log --oneline -n {{count}}"
  timeout?: number;           // ms, default 30000
  // Composite strategy
  steps?: CompositeStep[];
}

interface CompositeStep {
  tool: string;               // Existing tool name
  params: Record<string, string>;  // Values or {{param}} references
  outputAs?: string;          // Name to reference this step's output
}

interface DynamicSkillSpec {
  name: string;
  version: string;
  description: string;
  content: string;            // SKILL.md body content
  author?: string;
  capabilities?: string[];
}
```

### 2. DynamicToolFactory (`src/agents/tools/dynamic/dynamic-tool-factory.ts`)

Creates `ITool` instances from `DynamicToolSpec`. Handles:
- Shell command parameter interpolation with sanitization
- Composite tool step execution with output chaining
- Validation of specs before creation

### 3. ToolContext Extension (`src/agents/tools/tool-core.interface.ts`)

```typescript
interface ToolContext {
  // ... existing fields
  registerDynamicTool?: (tool: ITool) => void;
  unregisterDynamicTool?: (toolName: string) => boolean;
}
```

### 4. Orchestrator Integration (`src/agents/orchestrator.ts`)

In `executeToolCalls()`, add callbacks to toolContext:
```typescript
const toolContext = {
  ...existing,
  registerDynamicTool: (tool: ITool) => this.registerTool(tool),
  unregisterDynamicTool: (name: string) => { ... },
};
```

## Safety

- **Shell injection prevention**: Parameters escaped via `shellEscape()` before interpolation
- **Confirmation required**: Dynamic shell tools set `requiresConfirmation: true` in metadata
- **Timeout**: Shell commands timeout after 30s (configurable, max 60s)
- **Limits**: Maximum 50 dynamic tools per session
- **Name conflicts**: Refused if name matches existing built-in tool
- **Path traversal**: Shell commands validated to not contain `../` or absolute paths in dangerous positions
- **No arbitrary code execution**: Only shell commands and existing tool composition

## Testing

- Unit tests for DynamicToolFactory (shell + composite strategies)
- Unit tests for create_tool, create_skill, remove_dynamic_tool
- Integration test: create tool → use it → remove it
- Security tests: shell injection attempts, name conflicts, limit enforcement
