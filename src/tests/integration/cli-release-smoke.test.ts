import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * OPS-16. The CLI release smoke cleared the provider keys from its children's
 * environment but ran them from the checkout, which they took as their config
 * root: dotenv refilled every cleared key from the developer's `.env`, real
 * providers could be appended as fallbacks, and logs, the runtime lock and a
 * full index of the repository landed in the checkout.
 *
 * The module is a .mjs script loaded through a non-literal specifier so the type
 * checker does not try to resolve a JavaScript file that has no declarations.
 */
interface SmokeSandbox {
  home: string;
  stradaHome: string;
  installRoot: string;
  gitConfig: string;
}

interface SmokeModule {
  createSmokeSandbox: (tempRoot: string) => SmokeSandbox;
  buildBaseEnv: (memoryDir: string, projectDir: string, sandbox: SmokeSandbox) => Record<string, string | undefined>;
  smokeChildArgs: (args: string[]) => string[];
  OFFLINE_GIT_CONFIG: string;
  PROVIDER_FALLBACK_PROMPT: string;
  PROVIDER_FALLBACK_ANSWER: string;
}

const ROOT = process.cwd();
const smokeModulePath = pathToFileURL(path.join(ROOT, "scripts", "release", "cli-release-smoke.mjs")).href;
const loadSmoke = async () => (await import(smokeModulePath)) as SmokeModule;

describe("cli-release-smoke isolation (OPS-16)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeSandbox(smoke: SmokeModule) {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "strada-cli-smoke-"));
    tempDirs.push(tempRoot);
    const sandbox = smoke.createSmokeSandbox(tempRoot);
    mkdirSync(sandbox.home, { recursive: true });
    mkdirSync(sandbox.installRoot, { recursive: true });
    return { tempRoot, sandbox };
  }

  it("keeps HOME, the Strada home and the install root inside the run's temp root", async () => {
    const smoke = await loadSmoke();
    const { tempRoot, sandbox } = makeSandbox(smoke);
    // A key exported in the developer's shell is cleared as well.
    vi.stubEnv("ANTHROPIC_API_KEY", "from-developer-shell");
    const env = smoke.buildBaseEnv(path.join(tempRoot, "memory"), path.join(tempRoot, "project"), sandbox);

    for (const key of ["HOME", "USERPROFILE", "STRADA_HOME", "STRADA_INSTALL_ROOT", "GIT_CONFIG_GLOBAL"]) {
      const value = env[key] ?? "";
      expect(path.relative(tempRoot, value).startsWith(".."), `${key}=${value}`).toBe(false);
      expect(path.isAbsolute(value), key).toBe(true);
    }
    expect(env["STRADA_SOURCE_CHECKOUT"]).toBe("false");
    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(env["PROVIDER_CHAIN_STRICT"]).toBe("1");
    expect(env["AUTO_UPDATE_ENABLED"]).toBe("false");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    // Nothing in the child's command line resolves from its cwd (the sandbox).
    const args = smoke.smokeChildArgs(["cli"]);
    for (const arg of args.filter((value) => !value.startsWith("-") && value !== "cli")) {
      expect(arg.startsWith("file:") || path.isAbsolute(arg), arg).toBe(true);
    }
  });

  it("the smoke's child reads no developer .env, even from a checkout it runs in", async () => {
    const smoke = await loadSmoke();
    const { tempRoot, sandbox } = makeSandbox(smoke);
    // A checkout holding the developer's own .env. The real smoke's children
    // resolved the repository itself as this root; it stands in for it here.
    const checkout = path.join(tempRoot, "checkout");
    mkdirSync(path.join(checkout, ".git"), { recursive: true });
    writeFileSync(path.join(checkout, ".env"), "ANTHROPIC_API_KEY=from-developer-dotenv\n");
    const env = {
      ...smoke.buildBaseEnv(path.join(tempRoot, "memory"), path.join(tempRoot, "project"), sandbox),
      STRADA_INSTALL_ROOT: checkout,
    };

    // The real config module, which loads .env when it is imported, under the
    // smoke's own TypeScript loader.
    const childArgs = smoke.smokeChildArgs([]);
    const tsxLoader = childArgs[childArgs.lastIndexOf("--import") + 1];
    expect(tsxLoader).toMatch(/tsx/);
    const configUrl = pathToFileURL(path.join(ROOT, "src", "config", "config.ts")).href;
    const pathsUrl = pathToFileURL(path.join(ROOT, "src", "common", "runtime-paths.ts")).href;
    const probe = [
      `await import(${JSON.stringify(configUrl)});`,
      `const { resolveDotenvPath } = await import(${JSON.stringify(pathsUrl)});`,
      "console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, dotenv: resolveDotenvPath() }));",
    ].join("\n");
    const output = execFileSync(process.execPath, ["--import", String(tsxLoader), "--input-type=module", "-e", probe], {
      cwd: sandbox.home,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as { key: string | null; dotenv: string };

    expect(result.key).toBeNull();
    expect(result.dotenv).toBe(path.join(sandbox.stradaHome, ".env"));
  }, 90_000);
});

describe("cli-release-smoke stays offline", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a smoke child's git cannot reach a network remote", async () => {
    // The framework sync clones a package the project does not ship (it
    // cloned Strada.MCP from GitHub on every smoke run), and the runtime has no
    // switch for it. The smoke's git configuration refuses the transport.
    const smoke = await loadSmoke();
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "strada-cli-smoke-git-"));
    tempDirs.push(tempRoot);
    const sandbox = smoke.createSmokeSandbox(tempRoot);
    writeFileSync(sandbox.gitConfig, smoke.OFFLINE_GIT_CONFIG);
    const env = smoke.buildBaseEnv(path.join(tempRoot, "memory"), path.join(tempRoot, "project"), sandbox);

    let stderr = "";
    try {
      execFileSync("git", ["ls-remote", "--", "https://github.com/okandemirel/Strada.MCP.git"], {
        cwd: tempRoot,
        env: { ...env, GIT_ALLOW_PROTOCOL: "https", GIT_TERMINAL_PROMPT: "0" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
    } catch (err) {
      stderr = String((err as { stderr?: unknown }).stderr ?? "");
    }
    expect(stderr).toMatch(/smoke-offline/);
  }, 30_000);
});

describe("cli-release-smoke provider fallback wait", () => {
  it("waits for the fallback's answer, which the echoed prompt does not contain", async () => {
    // The CLI echoes the prompt (the plan-progress "Current focus" line). A
    // prompt carrying the answer let the wait match that echo, so the step
    // passed while no provider had answered at all.
    const smoke = await loadSmoke();
    expect(smoke.PROVIDER_FALLBACK_ANSWER).toBe("provider fallback ok");
    expect(smoke.PROVIDER_FALLBACK_PROMPT.toLowerCase()).not.toContain(smoke.PROVIDER_FALLBACK_ANSWER);
    // The mock recognises the scenario by this phrase.
    expect(smoke.PROVIDER_FALLBACK_PROMPT.toLowerCase()).toContain("provider fallback smoke");
  });
});
