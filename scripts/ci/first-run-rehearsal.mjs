#!/usr/bin/env node
/**
 * THE FIRST FIFTEEN MINUTES, REHEARSED (plan 6.8).
 *
 * The plan's measure for 6.8 is a human trial: 8–12 new developers, ≥70% of them
 * finished inside an hour with no live help. That cannot be run here, and this
 * script does not pretend otherwise — it reports that row as NOT MEASURED, with
 * the reason, for ever.
 *
 * What it DOES do is perform the path a new developer walks, in a throwaway home
 * and a throwaway project, and fail loudly where that path misleads:
 *
 *   1. `strada doctor` on an install with no configuration at all. It must FAIL
 *      (not warn, not pass) and name the command that fixes it.
 *   2. A configuration written through production's own persistence, then read
 *      back from disk.
 *   3. `strada doctor` again: the configuration step must pass and the supported
 *      project matrix must appear, naming what the project still lacks.
 *   4. The steps that need a person or a provider — the wizard's own UI, the GDD
 *      intake's first campaign plan — reported NOT RUN with the reason. Spending
 *      the user's provider credit is not this script's business.
 *
 * Exit codes follow the house contract used by scripts/eval/learning-eval.mjs:
 *   0 every requested step ran and passed · 1 ran and failed · 2 bad invocation
 *   3 a requested step did NOT run (unproven is never accepted)
 *
 * The isolation itself is load-bearing: STRADA_SOURCE_CHECKOUT=false is what
 * keeps this out of the developer's own `.env` (that env var only understood
 * "true" until plan 6.8's first rehearsal found it).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
// fileURLToPath, not .pathname: on Windows the pathname is "/C:/..." and not a path.
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");

/** One row of the rehearsal. `notRun` never counts as a pass. */
function step(id, what) {
  return { id, what, state: "not-run", detail: "", ms: 0 };
}

function parseArgs(argv) {
  const args = { json: undefined, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = argv[++i];
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--help") args.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  return args;
}

async function doctor(home, project) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run("npx", ["tsx", join(REPO, "src/index.ts"), "doctor"], {
      cwd: REPO,
      env: {
        ...process.env,
        HOME: home,
        STRADA_HOME: home,
        // The whole point: a fresh install's configuration lives in the app
        // home, never in this checkout.
        STRADA_SOURCE_CHECKOUT: "false",
        ...(project ? { UNITY_PROJECT_PATH: project } : {}),
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, out: `${stdout}\n${stderr}`, ms: Date.now() - started };
  } catch (error) {
    const out = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    return {
      code: typeof error.code === "number" ? error.code : 1,
      out,
      ms: Date.now() - started,
      // A TOOL THAT IS NOT THERE IS NOT A FAILING DOCTOR (round 14 #16). With
      // npx or the tsx loader absent, all three steps read FAIL and the run
      // exited 1 — a measured verdict about something that never executed.
      ...(missingTool(error) ? { missingTool: missingTool(error) } : {}),
    };
  }
}

/** The executable or loader this environment does not have, if that is why. */
function missingTool(error) {
  const code = error?.code;
  const text = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  if (code === "ENOENT") return "npx (or node) is not on PATH";
  if (/ERR_UNKNOWN_FILE_EXTENSION|Cannot find module 'tsx'|tsx: not found|command not found/i.test(text)) {
    return "the tsx loader is not installed (run npm install)";
  }
  return undefined;
}

async function unityProject(root) {
  mkdirSync(join(root, "Assets"), { recursive: true });
  mkdirSync(join(root, "ProjectSettings"), { recursive: true });
  mkdirSync(join(root, "Packages"), { recursive: true });
  writeFileSync(join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.22f1\n");
  writeFileSync(join(root, "Packages", "manifest.json"), '{"dependencies":{}}\n');
  // A new developer's project is a CLONE, so it is a repository: the matrix
  // requires one (task leases take worktrees off it).
  try {
    await run("git", ["init", "-q"], { cwd: root, env: { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" } });
  } catch {
    // No usable git here: the matrix will say so, which is the honest answer.
  }
  return root;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`first-run-rehearsal: ${args.error}`);
    process.exit(2);
  }
  if (args.help) {
    console.log("usage: node scripts/ci/first-run-rehearsal.mjs [--json <file>] [--keep]");
    process.exit(0);
  }

  const home = mkdtempSync(join(tmpdir(), "strada-first-run-home-"));
  const project = await unityProject(mkdtempSync(join(tmpdir(), "strada-first-run-project-")));
  const steps = [
    step("doctor-unconfigured", "strada doctor on an install with no configuration"),
    step("write-config", "a configuration written through production's persistence and read back"),
    step("doctor-configured", "strada doctor again: configuration passes and the project matrix appears"),
  ];
  const notMeasured = [
    {
      id: "human-trial",
      what: "8–12 new developers, ≥70% finished inside an hour unaided (the plan's measure)",
      why: "needs people; nothing on this machine can stand in for them",
    },
    {
      id: "wizard-ui",
      what: "the setup wizard's own screens (web and terminal)",
      why: "this rehearsal drives the persistence contract, not a browser",
    },
    {
      id: "first-campaign-plan",
      what: "the first campaign's plan from a GDD",
      why: "needs a live provider; the rehearsal does not spend the user's credit",
    },
  ];

  try {
    // 1. Unconfigured.
    {
      const s = steps[0];
      const result = await doctor(home, project);
      s.ms = result.ms;
      const saysNoEnv = /No \.env file was found/i.test(result.out);
      const namesSetup = /strada setup|setup:web/i.test(result.out);
      const blocking = /blocking issues/i.test(result.out) || result.code !== 0;
      if (result.missingTool) {
        s.state = "not-run";
        s.detail = `not run: ${result.missingTool}`;
      } else {
        s.state = saysNoEnv && namesSetup && blocking ? "pass" : "fail";
        s.detail = s.state === "pass"
          ? "failed with blocking issues, said no .env was found and named the setup command"
          : `expected a blocking failure naming the missing .env and the setup command; ` +
            `saw noEnv=${saysNoEnv} namesSetup=${namesSetup} blocking=${blocking}`;
      }
    }

    // 2. Write a configuration the way the wizard does.
    {
      const s = steps[1];
      const started = Date.now();
      // THROUGH A CHILD, NOT AN IMPORT (round 13 #34): importing `.ts` from
      // this `.mjs` works only on a Node new enough to strip types, so on a
      // supported Node 20 the rehearsal died with ERR_UNKNOWN_FILE_EXTENSION
      // before it produced a report. The doctor steps already go through tsx;
      // so does this one, and it is still production's own persistence.
      const envPath = join(home, ".env");
      const lines = [
        `UNITY_PROJECT_PATH=${project}`,
        "STRADA_LANGUAGE=en",
        "WEB_PORT=3000",
        // A configuration that VALIDATES needs a provider. Ollama is the one
        // the schema accepts without a credential, so the rehearsal never
        // writes a fake key and never has one to leak.
        "PROVIDER_CHAIN=ollama",
      ];
      // Inputs travel in the ENVIRONMENT, not argv: `--eval` shifts argv in a
      // way that differs between Node versions, and no top-level await —
      // `tsx --eval` transforms the snippet as CJS, where esbuild refuses it.
      const script = [
        'import(process.env.REHEARSAL_MODULE)',
        '  .then((m) => m.persistSetup(process.env.REHEARSAL_ENV_PATH, JSON.parse(process.env.REHEARSAL_LINES), { ownedKeys: JSON.parse(process.env.REHEARSAL_OWNED) }))',
        '  .then((result) => process.stdout.write(JSON.stringify({ diskMatchesCommit: result.diskMatchesCommit })))',
        '  .catch((error) => { process.stderr.write(String((error && error.stack) || error)); process.exit(1); });',
      ].join("\n");
      let diskMatchesCommit = false;
      let childError = "";
      let childMissingTool;
      try {
        const { stdout } = await run("npx", ["tsx", "--eval", script], {
          cwd: REPO,
          env: {
            ...process.env,
            HOME: home,
            STRADA_HOME: home,
            STRADA_SOURCE_CHECKOUT: "false",
            // A file URL: import() of a bare absolute path fails on Windows.
            REHEARSAL_MODULE: pathToFileURL(join(REPO, "src/core/setup-env-persistence.ts")).href,
            REHEARSAL_ENV_PATH: envPath,
            REHEARSAL_LINES: JSON.stringify(lines),
            REHEARSAL_OWNED: JSON.stringify(["UNITY_PROJECT_PATH", "STRADA_LANGUAGE", "WEB_PORT", "PROVIDER_CHAIN"]),
          },
          maxBuffer: 4 * 1024 * 1024,
        });
        diskMatchesCommit = JSON.parse(stdout.trim().split("\n").pop() ?? "{}").diskMatchesCommit === true;
      } catch (error) {
        childError = String(error?.stderr ?? error?.message ?? error).slice(0, 300);
        childMissingTool = missingTool(error);
      }
      s.ms = Date.now() - started;
      const onDisk = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
      const ok = diskMatchesCommit && onDisk.includes(project);
      s.state = childMissingTool ? "not-run" : ok ? "pass" : "fail";
      if (childMissingTool) s.detail = `not run: ${childMissingTool}`;
      else s.detail = ok
        ? `wrote ${envPath} and read back the project path`
        : `diskMatchesCommit=${diskMatchesCommit}; the file ${onDisk ? "does not name the project" : "was not written"}${childError ? `; ${childError}` : ""}`;
    }

    // 3. Configured.
    {
      const s = steps[2];
      const result = await doctor(home, project);
      s.ms = result.ms;
      const configPasses = /\[PASS\] Configuration/.test(result.out);
      const matrixShown = /Supported project matrix/.test(result.out);
      const namesWhatIsMissing = /Strada\.Core/.test(result.out);
      // The doctor must not CRASH on a configuration it dislikes either: the
      // rehearsal found it doing exactly that on an invalid one, because
      // loadConfigSafe's `kind: "err"` matched no branch.
      const crashed = /Cannot read properties of undefined|Unhandled Rejection/.test(result.out);
      if (result.missingTool) {
        s.state = "not-run";
        s.detail = `not run: ${result.missingTool}`;
      } else {
        s.state = configPasses && matrixShown && namesWhatIsMissing && !crashed ? "pass" : "fail";
        s.detail = s.state === "pass"
          ? "configuration passed and the matrix named what the project still lacks"
          : `configPasses=${configPasses} matrixShown=${matrixShown} namesMissing=${namesWhatIsMissing} crashed=${crashed}`;
      }
    }
  } finally {
    if (!args.keep) {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }

  const failed = steps.filter((s) => s.state === "fail");
  const notRun = steps.filter((s) => s.state === "not-run");
  const verdict = failed.length > 0 ? "FAILED" : notRun.length > 0 ? "NOT PROVEN" : "PROVEN";
  const exitCode = failed.length > 0 ? 1 : notRun.length > 0 ? 3 : 0;

  const lines = [
    "",
    "FIRST-RUN REHEARSAL (plan 6.8)",
    "==============================",
    "The path a new developer walks, performed in a throwaway home and project.",
    "",
  ];
  for (const s of steps) {
    const label = s.state === "pass" ? "PASS" : s.state === "fail" ? "FAIL" : "NOT RUN";
    lines.push(`  [${label.padEnd(7)}] ${s.what} (${s.ms} ms)`);
    lines.push(`             ${s.detail}`);
  }
  lines.push("", "NOT MEASURED (never folded into the verdict)");
  for (const row of notMeasured) lines.push(`  [NOT MEASURED] ${row.what}\n                 ${row.why}`);
  lines.push(
    "",
    `VERDICT: ${verdict}   exit ${exitCode}`,
    "exit contract: 0=every step ran and passed  1=ran and failed  3=a step did NOT run",
    "",
  );
  const report = lines.join("\n");
  console.log(report);
  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify({ verdict, exitCode, steps, notMeasured }, null, 2)}\n`);
  }
  process.exit(exitCode);
}

await main();
