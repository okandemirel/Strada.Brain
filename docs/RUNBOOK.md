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

## 7. Universality rule

Nothing in `src/` may carry a game's own names, scene names or defaults. The
game-facing contracts live in Strada.Core (`Strada.Core.Play.IPlaythroughDriver`,
`ISessionCatalog`, `GameBootstrapper`), the tools in Strada.MCP; a test vehicle
(any Unity project) is configured through its own GDD and project, never
through Strada.Brain.
