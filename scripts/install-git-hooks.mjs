#!/usr/bin/env node
/**
 * Installs versioned git hooks from scripts/git-hooks/ into the repository's
 * hooks directory.
 *
 * The directory is the one git itself names (`git rev-parse --git-path hooks`:
 * a worktree's common dir, or core.hooksPath), and it is created when absent.
 * It used to be `.git/hooks` taken on faith, with a silent no-op when that did
 * not exist — and a checkout cloned without templates has no `.git/hooks`, so
 * no hook was ever installed there and every guard in this directory was
 * inert. Outside a git checkout (CI tarball, npm dependency install) this is
 * still a no-op.
 *
 * pre-commit is always refreshed. pre-push is installed only over nothing or
 * over a copy of itself (it carries the `strada-brain:managed-hook` marker):
 * a pre-push hook someone wrote by hand is left alone, and the install says so.
 *
 * Under CI (`CI` set) nothing is installed: the CI job runs the same checks as
 * steps, and a hook there would also fire on the version-bump push, against a
 * shallow history it cannot read.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const MARKER = "strada-brain:managed-hook";

function hooksDirectory() {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return isAbsolute(out) ? out : resolve(repoRoot, out);
  } catch {
    return null; // not a git checkout, or no git — nothing to install into
  }
}

if (process.env.CI) process.exit(0);

const hooksDir = hooksDirectory();
if (hooksDir === null) process.exit(0);
mkdirSync(hooksDir, { recursive: true });

const hooks = [
  { name: "pre-commit", always: true },
  { name: "pre-push", always: false },
];

for (const { name, always } of hooks) {
  const src = resolve(__dirname, "git-hooks", name);
  const dest = resolve(hooksDir, name);

  if (!existsSync(src)) {
    console.error(`[install-git-hooks] Source not found: ${src}`);
    process.exit(1);
  }
  if (!always && existsSync(dest) && !readFileSync(dest, "utf8").includes(MARKER)) {
    console.log(`[install-git-hooks] Kept your own ${name} hook at ${dest}; not installing ours over it.`);
    continue;
  }

  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`[install-git-hooks] Installed ${name} → ${dest}`);
}
