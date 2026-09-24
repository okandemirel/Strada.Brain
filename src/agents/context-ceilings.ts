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
/**
 * A learned ceiling is evidence about one model on one day, not a permanent fact: it lapses
 * after a week. A ceiling that never expired, learned from one stalled call, shredded every
 * session on that provider to ~8k tokens until an operator deleted the file.
 */
export const CONTEXT_CEILING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A hang on a prompt that is small for the declared window says more about the network or
 * the provider's day than about the window, so it teaches nothing. (The measured case this
 * module exists for, 57k of 128k, is 45%.)
 */
export const CONTEXT_CEILING_MIN_PROMPT_SHARE = 0.25;

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
/** Providers whose display name and configured name are the same seat. */
const CEILING_ALIASES: ReadonlyMap<string, string> = new Map([
  ["claude", "anthropic"],
  ["anthropic", "anthropic"],
  ["gpt", "openai"],
  ["codex", "openai"],
]);

/**
 * Ceilings are per provider AND model: one provider serves models with windows from 8k to 1M,
 * and a ceiling learned on one applied to all of them. A call site without a model reads and
 * writes the provider-level key.
 */
export function ceilingKey(provider: string, model?: string): string {
  const canonical = canonicalizeProviderName(provider) ?? provider.trim().toLowerCase();
  // canonicalizeProviderName treats "claude" and "anthropic" as two canonical
  // names, so a ceiling recorded under one was never read under the other
  // (Codex 2026-09-11 C#35).
  const providerKey = CEILING_ALIASES.get(canonical) ?? canonical;
  const modelKey = model?.trim().toLowerCase();
  return modelKey ? `${providerKey}/${modelKey}` : providerKey;
}
function norm(stored: string): string {
  const slash = stored.indexOf("/");
  return slash < 0 ? ceilingKey(stored) : ceilingKey(stored.slice(0, slash), stored.slice(slash + 1));
}

/** The record in force for `key`, dropping it once it has lapsed. */
function live(key: string, now: number): CeilingRecord | undefined {
  const rec = ceilings.get(key);
  if (!rec) return undefined;
  if (now - rec.learnedAt <= CONTEXT_CEILING_TTL_MS) return rec;
  ceilings.delete(key);
  save();
  return undefined;
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

export interface CeilingScope {
  /** The model the call was planned for; ceilings are kept per provider and model. */
  readonly model?: string;
  /** The window the provider declares; a hang on a prompt small for it teaches nothing. */
  readonly declaredWindow?: number;
}

/**
 * A turn of `observedTokens` hung past the hard ceiling: the provider's
 * usable window is below that. Returns the ceiling now in force, or undefined
 * when the observation was empty, too small for the declared window to mean
 * anything, or an earlier ceiling is already lower.
 */
export function recordContextCeiling(
  provider: string,
  observedTokens: number,
  now = Date.now(),
  scope: CeilingScope = {},
): number | undefined {
  loadOnce();
  if (!Number.isFinite(observedTokens) || observedTokens <= 0) return undefined;
  if (scope.declaredWindow && observedTokens < scope.declaredWindow * CONTEXT_CEILING_MIN_PROMPT_SHARE) return undefined;
  const next = Math.max(CONTEXT_CEILING_MIN_TOKENS, Math.floor(observedTokens * CONTEXT_CEILING_SHRINK));
  const key = ceilingKey(provider, scope.model);
  const prev = live(key, now);
  if (prev && prev.ceiling <= next) return undefined;
  ceilings.set(key, { ceiling: next, observedTokens: Math.floor(observedTokens), learnedAt: now });
  save();
  return next;
}

/**
 * The provider just answered a prompt of `answeredTokens`. A ceiling below that was wrong, or
 * the provider has recovered; either way it no longer holds, so it is dropped rather than
 * left to shrink every later session.
 */
export function noteContextAnswered(
  provider: string,
  answeredTokens: number,
  scope: CeilingScope = {},
  now = Date.now(),
): void {
  loadOnce();
  const key = ceilingKey(provider, scope.model);
  const rec = live(key, now);
  if (!rec || !Number.isFinite(answeredTokens) || answeredTokens <= rec.ceiling) return;
  ceilings.delete(key);
  save();
}

/** min(declared, learned) with the learned value named when it is the one in force. */
export function effectiveContextWindow(
  provider: string,
  declared: number,
  scope: CeilingScope = {},
  now = Date.now(),
): { window: number; learned?: number } {
  loadOnce();
  const rec = live(ceilingKey(provider, scope.model), now);
  if (!rec || rec.ceiling >= declared) return { window: declared };
  return { window: rec.ceiling, learned: rec.ceiling };
}

export function learnedContextCeilings(): Record<string, CeilingRecord> {
  loadOnce();
  return Object.fromEntries(ceilings);
}
