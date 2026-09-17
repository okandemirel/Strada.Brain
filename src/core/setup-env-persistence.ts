/**
 * Typed setup persistence: MERGE the wizard's output into the existing .env
 * instead of rewriting the whole file (plan 2.1, audit 10.1b / D24, D29-D30).
 *
 * Save used to replace `.env` wholesale, deleting every key a person added by
 * hand. `persistSetup` now:
 *   - replaces, in place, the keys the wizard submitted (quoting kept as
 *     generated, position and surrounding comments kept as they were);
 *   - removes wizard-OWNED keys the wizard no longer emits (a de-selected
 *     provider key, a switched-off budget) so a stale selection cannot outlive
 *     the choice that produced it;
 *   - writes wizard DEFAULT keys only when the file does not already carry a
 *     value (a hand-edited LOG_LEVEL survives a re-run of setup);
 *   - leaves every other line alone: unknown keys, comments, blank lines;
 *   - appends the keys that were not present under one header;
 *   - reads the file BACK from disk and returns the effective map, so the
 *     caller can show exactly what the runtime will load.
 *
 * Nothing here touches process.env.
 */

import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import * as dotenv from "dotenv";

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const ADDED_HEADER = "# Added by Strada.Brain Setup Wizard";

export interface EnvUpdateEntry {
  key: string;
  /** The full `KEY=value` line, exactly as it should appear in the file. */
  line: string;
}

export interface PersistSetupOptions {
  /**
   * Keys the wizard owns: when present in the file but absent from `lines`
   * they are removed. Every other key in the file is preserved verbatim.
   */
  ownedKeys: Iterable<string>;
  /**
   * Keys the wizard writes as defaults: written only when the file does not
   * already define them, so a hand-edited value is never reset.
   */
  defaultKeys?: Iterable<string>;
}

export interface MergeEnvResult {
  content: string;
  replaced: string[];
  added: string[];
  removed: string[];
  /** Keys in the file that the wizard did not touch (hand-added or defaults kept). */
  preserved: string[];
}

export interface PersistSetupResult extends MergeEnvResult {
  envPath: string;
  /** The .env as parsed back from disk after the write. */
  effective: Record<string, string>;
  /**
   * False when the bytes on disk right after this save's commit were NOT the
   * bytes this save committed — a writer that did not take the lock replaced
   * the file. `effective` then describes THIS save (round 9 #15), not the file.
   */
  diskMatchesCommit: boolean;
}

/** Split generated `KEY=value` lines into entries; comments and blanks are dropped. */
export function parseEnvLines(lines: readonly string[]): EnvUpdateEntry[] {
  const entries: EnvUpdateEntry[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = ENV_LINE_RE.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, line: line.trimEnd() });
  }
  return entries;
}

/**
 * Number of physical lines a value occupies when it is a multi-line quoted
 * value (`KEY="first\nsecond"`), so the block moves as one unit.
 */
function quotedBlockLength(lines: readonly string[], start: number, rest: string): number {
  const trimmed = rest.trim();
  const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : trimmed.startsWith("`") ? "`" : null;
  if (!quote) return 1;
  const body = trimmed.slice(1);
  const closesOnSameLine = new RegExp(`(?<!\\\\)${quote}`).test(body);
  if (closesOnSameLine) return 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (new RegExp(`(?<!\\\\)${quote}`).test(lines[i]!)) {
      return i - start + 1;
    }
  }
  return 1;
}

export function mergeEnvContent(
  existing: string,
  updates: readonly EnvUpdateEntry[],
  options: PersistSetupOptions,
): MergeEnvResult {
  const owned = new Set(options.ownedKeys);
  const defaults = new Set(options.defaultKeys ?? []);
  const pending = new Map(updates.map((entry) => [entry.key, entry.line] as const));

  const replaced: string[] = [];
  const removed: string[] = [];
  const preserved: string[] = [];
  const out: string[] = [];

  const sourceLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  // A trailing newline yields one empty final element; drop it so we do not
  // accumulate blank lines on every save.
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === "") {
    sourceLines.pop();
  }

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i]!;
    const match = ENV_LINE_RE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const key = match[1]!;
    const span = quotedBlockLength(sourceLines, i, match[2] ?? "");
    const skipBlock = (): void => { i += span - 1; };

    if (pending.has(key)) {
      if (defaults.has(key)) {
        // A default the file already defines: keep the person's value.
        pending.delete(key);
        preserved.push(key);
        out.push(...sourceLines.slice(i, i + span));
        skipBlock();
        continue;
      }
      out.push(pending.get(key)!);
      pending.delete(key);
      replaced.push(key);
      skipBlock();
      continue;
    }
    if (replaced.includes(key)) {
      // A later duplicate of a key we already rewrote: drop it so the
      // rewritten value is the one dotenv reads (last wins).
      skipBlock();
      continue;
    }
    if (owned.has(key) && !defaults.has(key)) {
      removed.push(key);
      skipBlock();
      continue;
    }
    preserved.push(key);
    out.push(...sourceLines.slice(i, i + span));
    skipBlock();
  }

  const added = [...pending.keys()];
  if (added.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push(ADDED_HEADER);
    for (const key of added) out.push(pending.get(key)!);
  }

  return {
    content: out.length > 0 ? out.join("\n") + "\n" : "",
    replaced,
    added,
    removed,
    preserved,
  };
}

/**
 * Merge `lines` (the wizard's generated `KEY=value` lines, comments allowed)
 * into the .env at `envPath`, write it, and read the effective map back.
 * A missing or empty file is written from `lines` verbatim so a first run
 * keeps the generated section headers.
 */
/** Distinct temp names even inside one millisecond, for saves of different files. */
let tmpCounter = 0;

/** One save at a time per file: a readback must describe the save it belongs to (round 8 #10). */
const saveChains = new Map<string, Promise<unknown>>();

/**
 * CROSS-PROCESS SAVE LOCK (round 9 #15).
 *
 * The chain above only orders saves inside ONE process. A CLI `strada setup`
 * and the portal's Save (or two daemons) both read the file, both merge into
 * what they read, and the second rename wins: the first save's keys are gone,
 * and its readback described the other process's file. Both are serialized by
 * an O_EXCL lock file beside the .env — the kernel decides who wins, once.
 */
export const ENV_SAVE_LOCK = {
  /** How long to wait for another process's save before refusing this one. */
  timeoutMs: 15_000,
  /** Poll interval while another process holds the lock. */
  retryMs: 25,
  /** A lock this old — or one whose owning process is gone — is broken. */
  staleMs: 30_000,
};

interface EnvSaveLock {
  lockPath: string;
  /** Exactly what we wrote, so release only ever removes OUR lock. */
  body: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove a lock nobody can still be holding: its owner died on this host, or
 * it is older than `staleMs`. Returns true when the lock is (or already was)
 * gone, so the caller should try to take it again immediately.
 */
async function breakAbandonedLock(lockPath: string): Promise<boolean> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await readFile(lockPath, "utf-8");
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    // It vanished while we looked: the next O_EXCL attempt is the answer.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  let owner: { pid?: number; host?: string } = {};
  try {
    owner = JSON.parse(raw) as typeof owner;
  } catch {
    // Unreadable lock file: age alone decides.
  }
  const ownerGone = typeof owner.pid === "number" && owner.host === hostname() && !isProcessAlive(owner.pid);
  const tooOld = Date.now() - mtimeMs > ENV_SAVE_LOCK.staleMs;
  if (!ownerGone && !tooOld) return false;
  try {
    // Break the very lock we judged, never a fresh one someone else just took.
    if ((await readFile(lockPath, "utf-8")) === raw) await unlink(lockPath);
  } catch {
    // Someone else broke or replaced it first.
  }
  return true;
}

async function acquireEnvSaveLock(envPath: string): Promise<EnvSaveLock> {
  const lockPath = `${envPath}.lock`;
  const body = JSON.stringify({
    token: randomBytes(8).toString("hex"),
    pid: process.pid,
    host: hostname(),
    envPath,
    startedAt: Date.now(),
  });
  const deadline = Date.now() + ENV_SAVE_LOCK.timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      return { lockPath, body };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await breakAbandonedLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(
        `Another process is still saving ${envPath} (${lockPath} held for over ${ENV_SAVE_LOCK.timeoutMs} ms). Nothing was written.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ENV_SAVE_LOCK.retryMs));
  }
}

async function releaseEnvSaveLock(lock: EnvSaveLock): Promise<void> {
  try {
    if ((await readFile(lock.lockPath, "utf-8")) === lock.body) await unlink(lock.lockPath);
  } catch {
    // Already gone (broken as stale, or removed by hand): nothing to release.
  }
}

export async function persistSetup(
  envPath: string,
  lines: readonly string[],
  options: PersistSetupOptions,
): Promise<PersistSetupResult> {
  const previous = saveChains.get(envPath) ?? Promise.resolve();
  const mine = previous.then(
    () => persistSetupOnce(envPath, lines, options),
    () => persistSetupOnce(envPath, lines, options),
  );
  saveChains.set(envPath, mine.catch(() => undefined));
  return mine;
}

/** Read, merge, commit and read back with the cross-process lock held. */
async function persistSetupOnce(
  envPath: string,
  lines: readonly string[],
  options: PersistSetupOptions,
): Promise<PersistSetupResult> {
  const lock = await acquireEnvSaveLock(envPath);
  try {
    return await persistSetupLocked(envPath, lines, options);
  } finally {
    await releaseEnvSaveLock(lock);
  }
}

async function persistSetupLocked(
  envPath: string,
  lines: readonly string[],
  options: PersistSetupOptions,
): Promise<PersistSetupResult> {
  let existing = "";
  try {
    existing = await readFile(envPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const entries = parseEnvLines(lines);
  let merge: MergeEnvResult;
  if (existing.trim().length === 0) {
    merge = {
      content: lines.join("\n") + "\n",
      replaced: [],
      added: entries.map((entry) => entry.key),
      removed: [],
      preserved: [],
    };
  } else {
    merge = mergeEnvContent(existing, entries, options);
  }

  // ATOMIC (round 8 #10): writeFile truncates first, so a daemon reading in
  // that instant saw an empty or half-written .env. The content goes to a temp
  // file beside the target and is renamed over it.
  const tmpPath = `${envPath}.${process.pid}.${Date.now()}.${(tmpCounter += 1)}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmpPath, merge.content, { encoding: "utf-8", mode: 0o600 });
  await rename(tmpPath, envPath);
  // ATTRIBUTION (round 9 #15): the readback happens with the lock still held,
  // so it is this save's own file. Should the bytes differ anyway — a writer
  // that ignored the lock — the result still describes THIS save rather than
  // reporting someone else's configuration as ours, and says so.
  let onDisk: string | null = null;
  try {
    onDisk = await readFile(envPath, "utf-8");
  } catch {
    onDisk = null;
  }
  const diskMatchesCommit = onDisk === merge.content;
  const effective = dotenv.parse(diskMatchesCommit ? onDisk! : merge.content);
  return { envPath, effective, diskMatchesCommit, ...merge };
}

const SECRET_KEY_RE = /(API_KEY|_TOKEN|_SECRET|PASSWORD|AUTH_TOKEN)$/;

/**
 * Effective config safe to hand back over HTTP.
 *
 * An ALLOWLIST, not a secret-name pattern: the readback returned the VALUES of
 * every key the merge preserved, so a hand-added DATABASE_URL with its
 * password, a PRIVATE_KEY or an AWS_SECRET_ACCESS_KEY came back in the Save
 * response (Codex 2026-09-17 round 8 #11). A key the wizard owns is shown
 * (its own secrets still reduced to a marker); anything else is reported as
 * present only.
 */
export function redactEffectiveConfig(
  effective: Record<string, string>,
  shownKeys?: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(effective)) {
    if (shownKeys !== undefined && !shownKeys.has(key)) {
      out[key] = value.length > 0 ? "<set>" : "";
      continue;
    }
    out[key] = SECRET_KEY_RE.test(key) && value.length > 0 ? "<set>" : value;
  }
  return out;
}

export interface EffectiveBudget {
  /** null when no limit is configured. */
  dailyUsd: number | null;
  unlimited: boolean;
  /** What the person should read: "$0.00" for an explicit zero, "unlimited" only for no limit. */
  display: string;
}

/**
 * A global budget of 0 is "no limit" only when the person chose unlimited —
 * that choice is persisted as the ABSENCE of STRADA_BUDGET_DAILY_USD. A
 * written 0 means zero and is shown as such.
 */
export function describeEffectiveBudget(effective: Record<string, string>): EffectiveBudget {
  const raw = effective["STRADA_BUDGET_DAILY_USD"]?.trim();
  if (raw === undefined || raw === "") {
    return { dailyUsd: null, unlimited: true, display: "unlimited" };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { dailyUsd: null, unlimited: true, display: "unlimited" };
  }
  return { dailyUsd: value, unlimited: false, display: `$${value.toFixed(2)}` };
}
