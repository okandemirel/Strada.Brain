#!/usr/bin/env node
/**
 * Boot smoke — CI actually starts the daemon (2026-09-10).
 *
 * Until now CI type-checked, linted, ran the unit suite and built, but never
 * booted the thing it built: a boot-time crash (a missing import, a stage
 * that throws on an empty home, a port the web channel fails to bind) went
 * green in CI and was found by the operator's log. This script starts
 * `dist/index.js start --channel web` in a throwaway install root and home,
 * with no credentials — PROVIDER_CHAIN=ollama points at a stub in this
 * process that answers only `/api/tags` (the reachability probe), so the
 * provider preflight passes without any real model — waits for `/health` to
 * answer `ok`, sends SIGTERM and expects a clean exit. It prints the tail of the daemon's output on any failure.
 *
 * Exit codes: 0 booted + shut down cleanly; 1 health never came or shutdown
 * hung; 2 dist missing (run `npm run build`).
 *
 * Env: BOOT_SMOKE_TIMEOUT_S (default 120), BOOT_SMOKE_PORT (default 3910).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const entry = path.join(repoRoot, "dist", "index.js");
if (!existsSync(entry)) {
  console.error(`boot-smoke: ${entry} missing — run \`npm run build\` first`);
  process.exit(2);
}

const timeoutS = Number(process.env["BOOT_SMOKE_TIMEOUT_S"] ?? 120);
const port = Number(process.env["BOOT_SMOKE_PORT"] ?? 3910);
const dashboardPort = port + 1;

const root = mkdtempSync(path.join(tmpdir(), "strada-boot-smoke-"));
const home = path.join(root, "home");
const installRoot = path.join(root, "install");
const unityProject = path.join(root, "UnityProject");
for (const d of [home, installRoot, path.join(unityProject, "Assets"), path.join(unityProject, "ProjectSettings")]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(path.join(unityProject, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");

// Stub Ollama: the boot preflight refuses to start with NO_HEALTHY_AI_PROVIDER
// when nothing answers; a reachable endpoint with zero models is the smallest
// honest provider. Anything but /api/tags is 404 — a boot that needs more
// than reachability fails loudly here instead of passing by accident.
const ollamaPort = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.unref();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const env = {
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  USERPROFILE: home,
  STRADA_HOME: path.join(home, ".strada"),
  STRADA_INSTALL_ROOT: installRoot,
  STRADA_SOURCE_CHECKOUT: "false",
  MEMORY_DB_PATH: path.join(home, ".strada", "memory"),
  UNITY_PROJECT_PATH: unityProject,
  PROVIDER_CHAIN: "ollama",
  OLLAMA_BASE_URL: `http://127.0.0.1:${ollamaPort}`,
  WEB_CHANNEL_PORT: String(port),
  DASHBOARD_PORT: String(dashboardPort),
  STRADA_AUTO_UPDATE: "false",
  AUTO_UPDATE_ENABLED: "false",
  LOG_LEVEL: "info",
  NODE_ENV: "production",
  CI: "1",
};

const output = [];
const child = spawn(process.execPath, [entry, "start", "--channel", "web"], {
  cwd: installRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const keep = (chunk) => {
  output.push(chunk.toString());
  while (output.join("").length > 20_000) output.shift();
};
child.stdout.on("data", keep);
child.stderr.on("data", keep);

let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const healthUrl = `http://127.0.0.1:${port}/health`;

async function waitForHealth() {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (exited) return { ok: false, why: `daemon exited before health (code ${exited.code}, signal ${exited.signal})` };
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") return { ok: true, body };
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return { ok: false, why: `no ok /health within ${timeoutS} s` };
}

function fail(why) {
  console.error(`boot-smoke FAILED: ${why}`);
  console.error("--- daemon output (tail) ---");
  console.error(output.join("").slice(-8000));
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

const started = Date.now();
const health = await waitForHealth();
if (!health.ok) fail(health.why);
console.log(`boot-smoke: /health ok after ${((Date.now() - started) / 1000).toFixed(1)} s (uptime ${health.body.uptime?.toFixed?.(1)} s, clients ${health.body.clients})`);

child.kill("SIGTERM");
const shutdownDeadline = Date.now() + 30_000;
while (!exited && Date.now() < shutdownDeadline) await sleep(250);
if (!exited) fail("daemon did not exit within 30 s of SIGTERM");
if (exited.code !== 0 && exited.signal !== "SIGTERM") fail(`daemon exited with code ${exited.code} (signal ${exited.signal}) after SIGTERM`);
console.log(`boot-smoke: clean shutdown (code ${exited.code}, signal ${exited.signal}) in ${((Date.now() - started) / 1000).toFixed(1)} s total`);
rmSync(root, { recursive: true, force: true });
