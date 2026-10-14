# North-star scorecard

`scripts/eval/north-star-scorecard.mjs` scores the north star ("one prompt or one
GDD → a finished game that follows Strada's patterns") from what the system
recorded. It does not use agent prose. It reports ten rungs and the proof run's
criteria A–L. Each one prints as `pass`, `fail` or `not measured: <cause>`,
together with the numbers it read.

```bash
node scripts/eval/north-star-scorecard.mjs --project <unity project>            # text
node scripts/eval/north-star-scorecard.mjs --project <unity project> --json     # machine-readable
node scripts/eval/north-star-scorecard.mjs --campaign <id> --upstream ~/Documents/Strada
```

| Flag | Default |
|---|---|
| `--home <dir>` | where the runtime keeps its log and databases, decided as `resolveRuntimePaths` decides it. A source checkout (a `.git` beside the script, unless `STRADA_SOURCE_CHECKOUT=false`) keeps them in the checkout itself. An installed copy keeps them in `$STRADA_HOME`, else `~/.strada` (`%LOCALAPPDATA%\Strada` on Windows). |
| `--memory-dir <dir>` | `$MEMORY_DB_PATH` resolved against the home, else `<home>/.strada-memory` |
| `--campaigns-db`, `--tasks-db`, `--learning-db <path>` | `<memory-dir>/<name>.db` |
| `--vault <index.db>` (repeatable) | `<project>/.strada/vault/index.db` and framework vaults under `<project>/Packages` |
| `--upstream <dir>` | none. This is the folder that holds the `Strada.Core`, `Strada.Modules` and `Strada.MCP` checkouts. Without it, the scorecard cannot tell upstream framework docs from notes that a run wrote into a vendored copy. |
| `--log <path>` | `$LOG_FILE` resolved against the home, else `<home>/strada-brain.log`. The archives the logger rotated it into, beside it, are read too. |
| `--brain-root <dir>` | this repository. Rung 1 compares the newest boot with this checkout's HEAD. |
| `--campaign <id>` | all campaigns. With an id, the scorecard measures only that campaign, which is how a proof run is scored. |

The defaults read only the environment. If the home's `.env` sets `MEMORY_DB_PATH` or `LOG_FILE`, or the daemon runs from another checkout or home, pass `--home`, `--memory-dir` or `--log`. The card lists every path it read.

Exit code `0` means the card was printed, whatever it says. Exit code `2` means a bad invocation or an unknown `--campaign`.

## How a verdict is reached

Each rung is a list of checks. A check comes out true, false, or not measured.

- **Fail:** any false check fails the rung.
- **Not measured:** if no check is false but some check could not be measured, the rung is `not measured`, and the output names the cause.
- **Pass:** only a rung whose every check held passes.

So a missing source never becomes a pass, and an unreadable source never hides a failure that the other sources already show.

A table of another shape, such as an older schema without a column the scorecard reads, counts as a source that could not be read. Only the part that reads it becomes `not measured: <path> could not be read: <error>`, and every other rung is still scored.

A mechanism with no store at all is a **fail**, not `not measured`. Assumption records, for example, have no store today. The rung asks whether the system records the thing, and it does not.

## What each rung reads

| # | Source | Passes when |
|---|---|---|
| 1 | daemon log and its rotated archives (`strada-brain1.log.gz` … `strada-brain4.log.gz`), the newest `Bootstrapping Strada Brain` line and the Strada.MCP line that follows it | that boot registered at least 1 Unity tool, the bridge was connected, and the boot is not older than HEAD. A newer boot that logged `Failed to load…`, `Refused to load…` or no Strada.MCP line at all fails, whatever an older boot loaded. No boot marker in any file, or an unreadable archive that may hold the newest boot, is `not measured`. |
| 2 | `campaigns.idea_text` | a campaign started from one sentence reached a plan |
| 3 | `campaigns.requirements_json` | a ledger exists, and every in-scope row is owned by a milestone of the plan |
| 4 | the ledger's `owner` field and the constructs its acceptance check names | every in-scope row names an owner and a framework construct. A row counts as owned only by its `owner`, as production reads it; a queued row has none, whatever its `ownership` history names. Since `5c12d384` the construct is read from the row's own acceptance check (`constructsNamedBy`), not from a field a planner could claim — so a row whose check has not been written yet still names none, and the rung says which half is missing. |
| 5 | `campaign_judgements`, `campaigns.scope_gate_since`, each milestone's `judgementBasis` | every counted green milestone has a green judgement on a `proven` basis in mode `on` (a `shadow` judgement counts for nothing). With `--campaign`, every green of that campaign counts. Without it, two kinds of green are left out and counted in a note: those of campaigns created before the gate first decided anywhere (the earliest `scope_gate_since`) that never ran under it, and those production marked `legacy` (green before the ledger was built). Every other green counts, including one in a later campaign run with the gate off. No campaign under the gate fails the rung. |
| 6 | project `Assets/` (game code: excludes Tests, Editor, Strada.Generated, Plugins, StradaAcceptance, and framework copies such as `Assets/Strada.MCP` or a `Strada.Modules` folder at any depth) | ModuleConfig subclasses exist, no type name is declared in two modules, no empty `OnUpdate`, every `Service` subclass is registered, no `FindObject*`, and no `new *Service(` |
| 7 | the project's `Packages/` and game code (a framework copy's own files never count as a reference) | Strada.Modules is installed and referenced |
| 8 | milestone build, run and play-through verdicts, plus `unity_build_player` / `unity_run_player` observations | a player was built and run, a play-through was ok, Won and Lost were both observed, and the input route was real input. No production code records the input route yet, so this check is `not measured` today. |
| 9 | `retrieval_metrics` (and its rollup), `instinct_exposure_log`, `instincts.origin_session_id` | a retrieval returned something, and a lesson reached a later run than the one that learned it. Only a recorded origin session can show that. Since `10953e5d` the pipeline records the task that learned an instinct and tags its campaign, so the pair is linkable (origin = the task that learned it, `task_run_id` = the task that saw it); an exposure of a lesson learned before that commit still has no origin and reads `not measured: lesson provenance not recorded`, never a pass. |
| 10 | campaigns, judgements and `tasks.db` | a campaign was delivered with every milestone gate-proven, with 0 owner messages in its chat during the run |

How the rung 6 terms are defined:

- **Module:** `Assets/Modules/<X>/…` belongs to module `<X>`. Any other path belongs to its first folder under `Assets/`.
- **Registered:** a service's class name appears in a `Register*` call's type arguments, in `typeof(…)`, or in `new …`, or the class carries `[AutoRegister]`.
- **Empty `OnUpdate`:** comments are stripped first, so a body that holds only a TODO counts as empty.
- **Core share:** the share of files that reference no `Strada.Core` namespace is reported but not gated.

Criteria A–L measure the same sources for one campaign: `--campaign`, or else the newest campaign on `--project`. Some parts no record holds today:

- per-mode test counts
- named play-through scenarios
- DI and bus closure
- Core's ArchitectureValidator
- negative controls, as a STORE the scorecard can read. Since `f3a53e95` a delivery runs them over the delivered tree and prints the count in its report, but nothing records the result where this scorecard looks.

These print as `not measured`, with the reason.

Criterion H reads whether a store for assumption records exists at all. Since
`02904ec8` it does (`campaign_assumptions`, append-only beside
`campaign_judgements`), and a delivery records what it chose where the document
was silent — so the criterion is `not measured` rather than `fail` until this
scorecard reads the rows themselves.

Criterion K reads the **vault indexes**, which is what retrieval can return. It does not read a log of what reached a prompt. A file indexed by two vaults is counted once.

## Read-only

The scorecard opens every database with SQLite's read-only flag and `query_only`.

A WAL-mode database with no `-wal` or `-shm` file beside it is read from a copy in memory. This is because a read-only open would otherwise create those two files and leave them behind.

The project tree and the log are only read, so the scorecard is safe to run against a live home.

**Do not commit its output on real data.** The output names a private project's paths, types and campaigns. The tests run it only on invented databases and an invented project tree: `tests/eval/north-star-scorecard.test.ts`. Their main fixture holds only what production writes. The ten-rung pass is a separate fixture that adds the records production did not write when it was built: the construct (now derived from a row's acceptance check, `5c12d384`), the input route (still unwritten) and the lesson's origin session (now written, `10953e5d`).
