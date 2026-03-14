# SOUL.md — Agent Personality System Design

**Goal:** Replace hardcoded agent behavior with a user-editable Markdown personality file that defines identity, communication style, clarification rules, and boundaries. Hot-reloadable, channel-overridable, provider-agnostic.

## Architecture

```
soul.md (project root)          ← user edits this
    ↓
SoulLoader (src/agents/soul/)   ← reads + caches + watches
    ↓
Orchestrator.buildSystemPrompt  ← injects into system prompt
    ↓
All providers (Claude, OpenAI, Kimi, Gemini, etc.)
All channels (Web, Telegram, Discord, Slack, WhatsApp, CLI)
```

### Components

1. **`soul.md`** — Markdown file in project root. User-editable personality definition.
2. **`SoulLoader`** — Reads soul.md, caches content, watches for changes. Supports channel-specific overrides.
3. **`buildSystemPrompt()`** — Assembles final prompt: `strada-knowledge + soul content + runtime context`.
4. **Config** — `SOUL_FILE` env var (default: `soul.md`), optional `SOUL_FILE_{CHANNEL}` overrides.

### Default soul.md

```markdown
# Identity
You are Strada Brain, an autonomous AI development assistant for Unity/Strada.Core projects. You are helpful, knowledgeable, and proactive.

# Communication Style
- Be concise but warm — skip filler phrases like "Sure, I'd be happy to help!"
- Make recommendations instead of saying "it depends"
- Have opinions — you're allowed to prefer one approach over another
- When something goes wrong, explain what you'll try differently instead of apologizing
- Match the user's language automatically (Turkish, English, etc.)

# Clarification Rules
- When a request is ambiguous, ask 1-3 clarifying questions before proceeding
- Prefer multiple-choice questions over open-ended ones
- For complex multi-step tasks, show a brief plan and wait for approval
- For risky operations (file deletion, git push), always confirm first

# Boundaries
- Never access files outside the project directory
- Never execute destructive operations without user confirmation
- If you're unsure about something, say so — don't guess

# Personality
- You remember previous conversations and reference them naturally
- You suggest improvements proactively when you notice issues
- You celebrate wins — "Build succeeded!" not just "Build completed."
```

### Channel Override

```env
SOUL_FILE=soul.md                         # default for all channels
SOUL_FILE_TELEGRAM=soul-telegram.md       # optional telegram-specific
SOUL_FILE_DISCORD=soul-discord.md         # optional discord-specific
```

If a channel-specific file doesn't exist, falls back to default.

### Hot Reload

SoulLoader uses `fs.watch` on the soul file. When modified:
1. Re-reads content
2. Updates cache
3. Next LLM call uses new personality (no restart needed)

### Integration Points

- **Orchestrator**: `buildSystemPrompt()` calls `soulLoader.getContent(channelType)` and injects between strada-knowledge and runtime context.
- **All providers**: No provider changes needed — personality is in the system prompt, which all providers already receive.
- **All channels**: Channel type is passed to SoulLoader for override resolution. No channel code changes needed.
- **Bootstrap**: SoulLoader initialized in `bootstrap.ts`, injected into Orchestrator.

### File Structure

```
src/agents/soul/
  soul-loader.ts        # Read, cache, watch soul.md
  soul-loader.test.ts   # Tests
soul.md                 # Default personality (project root)
```

### Config Schema Addition

```typescript
// In config.ts Zod schema:
SOUL_FILE: z.string().default("soul.md"),
```

No new npm dependencies.
