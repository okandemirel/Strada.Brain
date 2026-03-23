# Strada.Brain Skill Ecosystem

## Problem

Strada.Brain has zero working plugins despite having 3 separate plugin mechanisms (plugin-loader, core registry, hot-reload). OpenClaw ships 100+ skills with install/uninstall CLI, a marketplace (ClawHub), and per-skill environment injection. Strada.Brain needs a unified skill system to enable community contributions and third-party integrations.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Manifest format | SKILL.md (YAML frontmatter) | OpenClaw-compatible, human-readable, self-documenting |
| Loading tiers | 3-tier (workspace > managed > bundled) | Matches OpenClaw, allows per-project overrides |
| Registry model | Index JSON + distributed repos | Simple to maintain, community-friendly, GitHub-native |
| Lifecycle management | Reuse existing PluginRegistry | Dependency resolution + topological sort already implemented and tested |
| Skill scope | Generic framework | No domain restriction; first skills TBD based on community demand |
| New dependencies | Zero | Custom YAML frontmatter parser (~30 lines) instead of gray-matter |

## SKILL.md Manifest Format

```markdown
---
name: gmail
version: 1.0.0
description: Gmail integration — read, search, draft, send emails
author: okandemirel
homepage: https://github.com/okandemirel/strada-skill-gmail
requires:
  bins: ["node"]
  env: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"]
  config: ["skills.gmail.credentials"]
capabilities: ["email.read", "email.send", "email.search"]
---

# Gmail Skill

Human-readable documentation for the skill...
```

**Required fields:** `name`, `version`, `description`
**Optional fields:** `author`, `homepage`, `requires`, `capabilities`

### Frontmatter Parser

No new dependency. Custom parser using `---` delimiter + restricted YAML subset:
- Split on first two `---` markers to extract frontmatter block
- **Restricted format** (not full YAML):
  - Top-level keys: `key: value` (string values, no quoting needed unless containing `:`)
  - Arrays: JSON-style only — `["a", "b"]`
  - Nested objects: indentation-based (2 spaces), max 1 level deep (e.g., `requires:` with sub-keys `bins`, `env`, `config`)
  - No multiline values, no anchors, no flow mappings
  - Quoted strings: double-quotes for values containing colons (e.g., `description: "foo: bar"`)
- ~60 lines, tested independently with edge cases

## Three-Tier Loading

```
Precedence (highest to lowest):
1. Workspace skills:  <projectRoot>/skills/
2. Managed skills:    ~/.strada/skills/
3. Bundled skills:    src/skills/   (shipped with Strada.Brain)
```

Higher tier overrides lower tier for same-named skills. Additional directories via `skills.load.extraDirs` config (lowest precedence).

### Discovery Algorithm

1. Scan each tier directory for `*/SKILL.md` files
2. Parse frontmatter, validate required fields
3. Build merged skill map (higher tier wins on name collision)
4. Return ordered list respecting dependencies

## Skill Lifecycle

```
discover -> validate -> gate -> register -> init
                                            |
                                     enable / disable
                                            |
                                         dispose
```

### Stages

- **Discover:** Scan 3 tiers for SKILL.md files
- **Validate:** Parse frontmatter, check required fields, validate version format
- **Gate:** Check `requires.bins` (binary exists in PATH?), `requires.env` (env var set?), `requires.config` (config key exists?)
- **Register:** Add to PluginRegistry with dependency metadata for topological ordering
- **Init:** Load tool module (ESM dynamic import with nonce-based cache busting — same `?nonce=` trick as plugin-loader.ts to enable `strada skill update` reload), register tools in ToolRegistry with `isPlugin: true` and `skill_{name}_{tool}` namespace, apply env injection. Tool name collision check: if `skill_{name}_{tool}` already exists in ToolRegistry (from another skill or plugin), skip with warning log instead of crashing.
- **Enable/Disable:** Runtime toggle via `skills.entries.<name>.enabled` in config. Disabled skills are discovered but not initialized.
- **Dispose:** Unregister tools from ToolRegistry, restore environment variables

### Reusing PluginRegistry

The existing `src/plugins/registry.ts` provides:
- Dependency resolution with topological sort (DFS)
- Cycle detection
- Ordered init/dispose respecting dependencies
- Graceful error handling

`SkillManager` wraps `PluginRegistry`, adapting SKILL.md manifests into the registry's plugin metadata format:

```typescript
// Adapter mapping: SkillManifest → PluginMetadata
function toPluginMetadata(skill: SkillManifest): PluginMetadata {
  return {
    name: skill.name,
    version: skill.version,
    description: skill.description,
    capabilities: skill.capabilities ?? [],        // Default empty array
    dependencies: skill.requires?.skills ?? [],     // Inter-skill deps (optional)
    permissions: { network: false, filesystem: false }, // Skills run in-process, no sandbox
  };
}

// Adapter: SkillInstance → Plugin interface
function toPlugin(skill: LoadedSkill): Plugin {
  return {
    metadata: toPluginMetadata(skill.manifest),
    initialize: async () => { /* register tools, inject env */ },
    dispose: async () => { /* unregister tools, restore env */ },
  };
}
```

## CLI Commands

Added as `strada skill` subcommand in `src/index.ts` (Commander):

```bash
strada skill install <name>          # Registry lookup -> git clone -> ~/.strada/skills/<name>/
strada skill install <url>           # Direct git URL -> git clone
strada skill remove <name>           # Delete from ~/.strada/skills/<name>/
strada skill list                    # Show all skills across tiers with status
strada skill update <name>           # git pull in skill directory
strada skill update --all            # Update all managed skills
strada skill search <query>          # Search registry by name/tags/description
strada skill info <name>             # Show SKILL.md content + gating status
```

### Install Flow

0. Check `git` is in PATH — if missing, exit with clear error: "git is required for skill installation"
1. If argument is a URL: `git clone <url> ~/.strada/skills/<name>/`
2. If argument is a name: fetch `registry.json` from registry repo -> find URL -> clone with `--branch <tag>` if registry entry has a `tag` field, otherwise HEAD
3. Validate SKILL.md exists in cloned directory
4. Run gating checks, report missing requirements
5. Add to config `skills.entries.<name>.enabled: true`

### Update Semantics

`strada skill update` runs `git pull` in the skill directory. This is an **offline operation** — the running process is NOT hot-reloaded. A restart is required to pick up updated skill code. The nonce-based ESM cache busting ensures the new code is loaded on next startup.

## Git-Based Registry

Repository: `okandemirel/strada-skill-registry`

Single file: `registry.json`
```json
{
  "version": 1,
  "skills": {
    "gmail": {
      "repo": "https://github.com/okandemirel/strada-skill-gmail",
      "description": "Gmail integration — read, search, draft, send emails",
      "tags": ["email", "communication"],
      "version": "1.0.0",
      "tag": "v1.0.0",
      "author": "okandemirel"
    }
  }
}
```

The `tag` field is optional. When present, `git clone --branch <tag>` pins to that version. When absent, HEAD of default branch is cloned. `version` is informational (shown in `strada skill list`).
```

### Registry Client

- Fetch raw `registry.json` from GitHub using existing `fetchWithRetry` utility (retry on 5xx/rate-limit, backoff)
- Cache locally at `~/.strada/skill-registry.json` with 1-hour TTL
- Fallback to cache when offline — `strada skill search` prints "(offline — using cached registry)" when serving stale data
- `strada skill search` filters cached registry by name/tags/description substring match
- `strada skill search --refresh` forces a fresh fetch before searching

## Per-Skill Environment Injection

Skill config is stored in `~/.strada/skills.json` (separate from main Strada config which is env-var-driven). This file is managed by skill CLI commands and read at startup:
```json
{
  "skills": {
    "entries": {
      "gmail": {
        "enabled": true,
        "env": {
          "GMAIL_CLIENT_ID": "xxx",
          "GMAIL_CLIENT_SECRET": "yyy"
        },
        "config": {
          "maxResults": 50
        }
      }
    }
  }
}
```

### Injection Mechanism

1. On skill init: snapshot current `process.env` for injected keys
2. Set `process.env[key] = value` for each entry in `skills.entries.<name>.env`
3. Cross-check against `requires.env` in manifest — warn if required env missing
4. On skill dispose: restore original values from snapshot

### Security Note

Environment injection runs in-process (no sandbox). Skills have full Node.js access. Users should treat third-party skills as untrusted code and review before enabling.

## Binary/Env/Config Gating

```typescript
interface SkillRequirements {
  bins?: string[];    // Required binaries in PATH
  env?: string[];     // Required environment variables
  config?: string[];  // Required config keys
}
```

### Gating Check

- `bins`: Use `which` (Unix) / `where` (Windows) to check binary existence
- `env`: Check `process.env[key]` is defined and non-empty
- `config`: Check Strada config has the specified key path

Failed gates → skill marked as `gated` (not `disabled`). Listed in `strada skill list` with reason. User can fix requirements and re-init.

### Remove Dependency Handling

`strada skill remove <name>` checks if other skills depend on the target (via PluginRegistry's dependency graph). If dependents exist:
- Print error: "Cannot remove '<name>' — required by: <dependent1>, <dependent2>"
- Suggest: `strada skill remove --cascade <name>` to remove target + all dependents
- No silent cascade — always explicit

## File Structure

```
src/skills/
  skill-loader.ts            # 3-tier discovery + SKILL.md parsing
  skill-manager.ts           # Lifecycle orchestration (wraps PluginRegistry)
  skill-registry-client.ts   # GitHub registry fetch, cache, search
  skill-env-injector.ts      # Per-skill env injection + restore
  skill-gating.ts            # Binary/env/config requirement checks
  skill-cli.ts               # Commander subcommands for `strada skill`
  types.ts                   # SkillManifest, SkillEntry, SkillStatus interfaces
  frontmatter-parser.ts      # Zero-dep YAML frontmatter parser
```

## Integration Points

| Target | Change |
|--------|--------|
| `src/core/bootstrap-stages/stage-goals.ts` | Add `SkillManager.loadAll()` call after ToolRegistry init |
| `src/index.ts` | Add `strada skill` Commander subcommand via `registerSkillCommands(program)` |
| `src/skills/skill-config.ts` | New: read/write `~/.strada/skills.json` (separate from main env-var config) |
| `src/core/bootstrap.ts` | Wire SkillManager instance into bootstrap |
| `src/agents/plugins/plugin-loader.ts` | Backward-compatible — `PLUGIN_DIRS` still works alongside skills |

## Backward Compatibility

- Existing `PLUGIN_DIRS` mechanism continues to work unchanged
- `plugin.json` manifests still supported via plugin-loader
- New SKILL.md skills and old plugin.json plugins coexist in ToolRegistry
- No breaking changes to any existing API

## Constraints

- Zero new npm dependencies
- All skills tests must pass alongside existing 4,300+ test suite
- TypeScript strict mode
- Skills directory structure must work on macOS, Linux, Windows
- Registry client must work offline (cached fallback)

## Success Criteria

- `strada skill install <name>` works end-to-end (registry lookup -> clone -> load -> tools available)
- `strada skill list` shows skills from all 3 tiers with status (active/disabled/gated)
- Skills load automatically on startup without CLI intervention
- Per-skill env injection works and restores on disable
- Binary gating correctly prevents skills from loading when requirements aren't met
- Existing plugin system continues to work unchanged
- Zero new npm dependencies added
