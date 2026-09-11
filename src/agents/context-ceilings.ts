/**
 * Learned context ceilings — the window a provider actually answers within.
 *
 * A provider declares one window (OpenCode: 128k) and the free tier stops
 * answering well below it (measured 2026-09-09: a 57k-token turn hung twice
 * for 600 s after 41–47k turns answered in under a minute). Until 2026-09-10
 * the only fix was an env variable the operator had to know about
 * (OPENCODE_CONTEXT_WINDOW; report #37). Now a hard-timeout at N observed
 * tokens records a ceiling of 0.8 × N for that provider, the compaction
 * planner plans against min(declared, learned), and the ceiling is persisted
 * beside provider-health.json so a restart does not relearn it by hanging
 * again. `strada status` prints what was learned.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalizeProviderName } from "./providers/provider-identity.js";

export const CONTEXT_CEILING_MIN_TOKENS = 8_192;
export const CONTEXT_CEILING_SHRINK = 0.8;
export const CONTEXT_CEILINGS_FILE = "context-ceilings.json";

interface CeilingRecord {
  ceiling: number;
  observedTokens: number;
  learnedAt: number;
}

const ceilings = new Map<string, CeilingRecord>();
let storePath: string | null = null;
let loaded = false;

/**
 * One key per provider whatever name a call site holds: the timeout path
 * records the provider's display name ("OpenCode (Zen/Go)"), the compaction
 * planner asks by assignment name ("opencode") — lowercasing alone kept them
 * apart and the ceiling was never consulted (Codex 2026-09-11 #5).
 */
export function ceilingKey(provider: string): string {
  return canonicalizeProviderName(provider) ?? provider.trim().toLowerCase();
}
function norm(provider: string): string {
  return ceilingKey(provider);
}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  if (!storePath) return;
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, Partial<CeilingRecord>>;
    for (const [name, rec] of Object.entries(raw)) {
      if (typeof rec?.ceiling === "number" && rec.ceiling >= CONTEXT_CEILING_MIN_TOKENS) {
        ceilings.set(norm(name), {
          ceiling: rec.ceiling,
          observedTokens: typeof rec.observedTokens === "number" ? rec.observedTokens : rec.ceiling,
          learnedAt: typeof rec.learnedAt === "number" ? rec.learnedAt : 0,
        });
      }
    }
  } catch {
    /* no file, or unreadable — start empty */
  }
}

function save(): void {
  if (!storePath) return;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(ceilings), null, 2));
    renameSync(tmp, storePath);
  } catch {
    /* persistence is best effort; the in-process ceiling still applies */
  }
}

/** Where ceilings persist; set once at boot next to provider-health.json. */
export function configureContextCeilingStore(path: string | null): void {
  storePath = path;
  loaded = false;
  ceilings.clear();
}

/** Read the same store without touching this process's map (for `strada status`). */
export function readContextCeilings(path: string): Record<string, CeilingRecord> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Partial<CeilingRecord>>;
    const out: Record<string, CeilingRecord> = {};
    for (const [name, rec] of Object.entries(raw)) {
      if (typeof rec?.ceiling === "number") out[name] = { ceiling: rec.ceiling, observedTokens: rec.observedTokens ?? rec.ceiling, learnedAt: rec.learnedAt ?? 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A turn of `observedTokens` hung past the hard ceiling: the provider's
 * usable window is below that. Returns the ceiling now in force, or undefined
 * when the observation was empty or an earlier ceiling is already lower.
 */
export function recordContextCeiling(provider: string, observedTokens: number, now = Date.now()): number | undefined {
  loadOnce();
  if (!Number.isFinite(observedTokens) || observedTokens <= 0) return undefined;
  const next = Math.max(CONTEXT_CEILING_MIN_TOKENS, Math.floor(observedTokens * CONTEXT_CEILING_SHRINK));
  const key = norm(provider);
  const prev = ceilings.get(key);
  if (prev && prev.ceiling <= next) return undefined;
  ceilings.set(key, { ceiling: next, observedTokens: Math.floor(observedTokens), learnedAt: now });
  save();
  return next;
}

/** min(declared, learned) with the learned value named when it is the one in force. */
export function effectiveContextWindow(provider: string, declared: number): { window: number; learned?: number } {
  loadOnce();
  const rec = ceilings.get(norm(provider));
  if (!rec || rec.ceiling >= declared) return { window: declared };
  return { window: rec.ceiling, learned: rec.ceiling };
}

export function learnedContextCeilings(): Record<string, CeilingRecord> {
  loadOnce();
  return Object.fromEntries(ceilings);
}
