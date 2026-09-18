# Strada.Brain — Operations Runbook

What to do when the daemon, a campaign, a mission or a Unity tool misbehaves.
Every step here names the file or command it reads; nothing is inferred.
Paths are the defaults (`~/.strada` is `STRADA_HOME`).

## 1. Is it alive?

| Check | Command | Healthy answer |
|---|---|---|
| Processes | `pgrep -fl "src/index.ts (cli\|start)"` | two `node` pids (the tsx launcher and the loader) |
| Web health | `curl -s http://127.0.0.1:3000/health` | `{"status":"ok", …}` |
| Boot report | `grep -E "Boot report\|Loaded Strada.MCP tools" ~/.strada/strada-brain.log \| tail -2` | a `Loaded Strada.MCP tools` line after the last boot; the boot report lists degraded stages by name |
| Supervisor death | `<Strada.Brain>/.strada/supervisor-dead.json` (written when the supervisor gives up restarting; consumed and reported at the next boot) | absent |
| One-shot read-out | `./strada status` (or `node node_modules/tsx/dist/cli.mjs src/index.ts status`) | `Health: ok (up …)`, `Providers: no bench in effect`, the live campaign's milestone or `Campaign: none active`, `Last auto-update: pulled … ago` |

CI boots the built daemon on every push (`npm run smoke:boot`: throwaway home,
no credentials, stub Ollama, `/health` must say ok, SIGTERM must exit cleanly);
the same command works locally after `npm run build` and prints the daemon's
output when the boot fails.

Two things the daemon learns by itself and `strada status` reports: a provider
whose turn hung past the hard ceiling gets a learned context ceiling (0.8 × the
hung turn's size, persisted in `context-ceilings.json` beside
`provider-health.json`; compaction plans against it; `OPENCODE_CONTEXT_WINDOW`
still overrides), and a tool offer that alone takes more than a quarter of the
window is logged once per provider as the thing to narrow — the conversation
is never compacted below 35 % of the window to make room for schemas.

`strada status` reads four sources and says when one is not readable rather
than skipping it: the web `/health` endpoint, `provider-health.json` (only
benches whose cooldown is still ahead are listed, with the retry time and the
last error), `campaigns.db` (active campaigns with their current milestone,
failed ones with their auto-revive appointment, else the last finished one),
and `<install>/.strada/auto-update.json` (the updater's last twenty outcomes:
`pulled`, `rolled-back`, `rollback-refused`, `deferred`).

The daemon logs to `~/.strada/strada-brain.log` (rotated `.gz` beside it) and
uncaught errors to `~/.strada/strada-brain-error.log`.

## 2. Restart (the only supported way)

Never kill a run mid-task: the workspace lease commits at task end, and a kill
before that loses the sprint's work into a salvage branch. Restart at a task
boundary (`Task settling` / `Task completed` in the log) or into a task that is
only minutes old — the boot re-arm resubmits paused and blocked missions
90 s after boot.

```bash
pkill -f "src/index.ts (cli|start)"; until ! pgrep -f "src/index.ts (cli|start)" >/dev/null; do sleep 1; done
nohup node node_modules/tsx/dist/cli.mjs src/index.ts start --channel cli,web \
  0<> ~/.strada/cli-stdin.fifo >> ~/.strada/strada-brain.log 2>&1 & disown
until grep -q "Loaded Strada.MCP tools" <(tail -c 400000 ~/.strada/strada-brain.log); do sleep 2; done
```

A parent-only kill leaves the loader running and the daemon looks dead while it
is not: always check both pids are gone. Tasks marked `blocked on shutdown` are
resumed by the re-arm pass; `Re-arming keep-alive orphaned by restart` in the
log is the confirmation.

## 3. Talking to the daemon

Commands go through the CLI fifo (`echo "/campaign" > ~/.strada/cli-stdin.fifo`)
or the web chat. The ones an operator needs:

| Command | Does |
|---|---|
| `/campaign` (`/kampanya`) | measured campaign status: milestones, attempts, time box, compile, play-through, player build, GDD numbers, proofs still owed, current task, self-revival timer |
| `/campaign revive` / `kampanya devam` | resume a NOT DELIVERED or failed campaign now with a fresh budget (it also resumes by itself 15 min after a NOT DELIVERED report) |
| `/campaign measure` / `/measure` | run the delivery-gate structural measurement on the project now |
| `/guardian` (`/bekçi`) | real-tree guardian: last compile verdict, play-through rung, fix task, escalation |
| `/status [taskId]` · `/cancel <taskId>` · `/retry` · `/resume <taskId>` | task lifecycle; `/resume` reports honestly when a task cannot be resumed |

## 4. Where the evidence is

| Evidence | Path | Written by |
|---|---|---|
| Play-through verdict (ok/reasons, sessions, timing, frames) | `<project>/Recordings/playthrough/playthrough-verdict.json` + `frame_*.png` | `unity_playthrough` (Strada.MCP); the campaign reads it at every sprint, requires it ok at the last |
| Player build | `<project>/Builds/<target>/…`, verdict in the tool output JSON | `unity_build_player`, run by the campaign itself at the final gate |
| Play-through inside the built player (real frame rate) | `<project>/Recordings/player-playthrough/playthrough-verdict.json` + `frame_*.png` | `unity_run_player`, run by the campaign itself right after a successful build; its fps answers the GDD's frame-rate target |
| Tool failures (full input/output) | `~/.strada/tool-failures/<date>/<time>-<tool>.txt` | every failed tool call |
| Provider health / cooldowns | `~/.strada/provider-health.json` (identity = endpoint\|model\|key hash; credential cooldown 8 h) | provider fallback chain |
| Lease workspaces | `$TMPDIR/strada-workspaces/<task>-<uuid>` (git worktrees under `<project>/.git/worktrees`), `.strada-lease-owner.json` names the owning pid | workspace lease manager |
| Lease conflicts (project kept, agent copy quarantined) | `<project>/.strada/lease-conflicts/<lease>/` | lease commit |
| Salvage branches (commits that did not land) | `git -C <project> branch --list "lease-salvage/*"` | lease release |
| Tasks | `~/.strada/tasks.db` | task manager |
| Campaigns | `~/.strada/strada.db` | campaign storage |

## 5. Reading a delivery report

The headline follows the newest measurement, never the ladder's mood:

- `🏁 Campaign delivery — game build complete` — every proof stood: unfiltered green suite, compile ok, play-through ok, GDD numbers met or disclosed as not measurable, player built (path + size in the report), structure and scene hygiene ok.
- `⛔ NOT DELIVERED — …` — a proof is missing after the bounce budget. The campaign is `failed`, names the proofs, and resumes the final sprint by itself after 15 min. Nothing is delivered with a caveat.

Lines starting `GDD … : MET / NOT MET / NOT MEASURED` are the GDD's own numbers
(frame rate, boot time, level count, session length). A frame rate from the
batch editor is always NOT MEASURED — it is a loop rate, not the player's.

## 6. Common situations

| Symptom | Read | Do |
|---|---|---|
| Every provider "cooling down" | `provider-health.json`, log `provider_unavailable` | wait for the horizon the file names, or add a key in `.env` (never copy `.env` anywhere) |
| Mission keeps failing verification with the same reason | `/campaign`, the mission's `Mission keep-alive scheduled … reason` lines | the reason is the work; the system retries with backoff (attempt N, up to 8 min) |
| Real tree red | `/guardian` | the guardian opens its own fix task (workspacePolicy none); a play-through rung runs after a green compile at most every 20 min |
| Two Unity runs at once | log `Waited for the Unity editor … behind …` | expected: batch-mode tools queue on the editor lock |
| Lease dir left behind after a crash | `.strada-lease-owner.json` pid not alive | the next boot salvages it (commits to a `lease-salvage/*` branch) — do not delete by hand |
| `Task workspace had conflicting files — project kept, agent copy quarantined` | `<project>/.strada/lease-conflicts/` | the project's copy won because it changed during the run; merge by hand if the agent's copy is wanted |

## 6b. The portal's instance owner (shared instances)

One daemon serves more than one browser. The FIRST identity the portal ever
issues owns the instance: only the owner writes settings and `.env`, starts or
stops the daemon, switches the provider, toggles autonomous mode or decides a
change review. Everyone else is a guest, whose own chats, boards, canvases,
attachments and tasks stay their own. The owner is recorded in
`<memory.dbPath>/web-identities.db` and survives restarts; the model itself is
`src/channels/web/instance-access.ts`.

**If the owner's browser loses its storage** it comes back as a guest, and every
owner-only power is then refused with a reason that names the identity. That is
inherent to "the first identity owns the instance", and the way back is an
explicit handover — NOT deleting the owner row, which the boot-time adoption of
the oldest established identity simply undoes:

1. open the portal in the replacement browser and let it connect once. It is
   issued an identity and stores it as `strada-profileId` in that browser's
   localStorage (DevTools → Application → Local Storage);
2. stop the daemon (§2) — this database must not be open for a write twice;
3. hand ownership over, either through `WebIdentityStore.reassignOwner(<profile
   id>)` or with the SQL it performs — which writes NOTHING unless that id is one
   this instance actually issued, and tells you which happened:

   ```sh
   sqlite3 "$HOME/.strada/db/web-identities.db" \
     "UPDATE web_instance_meta SET value = '<the new profile id>'
       WHERE key = 'owner_profile_id'
         AND EXISTS (SELECT 1 FROM web_identities WHERE profile_id = '<the new profile id>');
      SELECT changes() AS applied;"
   ```

   `applied` is **1** when the handover happened and **0** when the id is not an
   identity this instance issued — a typo, or a profile copied from the wrong
   browser. A 0 means nothing changed: fix the id and run it again.

4. start the daemon, and confirm: the replacement browser writes settings without
   a refusal, and the lost identity is now an ordinary guest.

Both routes refuse an id the instance never issued and leave the current owner
alone, so a typo in step 3 cannot leave the instance with an owner nobody can
present and every owner-only power refused for everybody. Deleting the whole
`web-identities.db` is the nuclear option: every identity is revoked, every
browser gets a fresh one, and the first to connect owns the instance again.

| Symptom | Read | Do |
|---|---|---|
| `deny:guest-owner-only` / `deny:unidentified` on settings, daemon control or a change review | the refusal names the identity and the owner | you are a guest on this instance: hand ownership over as above, or ask the owner |
| `unavailable:identity-store` (HTTP 503) on those surfaces | the log line `identity store could not be opened` / `not examinable` | the identity database exists and cannot be read (permissions on `<memory.dbPath>`, a lock, a corrupt page). Nothing is granted while it cannot be read — fix the file, no restart needed |

## 7. Checks you can run yourself

Each of these PERFORMS the thing it reports, and each says NOT MEASURED (never
"ok") for the parts it could not perform. The exit codes are the same
everywhere: **0** ran and passed, **1** ran and failed, **2** bad invocation,
**3** something the run needed did NOT run — unproven, never accepted.

| Command | What it actually does | Where it stops |
|---|---|---|
| `npm run smoke:boot` | boots the built CLI and shuts it down | needs `dist/` (run `npm run build` first) |
| `node scripts/ci/first-run-rehearsal.mjs` | walks a new developer's path in a THROWAWAY home and project: `strada doctor` with no configuration (must fail and name the setup command), a configuration written through production's persistence, then `strada doctor` again | the human trial (8-12 developers), the wizard's own screens and the first campaign plan are NOT MEASURED, with reasons |
| `npm run accept:release` | performs a clean install, an upgrade over an existing home, and a backup → restore | the upgrade row needs a REAL previous release (`--previous-release <tgz>`, a `tests/fixtures/release-acceptance/*.tgz`, or the registry); without one it exits 3 rather than claiming an upgrade it never installed |
| `npm run restore:db -- --help` | restores the runtime databases from a backup archive, refusing a tampered one and refusing while a database still has users | `--project-root` redirects project data when restoring onto another machine |
| `node scripts/eval/learning-eval.mjs --ablation-only` | trains three arms on throwaway databases and measures repeat-error reduction, harmful recall and cost per accepted result | the answer-quality arm needs a live provider; it reports NOT MEASURED instead of spending credit. It exits **1** today: harmful recall is 0.40 against a pre-registered budget of 0.34 — a real open finding about retrieval precision, not a broken harness |

Two rules that hold for all of them: a pre-registered budget is never moved to
make a run green, and a step that did not run is never folded into a pass.

## 8. Universality rule

Nothing in `src/` may carry a game's own names, scene names or defaults. The
game-facing contracts live in Strada.Core (`Strada.Core.Play.IPlaythroughDriver`,
`ISessionCatalog`, `GameBootstrapper`), the tools in Strada.MCP; a test vehicle
(any Unity project) is configured through its own GDD and project, never
through Strada.Brain.
