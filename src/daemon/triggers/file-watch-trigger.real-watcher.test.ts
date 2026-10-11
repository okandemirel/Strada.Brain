/**
 * FileWatchTrigger against the installed chokidar — no mock.
 *
 * chokidar 5 compares a string `ignored` entry to the path by equality, never
 * as a glob, so the strings this trigger used to hand it (its own
 * `**\/node_modules/**` defaults, the parser's "node_modules"/".git"/"*.d.ts",
 * every `ignore:` line) ignored nothing: a git commit or an npm install under
 * a watched root became a daemon task (audit daemon#0). The mocked suite only
 * checked that the strings were passed in, so it stayed green. These cases
 * write real files under a real watcher and read what the trigger buffered.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { FileWatchTrigger } from "./file-watch-trigger.js";
import { parseHeartbeatFile } from "../heartbeat-parser.js";
import type { FileWatchTriggerDef } from "../daemon-types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Long enough for a stray event written before the sentinel to be buffered too. */
const SETTLE_MS = 600;

const roots: string[] = [];
const triggers: FileWatchTrigger[] = [];

afterEach(async () => {
  await Promise.all(triggers.splice(0).map((t) => t.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTree(dirs: readonly string[], under?: string): string {
  const root = mkdtempSync(join(tmpdir(), "fwt-real-"));
  roots.push(root);
  const base = under ? join(root, under) : root;
  for (const dir of ["", ...dirs]) mkdirSync(join(base, dir), { recursive: true });
  return base;
}

function buffered(trigger: FileWatchTrigger): string[] {
  return trigger.getPendingEvents().map((e) => e.path);
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

/** The trigger exposes no "ready": write probes until one is delivered. */
async function untilWatching(trigger: FileWatchTrigger, dir: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const probe = join(dir, `probe-${i}.cs`);
    writeFileSync(probe, "probe");
    if (await waitUntil(() => buffered(trigger).includes(probe), 200)) return;
  }
  throw new Error(`watcher on ${dir} never delivered a probe`);
}

/** Write `ignoredFiles`, then `sentinel`; return what was buffered once things settle. */
async function writeAndCollect(
  trigger: FileWatchTrigger,
  root: string,
  ignoredFiles: readonly string[],
  sentinel: string,
): Promise<string[]> {
  for (const rel of ignoredFiles) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), "noise");
  }
  writeFileSync(join(root, sentinel), "real");
  const sentinelPath = join(root, sentinel);
  expect(await waitUntil(() => buffered(trigger).includes(sentinelPath), 10_000)).toBe(true);
  await sleep(SETTLE_MS);
  return buffered(trigger);
}

function watchFromHeartbeat(markdown: string, projectRoot: string): FileWatchTrigger {
  const [def] = parseHeartbeatFile(markdown) as FileWatchTriggerDef[];
  // stage-daemon hands the trigger an absolute path the same way.
  const trigger = new FileWatchTrigger({ ...def!, path: resolve(projectRoot, def!.path), debounce: 10 });
  triggers.push(trigger);
  return trigger;
}

describe("FileWatchTrigger — ignore patterns under the installed chokidar", () => {
  it("never buffers a .git, node_modules or *.d.ts write under the parser's default ignore list", async () => {
    const root = makeTree([".git/refs", "node_modules/pkg", "src"]);
    const trigger = watchFromHeartbeat(
      "### Watch project\n- type: file-watch\n- path: .\n- action: review the change\n",
      root,
    );
    expect(trigger).toBeDefined();
    await untilWatching(trigger, join(root, "src"));

    const seen = await writeAndCollect(
      trigger,
      root,
      [".git/index", ".git/refs/HEAD", "node_modules/pkg/b.js", "src/types.d.ts"],
      "src/real.ts",
    );

    const names = seen.map((p) => basename(p));
    expect(names).toContain("real.ts");
    expect(names.filter((n) => !n.startsWith("probe-") && n !== "real.ts")).toEqual([]);
  }, 30_000);

  it("honours an `ignore:` line's globs (*.meta, Library/**) and keeps the built-in .git and node_modules exclusions", async () => {
    const root = makeTree(["Library/Cache", "Assets/Scripts", ".git", "node_modules/pkg"]);
    const trigger = watchFromHeartbeat(
      "### Watch Unity\n- type: file-watch\n- path: .\n- ignore: *.meta, Library/**\n- action: check scripts\n",
      root,
    );
    await untilWatching(trigger, join(root, "Assets/Scripts"));

    const seen = await writeAndCollect(
      trigger,
      root,
      ["Library/Cache/a.bin", "Library/top.asset", "Assets/Scripts/Foo.cs.meta", ".git/HEAD", "node_modules/pkg/b.js"],
      "Assets/Scripts/Foo.cs",
    );

    const names = seen.map((p) => basename(p));
    expect(names).toContain("Foo.cs");
    expect(names.filter((n) => !n.startsWith("probe-") && n !== "Foo.cs")).toEqual([]);
  }, 30_000);

  it("judges patterns relative to the watch root, so a root inside a directory the list names is still watched", async () => {
    // A Unity project kept under ~/Library/... or a package checked out under
    // a node_modules tree: matching the absolute path would mute it whole.
    const root = makeTree(["Assets", "Library"], "node_modules/Library/Game");
    const trigger = new FileWatchTrigger({
      type: "file-watch",
      name: "game",
      action: "check",
      path: root,
      debounce: 10,
      ignore: ["Library/**", "node_modules"],
    });
    triggers.push(trigger);
    await untilWatching(trigger, join(root, "Assets"));

    const seen = await writeAndCollect(trigger, root, ["Library/cache.bin"], "Assets/Player.cs");

    const names = seen.map((p) => basename(p));
    expect(names).toContain("Player.cs");
    expect(names).not.toContain("cache.bin");
  }, 30_000);
});
