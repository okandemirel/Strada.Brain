/**
 * The sensitive-file blocklist is the only check shell_exec runs on the files
 * a command names, and the one guarantee file_read keeps for a path the user
 * named outside the project. It covered .ssh/, .npmrc and .netrc but none of
 * the other standard credential stores — including the ChatGPT auth file this
 * product logs in with and the daemon's own operator credential, which unlocks
 * the local-operator routes (audit security-config#5).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { sensitiveCommandPaths } from "../agents/tools/shell-sensitive-paths.js";
import { isSensitivePath } from "./path-guard.js";

const home = mkdtempSync(join(tmpdir(), "guard-cred-home-"));
const project = join(home, "proj");
mkdirSync(join(project, "Assets"), { recursive: true });

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const stores = [
  ".aws/credentials",
  ".aws/config",
  ".git-credentials",
  ".config/git/credentials",
  ".docker/config.json",
  ".kube/config",
  ".config/gh/hosts.yml",
  ".pgpass",
  ".codex/auth.json",
  ".local/share/opencode/auth.json",
  ".strada/locks/0123abcd.operator.json",
];

describe("standard credential stores are on the blocklist", () => {
  for (const store of stores) {
    it(`refuses ~/${store}`, () => {
      expect(isSensitivePath(join(home, store))).toBe(true);
      expect(isSensitivePath(`C:\\Users\\o\\${store.replace(/\//g, "\\")}`)).toBe(true);
    });
  }

  it("refuses a command that names one, however the home directory is written", () => {
    const env = { HOME: home };
    for (const command of [
      "cat ~/.aws/credentials",
      "cat $HOME/.docker/config.json",
      `cat ${home}/.kube/config`,
      "cat ~/.codex/auth.json",
      "cat ~/.strada/locks/0123abcd.operator.json",
    ]) {
      expect(sensitiveCommandPaths(command, project, { env }), command).not.toEqual([]);
    }
  });

  it("refuses a glob into one, whether it is expanded against the disk or judged conservatively", () => {
    for (const store of stores) {
      mkdirSync(join(home, store, ".."), { recursive: true });
      writeFileSync(join(home, store), "secret\n");
    }
    const env = { HOME: home };
    // Narrow globs: a bare `*` is already refused by the older sample names
    // (it could be x.key), so it would not show whether these are known.
    for (const command of [
      "cat ~/.aws/cred*",
      "cat ~/.git-cred*",
      "cat ~/.docker/conf*",
      "cat ~/.kube/c*",
      "cat ~/.config/gh/h*",
      "cat ~/.pg*",
      "cat ~/.codex/a*",
      "cat ~/.local/share/opencode/a*",
      "cat ~/.strada/locks/*.json",
    ]) {
      expect(sensitiveCommandPaths(command, project, { env }), command).not.toEqual([]);
      // Over budget, the glob is judged by the names a protected file can take.
      expect(sensitiveCommandPaths(command, project, { env, globEntryBudget: 0 }), `${command} (budget 0)`).not.toEqual([]);
    }
  });

  it("leaves ordinary project files with the same base names open", () => {
    for (const name of [
      "Assets/config.json",
      "Assets/auth.json",
      "Assets/hosts.yml",
      "Assets/Docker/config.json",
      "Assets/Kube/config",
      "ProjectSettings/credentials.txt",
      "Packages/manifest.json",
      "Assets/Locks/x.operator.json",
    ]) {
      expect(isSensitivePath(join(project, name)), name).toBe(false);
    }
  });
});
