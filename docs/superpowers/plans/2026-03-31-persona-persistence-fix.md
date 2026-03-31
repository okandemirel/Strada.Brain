# Persona Persistence Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 bugs that prevent persona/personality from persisting after onboarding and from web portal settings changes.

**Architecture:** Two persona systems exist — global `SoulLoader` (in-memory, volatile) and per-user `UserProfileStore` (SQLite, persistent). They are disconnected. Fix: make tools write per-user only (no global mutation), make portal send `chatId` for per-user persistence, make dashboard `GET /api/personality` support per-user overlay, and add system prompt instructions so the AI actually calls persona tools after onboarding.

**Tech Stack:** TypeScript, Node.js, React, SQLite, Zod

---

### Task 1: Add Personality Management Section to System Prompt

The AI has `create_personality` and `switch_personality` tools but the system prompt never mentions them. After onboarding, the welcome message invites persona preferences but the AI processes the response as a normal chat — never calling the tools.

**Files:**
- Modify: `src/agents/context/strada-knowledge.ts:244-301`

- [ ] **Step 1: Add Personality Management section to `buildCapabilityManifest()`**

In `src/agents/context/strada-knowledge.ts`, insert the following section after the "Security Awareness" section (after line 283, before "Proactive Behaviors"):

```typescript
### Personality Management
You can customize your personality via two tools:
- \`switch_personality\`: Switch to any available profile (built-in: casual, formal, minimal, default;
  or any custom profile previously created). Use when the user requests a tone/style change that
  matches an existing profile.
- \`create_personality\`: Create a brand-new custom personality profile with a name and full markdown
  content describing identity, communication style, and personality traits. Use when the user
  describes a persona that doesn't match any existing profile (e.g., "be like Jarvis",
  "act as a strict code reviewer", "daha samimi ol").

**IMPORTANT — Post-Onboarding Rule:**
When the very first user message after the setup welcome contains persona or style preferences
(e.g., "be formal", "call yourself Nova", "Jarvis gibi ol"), you MUST call \`create_personality\`
or \`switch_personality\` to persist the preference. Do NOT just adapt your tone in-context —
the user expects their choice to survive across sessions. If they describe a custom persona,
call \`create_personality\`. If they name a built-in profile, call \`switch_personality\`.
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/agents/context/strada-knowledge.ts
git commit -m "feat(persona): add personality management section to system prompt capability manifest"
```

---

### Task 2: Make `switch_personality` Support Custom Profiles + Per-User Persistence

Currently hardcoded to 4 profiles and calls global `soulLoader.switchProfile()`. Fix: validate against SoulLoader's full profile list, persist per-user via `UserProfileStore`, remove global mutation.

**Files:**
- Modify: `src/agents/tools/switch-personality.ts`

- [ ] **Step 1: Rewrite switch-personality.ts**

Replace the entire contents of `src/agents/tools/switch-personality.ts` with:

```typescript
/**
 * Switch Personality Tool — runtime personality profile switching.
 *
 * Supports built-in profiles (casual, formal, minimal, default) AND custom profiles.
 * Persists per-user via UserProfileStore (SQLite) — no global SoulLoader mutation.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import { getLogger } from "../../utils/logger.js";

interface SoulLoaderLike {
  getProfiles(): string[];
  getProfileContent(name: string): Promise<string | null>;
}

interface UserProfileStoreLike {
  setActivePersona(chatId: string, persona: string): void;
}

function hasSoulLoader(ctx: ToolContext): ctx is ToolContext & { soulLoader: SoulLoaderLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.soulLoader != null &&
    typeof (record.soulLoader as Record<string, unknown>).getProfiles === "function" &&
    typeof (record.soulLoader as Record<string, unknown>).getProfileContent === "function"
  );
}

function hasUserProfileStore(ctx: ToolContext): ctx is ToolContext & { userProfileStore: UserProfileStoreLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.userProfileStore != null &&
    typeof (record.userProfileStore as Record<string, unknown>).setActivePersona === "function"
  );
}

export class SwitchPersonalityTool implements ITool {
  readonly name = "switch_personality";
  readonly description =
    "Switch the agent's personality profile. Supports built-in profiles (casual, formal, minimal, default) " +
    "and any custom profiles previously created via create_personality. " +
    "Use when the user asks you to change your tone or communication style.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      profile: {
        type: "string",
        description: "The personality profile name to switch to.",
      },
    },
    required: ["profile"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const logger = getLogger();
    const profile = String(input.profile ?? "").toLowerCase().trim();

    if (!profile) {
      return {
        content: "Profile name is required.",
        isError: true,
      };
    }

    if (!hasSoulLoader(context)) {
      return {
        content: `Personality switched to "${profile}" mode. (Note: hot-switch requires restart to take full effect.)`,
      };
    }

    // Validate the profile exists (built-in or custom)
    const available = context.soulLoader.getProfiles();
    if (!available.includes(profile)) {
      return {
        content: `Unknown profile "${profile}". Available: ${available.join(", ")}`,
        isError: true,
      };
    }

    // Verify the profile content is readable
    const content = profile === "default" ? "ok" : await context.soulLoader.getProfileContent(profile);
    if (!content && profile !== "default") {
      return {
        content: `Profile "${profile}" is listed but its content could not be loaded.`,
        isError: true,
      };
    }

    // Persist per-user via UserProfileStore (SQLite — survives restarts)
    if (hasUserProfileStore(context) && context.chatId) {
      try {
        context.userProfileStore.setActivePersona(context.chatId, profile);
      } catch {
        // Non-fatal — log and continue
      }
    }

    logger.info("Personality switched (per-user)", { profile, chatId: context.chatId });
    return {
      content: `Personality switched to "${profile}" mode. My responses will now reflect this style.`,
    };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Run switch-personality tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/agents/tools/switch-personality.test.ts 2>&1 | tail -30`
Expected: Tests may need updating — if they fail, fix assertions to match new behavior (dynamic profile list instead of hardcoded enum).

- [ ] **Step 4: Commit**

```bash
git add src/agents/tools/switch-personality.ts
git commit -m "fix(persona): switch_personality supports custom profiles + per-user persistence"
```

---

### Task 3: Fix `create_personality` Global Mutation

`create_personality` calls `soulLoader.switchProfile()` (global mutation) after saving. Fix: remove the global switch, rely on per-user `setActivePersona` which already exists.

**Files:**
- Modify: `src/agents/tools/create-personality.ts:125-137`

- [ ] **Step 1: Remove global switchProfile call, add getProfileContent validation**

In `src/agents/tools/create-personality.ts`, replace lines 125-137 (the "Activate immediately" block) with:

```typescript
    // Verify the saved profile is readable
    const verification = await context.soulLoader.getProfileContent(name);
    if (!verification) {
      logger.warn("Create personality saved but content not readable", {
        name,
        chatId: context.chatId,
      });
      return {
        content:
          `Profile "${name}" saved but could not be verified. ` +
          `Try switching to it with: "switch to ${name} persona".`,
      };
    }
```

Also update the `SoulLoaderLike` interface (lines 16-19) to include `getProfileContent`:

```typescript
interface SoulLoaderLike {
  saveProfile(name: string, content: string): Promise<boolean>;
  getProfileContent(name: string): Promise<string | null>;
}
```

And update `hasSoulLoader` (lines 25-32) to check for `getProfileContent` instead of `switchProfile`:

```typescript
function hasSoulLoader(ctx: ToolContext): ctx is ToolContext & { soulLoader: SoulLoaderLike } {
  const record = ctx as unknown as Record<string, unknown>;
  return (
    record.soulLoader != null &&
    typeof (record.soulLoader as Record<string, unknown>).saveProfile === "function" &&
    typeof (record.soulLoader as Record<string, unknown>).getProfileContent === "function"
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/agents/tools/create-personality.ts
git commit -m "fix(persona): create_personality uses per-user persistence, no global mutation"
```

---

### Task 4: Add `setActivePersona` to Dashboard Interface + Per-User GET

The dashboard `GET /api/personality` always returns the global `SoulLoader.activeProfile`. Fix: accept optional `chatId` query param, return per-user `activePersona` from `UserProfileStore` if available.

Also: the `DashboardUserProfileStore` interface doesn't expose `setActivePersona` or `getProfile.activePersona` — the switch endpoint casts through `unknown`. Fix the interface.

**Files:**
- Modify: `src/dashboard/server.ts:374-378` (interface)
- Modify: `src/dashboard/server.ts:1414-1431` (GET endpoint)
- Modify: `src/dashboard/server.ts:1527-1542` (switch endpoint cleanup)

- [ ] **Step 1: Extend `DashboardUserProfileStore` interface**

In `src/dashboard/server.ts`, replace the interface at lines 374-378:

```typescript
/** Structural interface for user profile store used by dashboard /api/user endpoints */
interface DashboardUserProfileStore {
  getProfile?(chatId: string): { preferences: Record<string, unknown>; activePersona?: string } | null;
  setActivePersona?(chatId: string, persona: string): void;
  setAutonomousMode(chatId: string, enabled: boolean, expiresAt?: number): Promise<void>;
  isAutonomousMode(chatId: string): Promise<{ enabled: boolean; expiresAt?: number; remainingMs?: number }>;
}
```

- [ ] **Step 2: Update GET /api/personality to support per-user overlay**

In `src/dashboard/server.ts`, replace lines 1414-1431 with:

```typescript
      // GET /api/personality -- Soul/personality info (supports ?chatId= for per-user overlay)
      if (url.startsWith("/api/personality") && !url.includes("/profiles") && !url.includes("/switch") && req.method === "GET") {
        if (!this.soulLoader) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ personality: null }));
          return;
        }

        let activeProfile = this.soulLoader.getActiveProfile();

        // Per-user overlay: if chatId provided, check UserProfileStore
        const parsedUrl = new URL(url, "http://localhost");
        const chatId = parsedUrl.searchParams.get("chatId");
        if (chatId && this.userProfileStore?.getProfile) {
          const profile = this.userProfileStore.getProfile(chatId);
          if (profile?.activePersona && profile.activePersona !== "default") {
            activeProfile = profile.activePersona;
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          personality: {
            content: this.soulLoader.getContent(),
            activeProfile,
            profiles: this.soulLoader.getProfiles(),
            channelOverrides: this.soulLoader.getChannelOverrides(),
          },
        }));
        return;
      }
```

- [ ] **Step 3: Clean up switch endpoint to use typed interface**

In `src/dashboard/server.ts`, replace the `userProfileStore` block at lines 1534-1541 with:

```typescript
            // Persist per-user persona
            if (parsed.chatId && this.userProfileStore?.setActivePersona) {
              try {
                this.userProfileStore.setActivePersona(parsed.chatId, profile);
              } catch { /* non-fatal — persona update is best-effort */ }
            }
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "fix(persona): dashboard supports per-user persona via chatId query + typed interface"
```

---

### Task 5: Portal PersonaSection — Send chatId on Switch

`PersonaSection.tsx` sends `{ profile }` without `chatId`. The `chatId` is available via `useWS()` hook (same pattern used by `ProvidersSection`).

**Files:**
- Modify: `web-portal/src/pages/settings/PersonaSection.tsx`

- [ ] **Step 1: Add chatId to switch request and personality query**

Replace the entire contents of `web-portal/src/pages/settings/PersonaSection.tsx` with:

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { usePersonality } from '../../hooks/use-api'
import { useWS } from '../../hooks/useWS'

export default function PersonaSection() {
  const { t } = useTranslation('settings')
  const { sessionId } = useWS()
  const { data, isLoading } = usePersonality(sessionId)
  const queryClient = useQueryClient()
  const [switching, setSwitching] = useState<string | null>(null)

  const switchProfile = async (profile: string) => {
    setSwitching(profile)
    try {
      const res = await fetch('/api/personality/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, chatId: sessionId }),
      })
      if (!res.ok) throw new Error('Failed to switch profile')
      toast.success(t('persona.toastSwitched', { profile }))
      queryClient.invalidateQueries({ queryKey: ['personality'] })
      queryClient.invalidateQueries({ queryKey: ['personality-profiles'] })
    } catch {
      toast.error(t('persona.toastSwitchFailed'))
    } finally {
      setSwitching(null)
    }
  }

  if (isLoading || !data) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('persona.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('persona.loading')}</p>
      </div>
    )
  }

  const personality = data.personality
  const activeProfile = personality?.activeProfile ?? null
  const profiles = personality?.profiles ?? []
  const channelOverrides = personality?.channelOverrides ?? {}
  const hasOverrides = Object.keys(channelOverrides).length > 0

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('persona.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('persona.description')}</p>

      {/* Active profile */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-text-tertiary mb-1">{t('persona.activeProfile')}</p>
            <p className="text-sm font-semibold text-accent">
              {activeProfile ?? t('persona.default')}
            </p>
          </div>
          <span className="w-2 h-2 rounded-full bg-green-400 ring-4 ring-green-400/20" />
        </div>
      </div>

      {/* Profiles list */}
      {profiles.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
            {t('persona.availableProfiles')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden mb-4">
            {profiles.map((profile, idx) => {
              const isActive = profile === activeProfile
              return (
                <div
                  key={profile}
                  className={`flex items-center justify-between px-4 py-3 ${idx < profiles.length - 1 ? 'border-b border-white/5' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    {isActive && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
                    <span className={`text-sm ${isActive ? 'text-text font-medium' : 'text-text-secondary'}`}>
                      {profile}
                    </span>
                    {isActive && (
                      <span className="text-xs text-text-tertiary">{t('persona.active')}</span>
                    )}
                  </div>
                  {!isActive && (
                    <button
                      onClick={() => switchProfile(profile)}
                      disabled={switching === profile}
                      className="px-3 py-1 text-xs bg-white/5 border border-white/10 text-text-secondary rounded-lg hover:border-accent/50 hover:text-accent transition-colors disabled:opacity-50"
                    >
                      {switching === profile ? t('persona.switching') : t('persona.switch')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Channel overrides */}
      {hasOverrides && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
            {t('persona.channelOverrides')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden mb-4">
            {Object.entries(channelOverrides).map(([channel, profile], idx, arr) => (
              <div
                key={channel}
                className={`flex items-center justify-between px-4 py-3 ${idx < arr.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <span className="text-sm text-text-secondary capitalize">{channel}</span>
                <span className="text-sm text-accent">{profile}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {profiles.length === 0 && !personality?.content && (
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 text-center">
          <p className="text-sm text-text-tertiary">{t('persona.noProfiles')}</p>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Update `usePersonality` hook to accept optional chatId**

In `web-portal/src/hooks/use-api.ts`, find the `usePersonality` function (around line 512) and replace it with:

```typescript
export function usePersonality(chatId?: string | null) {
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''
  return useQuery<PersonalityResponse>({
    queryKey: ['personality', chatId ?? 'global'],
    queryFn: () => fetchApi<PersonalityResponse>(`/api/personality${query}`),
    refetchInterval: false,
    refetchOnMount: 'always',
  })
}
```

- [ ] **Step 3: Verify TypeScript compiles (portal)**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/pages/settings/PersonaSection.tsx web-portal/src/hooks/use-api.ts
git commit -m "fix(portal): PersonaSection sends chatId for per-user persona persistence"
```

---

### Task 6: Portal PersonalityPage — Send chatId on Switch

Same issue as PersonaSection — `PersonalityPage.tsx` switch mutation doesn't include `chatId`.

**Files:**
- Modify: `web-portal/src/pages/PersonalityPage.tsx:33-40`

- [ ] **Step 1: Add useWS import and include chatId in switch mutation**

In `web-portal/src/pages/PersonalityPage.tsx`, add the import after line 4:

```typescript
import { useWS } from '../hooks/useWS'
```

Inside the component (after line 24, `const data = rawData?.personality ?? null`), add:

```typescript
  const { sessionId } = useWS()
```

Replace the `usePersonality()` call on line 24 to pass sessionId:

```typescript
  const { data: rawData, error: fetchError, isLoading } = usePersonality(sessionId)
```

Replace the switch mutation `body` (line 35) to include chatId:

```typescript
      const res = await fetch('/api/personality/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile, chatId: sessionId }) })
```

- [ ] **Step 2: Verify TypeScript compiles (portal)**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/pages/PersonalityPage.tsx
git commit -m "fix(portal): PersonalityPage sends chatId for per-user persona persistence"
```

---

### Task 7: Add `/api/personality` to Proxy Allowlist with Query Params

The WebChannel proxy currently matches `url === "/api/personality"` exactly. With the new `?chatId=` query param, the match logic in the proxy might need to handle query strings. Verify and fix if needed.

**Files:**
- Modify: `src/channels/web/channel.ts` (proxy allowlist matching logic)

- [ ] **Step 1: Verify proxy matching handles query params**

Read `src/channels/web/channel.ts` around line 992 (`proxyToDashboard`) to check how the URL is parsed. The `ALLOWED_PROXY_PATHS` check may use exact string match (`url === path`). If the proxy strips query params before matching (e.g., using `pathOnly`), no change is needed. If it uses the raw URL with query params, the `/api/personality` match will fail for `/api/personality?chatId=xxx`.

Check the proxy code. If `pathOnly` is already extracted from the URL before the allowlist check, no change is needed. If not, extract `pathOnly` before matching.

- [ ] **Step 2: Verify TypeScript compiles if any changes were made**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit if changes were needed**

```bash
git add src/channels/web/channel.ts
git commit -m "fix(web): proxy allowlist handles query params for personality endpoint"
```

---

### Task 8: Run Tests + TypeScript Verification

Final verification pass.

- [ ] **Step 1: Full TypeScript check (server)**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx tsc --noEmit --pretty 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 2: Full TypeScript check (portal)**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npx tsc --noEmit --pretty 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 3: Run personality-related tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run --reporter=verbose 2>&1 | grep -E "personality|persona|soul|switch" | head -30`
Expected: All related tests pass

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run 2>&1 | tail -20`
Expected: No new failures
