#!/usr/bin/env node
/**
 * Installs versioned git hooks from scripts/git-hooks/ into .git/hooks/.
 * No-ops silently when .git/hooks/ does not exist (CI, npm-dep install, etc.).
 * Does NOT touch the existing .git/hooks/pre-push.
 */
import { existsSync, copyFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const hooksDir = resolve(repoRoot, ".git", "hooks");

if (!existsSync(hooksDir)) {
  // Not a git repo or hooks directory absent — safe no-op (CI / dep install).
  process.exit(0);
}

const hooks = ["pre-commit"];

for (const hook of hooks) {
  const src = resolve(__dirname, "git-hooks", hook);
  const dest = resolve(hooksDir, hook);

  if (!existsSync(src)) {
    console.error(`[install-git-hooks] Source not found: ${src}`);
    process.exit(1);
  }

  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`[install-git-hooks] Installed ${hook} → .git/hooks/${hook}`);
}
