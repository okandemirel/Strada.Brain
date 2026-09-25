/**
 * One asynchronous walk of a project directory, replayed by the synchronous
 * checks that used to walk it themselves.
 *
 * The delivery measurement and the conformance gates each walked Unity's
 * Assets/ tree with readdirSync/statSync — tens of thousands of synchronous
 * syscalls on the event loop that serves every channel, repeated by every
 * rule (audited 2026-09-25: an imported asset pack stalled the daemon for
 * seconds per completion draft and per `measure=1` request). The walk now
 * happens here, with fs.promises, and a check that needs a listing replays the
 * recorded directories with its own match, budget and visit cap. The replay
 * runs the same stack walk the synchronous walkers run, over the same readdir
 * order, so it returns the same files and the same truncation verdicts; a
 * directory the snapshot did not record is read synchronously, as before.
 */

import { promises as fsp, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** How an entry resolves: a symlink is recorded with what it points at. */
type EntryKind = "dir" | "file" | "link-dir" | "link-file" | "link-broken";

interface TreeEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

export interface ReplayOptions {
  /** How many MATCHING files the walk may return. */
  readonly budget: number;
  /** How many directory entries the walk may visit. */
  readonly visitCap: number;
  /**
   * true: the readdir + statSync walkers — symlinks are followed, and an entry
   * stat cannot resolve is skipped. false: the Dirent walkers — a symlink is a
   * file, never descended into.
   */
  readonly followLinks: boolean;
}

export interface ReplayResult {
  readonly files: string[];
  /** Directories were left unread (budget or visit cap). */
  readonly truncated: boolean;
  /** The walk stopped on the visit cap with directories still unread. */
  readonly visitCapHit: boolean;
}

function readEntriesSync(dir: string): TreeEntry[] | null {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return dirents.map((d) => {
    if (!d.isSymbolicLink()) return { name: d.name, kind: d.isDirectory() ? "dir" : "file" };
    try {
      return { name: d.name, kind: statSync(join(dir, d.name)).isDirectory() ? "link-dir" : "link-file" };
    } catch {
      return { name: d.name, kind: "link-broken" };
    }
  });
}

async function readEntries(dir: string): Promise<TreeEntry[] | null> {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const out: TreeEntry[] = [];
  for (const d of dirents) {
    if (!d.isSymbolicLink()) {
      out.push({ name: d.name, kind: d.isDirectory() ? "dir" : "file" });
      continue;
    }
    try {
      out.push({ name: d.name, kind: (await fsp.stat(join(dir, d.name))).isDirectory() ? "link-dir" : "link-file" });
    } catch {
      out.push({ name: d.name, kind: "link-broken" });
    }
  }
  return out;
}

export class TreeSnapshot {
  constructor(
    readonly root: string,
    private readonly dirs: ReadonlyMap<string, readonly TreeEntry[] | null>,
  ) {}

  /** The synchronous stack walk, over the recorded directories. */
  replay(dir: string, match: ((file: string) => boolean) | undefined, opts: ReplayOptions): ReplayResult {
    const out: string[] = [];
    const stack = [dir];
    let visited = 0;
    while (stack.length > 0 && out.length < opts.budget && visited < opts.visitCap) {
      const current = stack.pop()!;
      const recorded = this.dirs.get(current);
      const entries = recorded === undefined ? readEntriesSync(current) : recorded;
      if (entries === null) continue;
      for (const entry of entries) {
        visited++;
        const full = join(current, entry.name);
        if (opts.followLinks && entry.kind === "link-broken") continue;
        const isDir = entry.kind === "dir" || (opts.followLinks && entry.kind === "link-dir");
        if (isDir) stack.push(full);
        else if (!match || match(full)) out.push(full);
      }
    }
    return { files: out, truncated: stack.length > 0, visitCapHit: stack.length > 0 && visited >= opts.visitCap };
  }
}

/**
 * Record `root` with fs.promises, in the order the synchronous walkers visit
 * it, until `visitCap` entries were seen. Every readdir is awaited, so the
 * event loop is served between directories.
 */
export async function snapshotTree(root: string, visitCap: number): Promise<TreeSnapshot> {
  const dirs = new Map<string, TreeEntry[] | null>();
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < visitCap) {
    const current = stack.pop()!;
    const entries = await readEntries(current);
    dirs.set(current, entries);
    if (entries === null) continue;
    for (const entry of entries) {
      visited++;
      if (entry.kind === "dir" || entry.kind === "link-dir") stack.push(join(current, entry.name));
    }
  }
  return new TreeSnapshot(root, dirs);
}

/**
 * Read many files with fs.promises, a few at a time, handing each one's text
 * to `use` as it arrives (so a census can keep what it needs and drop the
 * rest). An unreadable file is passed as null.
 */
export async function forEachFileText(
  files: readonly string[],
  use: (file: string, text: string | null) => void,
  concurrency = 16,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++]!;
      let text: string | null;
      try {
        text = await fsp.readFile(file, "utf8");
      } catch {
        text = null;
      }
      use(file, text);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}

/** readFileSync, answered from `cache` when the text was read ahead. */
export function cachedReadFile(cache: ReadonlyMap<string, string> | undefined, file: string): string {
  const hit = cache?.get(file);
  return hit !== undefined ? hit : readFileSync(file, "utf-8");
}
