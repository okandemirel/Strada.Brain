# Community, Marketplace & New Skills Design

## Overview

Three parallel work streams to grow the Strada.Brain skill ecosystem:
1. **CONTRIBUTING.md** — Add skill authoring guide for community contributors
2. **Marketplace UI** — Search + install skills from registry via web portal
3. **New Skills** — 2 bundled (system-info, json-utils) + 4 registry (notion, google-calendar, spotify, home-assistant)

## 1. CONTRIBUTING.md — Skill Authoring Guide

Update existing `CONTRIBUTING.md` to add "Creating a Skill" section after "Adding a New Channel".

### Content

- SKILL.md manifest format (required + optional fields, full example)
- Directory structure: `SKILL.md` + `index.ts` + `*.test.ts`
- Tool interface: `ITool` with `name`, `description`, `inputSchema`, `execute(input, context)`
- Gating requirements: `bins`, `env`, `config`, `skills`
- Testing pattern: vitest, mock `ToolContext`, test success + error paths
- Publishing to registry: fork `strada-skill-registry`, add entry to `registry.json`, PR
- 3-tier loading (workspace > managed > bundled)

Also fix stale numbers: test count → 4,413+, channel count → 9.

## 2. Marketplace UI

### Backend (dashboard/server.ts)

Two new endpoints:

**`GET /api/skills/registry?q=<query>&refresh=true`**
- Calls `fetchRegistry(refresh)` + `searchRegistry(registry, query)`
- Cross-references with `skillManager.getEntries()` to add `installed: boolean`
- Returns `{ skills: RegistrySearchResult[] }`

**`POST /api/skills/install`**
- Body: `{ name: string, repo?: string }`
- Runs git clone to `~/.strada/skills/<name>/`
- Validates SKILL.md exists in cloned directory
- Updates skills.json with `enabled: true`
- Returns `{ success: true }` or `{ error: string }`

### Frontend (SkillsPage.tsx)

Extend with shadcn `Tabs` component:

**"Installed" tab** — Current table (default, unchanged)

**"Marketplace" tab** — New:
- Search input with debounce (300ms)
- Card grid: name, description, author, tags[], version
- "Install" button per card (POST `/api/skills/install`)
- "Installed" badge if already loaded
- Loading skeleton, empty state, error state
- Glassmorphism card styling

New hook in `use-api.ts`:
```typescript
useSkillRegistry(query: string) → GET /api/skills/registry?q=${query}
```

## 3. New Skills

### Bundled (src/skills/bundled/)

**system-info** — Zero deps
- `system_uptime`: OS uptime, load average
- `system_resources`: CPU count/model, memory total/free, disk usage
- `system_network`: Network interfaces with IPs

**json-utils** — Zero deps
- `json_format`: Pretty-print or minify JSON
- `json_query`: Extract value at dot-path (e.g. `data.users[0].name`)
- `json_diff`: Compare two JSON objects, report differences

### Registry (separate repos)

**notion** — `env: ["NOTION_API_KEY"]`
- `notion_search`: Search pages/databases
- `notion_read_page`: Read page content as markdown
- `notion_create_page`: Create new page in database

**google-calendar** — `env: ["GOOGLE_CALENDAR_API_KEY"]`
- `gcal_list_events`: List upcoming events
- `gcal_create_event`: Create calendar event
- `gcal_today`: Today's schedule summary

**spotify** — `env: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]`
- `spotify_now_playing`: Current playback info
- `spotify_search`: Search tracks/artists/albums
- `spotify_play`: Play a track/playlist

**home-assistant** — `env: ["HA_URL", "HA_TOKEN"]`
- `ha_states`: List entity states
- `ha_toggle`: Toggle entity on/off
- `ha_call_service`: Call any HA service

## Parallelization

Wave 1 (all parallel):
- A: CONTRIBUTING.md update
- B: 2 bundled skills
- C: Marketplace backend
- D: Marketplace frontend

Wave 2 (sequential):
- E: 4 registry skill repos + registry.json update

Final: mandatory reviews (simplify + security + code-review)

## Success Criteria

- `npm test` passes with new bundled skill tests
- `npm run typecheck` clean
- Web portal marketplace tab shows registry skills
- Install from marketplace clones skill to `~/.strada/skills/`
- CONTRIBUTING.md has complete skill authoring guide
- 4 registry repos created with working skills
