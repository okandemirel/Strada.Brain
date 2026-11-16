---
id: unverifiable-failure-closes-on-an-honest-report
kind: decision
tier: 1
status: active
topics: ["agent-loop", "evidence"]
paths: ["src/agents/autonomy/verifier-pipeline-unverifiable.ts", "src/agents/autonomy/verifier-pipeline-project-checks.ts", "src/agents/autonomy/verifier-pipeline.ts", "src/agents/autonomy/completion-review.ts", "src/agent-core/engine/reflection.ts", "src/agents/agent-state.ts"]
purpose: "Stop a failure that nothing in the run can verify from costing six asks, a block and a re-run that ends unverified anyway, without letting a run that could verify skip the check."
summary: "A failed step answered by a later success (the same call again, or a write of the same path or file name) stops gating only when every input of a recorded decision table allows it and none is unknown; the draft never opens it, and the system itself puts a 'Not verified: …' notice built from the record under the run's answer"
decided_on: 2026-11-11
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
Golden run 4 (2026-11-06): a write failed at run time (the filesystem refused it), the next write succeeded, and the project had no build and no tests. The targeted-repro and unverified-failure checks kept the failure open until a verification ran. Nothing could run one: the worker was asked six times, loop detection blocked the node, the goal ran again from the start, and the re-run, with an empty failure history, completed with no verification at all. The gate added cost and protected nothing.

## Decision
`decideUnverifiableExit` (`src/agents/autonomy/verifier-pipeline-unverifiable.ts`) builds a table with one row per input: what it asks, where it is read, what was read, what an unknown does, and its effect. The table goes into `evidence.unverifiableDecision`. The exit opens only when every deciding row allows it, and a row that cannot be read keeps the gate:
- the tool names offered to this turn were passed in, and none of them `runsVerificationCheck`. The record says where the answer came from (`evidence.verificationTooling.source`);
- the offer was not narrowed: an offer of writers only (restrictToProgressTools) or a plan node whose text names a tool (selectNodeTools) counts as not measured, because both hide tools that still run;
- when shell_exec is offered, the project root declares no check it could run (`measureProjectChecks` in `src/agents/autonomy/verifier-pipeline-project-checks.ts`): package.json test/build/check/lint scripts other than npm init's placeholder, a known test or build tool among package.json's dependencies (typescript, vitest, jest, …), a Makefile test/build/check target, a .sln or .csproj, a tsconfig.json or conftest.py, a test file at the root (test_*.py, *_test.go, *.test.*, *.spec.*), a test/ tests/ __tests__/ spec/ directory, or a manifest whose kind always carries a check (pyproject.toml, pytest.ini, Cargo.toml, go.mod, pom.xml, a Unity ProjectSettings and others). The record lists every manifest looked for and those found (`evidence.verificationTooling.projectChecks`). An unknown or unreadable root counts as not measured;
- no check ran in the run: no verification step with a verdict, and no `verificationState.lastVerificationAt` (a check older than the 50-step window still counts);
- every open failure was answered by a later success (`failureAnsweredBy` in completion-review.ts, recorded in `recentFailureAnswers`). Any tool, shell_exec included, is answered by the same call run again: same tool and same input (`StepResult.inputSignature`, a digest of the sorted-key input). A writer (file_write, file_edit, …) is also answered by the same tool later writing the same path, or a file of the same name in another directory (`StepResult.targetPath`): the file under a file, written where it belongs. A write of any other file answers nothing. A step without a signature, or a writer without a path, is not answered;
- no warn/error log entry is open;
- the draft does not report that the run failed (`isTerminalFailureReport`). That report has its own exit, and this row can only keep the gate.

The draft's words never open the exit. When it opens, `unverifiedNotice` builds "Not verified: …" from the record, in the task's language (`detectSupervisorFeedbackLanguage`, as the other system notices do): each failed call with its target and error, the call that answered it with its target, and why nothing could check the result. It never says "redone". The run's answer carries it whatever the draft said. `planVerifierPipeline` records it for the run on an approve and clears it on any other verdict. `settleVisibleBoundary` in `src/agent-core/engine/reflection.ts`, which every finished run passes, takes it and puts it under the answer: rendered with it in an interactive run, and written into the recorded answer in a background run, whose final text is read back from the last visible message. One more row reads the draft, and it can only add an ask: a draft that claims a check passed (`draftClaimsCheckPassed`) contradicts the record and is asked once per run for an honest report. A negation counts only inside the claim's own clause: in "No errors, verified it works" the "No" is about the errors. If the detector misses a claim, the user still reads the notice, and the notice says that no check ran.

Pinned:
- golden run 4: no ask, the notice is under the node's answer;
- golden run 5: a check tool is registered, and block and resume still hold;
- golden run 7: a claimed check is asked once, then the notice;
- `src/agents/autonomy/verifier-pipeline-unverifiable.test.ts`: every row in both directions;
- `src/agent-core/engine/reflection.unverified-notice.test.ts`: the interactive, background and reflection boundaries.

## Rejected alternatives
- **Decide "no verification tool" from the draft** ("this project has no build and no tests"). That judges the run by its prose.
- **Ask until the draft says "not verified", then close** (versions 1-3). That made the user's text the model's job, and the vocabulary check fell open: "nothing is left unverified" and "no unverified assumptions remain" read as admissions, so drafts that claimed tests passed closed the gate (QA, 2026-11-16). The orchestrator's steer the same day named the pattern across all three QA failures: each soft signal fell open when unsure. Hence the table, unknowns that keep the gate, and a notice the system writes itself.
- **Count shell_exec as a check tool.** It is on every run's offer, so the exit would never apply.
- **Ignore shell_exec, judging by the check tools alone** (the first version of this change). The registry has dedicated check tools for .NET and Unity only, so every Node, Python or Go project read as "nothing can verify", though the pipeline counts a shell `npm test` as a verification. QA measured it on 2026-11-15: a project with a test script closed the gate and no test ran.
- **Append the notice in each of the four handler paths** that turn an approve into visible text. Two of those files are past the 1,000-line limit, the background path may rewrite the draft through synthesis, and a path missed would show "done" with no notice. Instead the one boundary every finished run passes appends it.
- **Close any failure once the registry has no check tool.** A step that failed and was never re-run has not been repaired. It still waits.
- **Count any later success of the same tool as a re-run** (the second version). QA measured it on 2026-11-16: `node main.js` crashed, a file was edited, `shell_exec ls` succeeded, and the crash read as "re-run successfully". Only a writer may be answered by a different input.
- **Count any later write of the same writer as an answer** (the fourth version). QA measured it on 2026-11-16: the task asked for notes/alpha.txt and notes/beta.txt, the alpha write failed, beta was written, and the notice told the user alpha was "redone". Alpha was never written.
- **Count only declared scripts and manifests** (the second version). It missed what a runner finds by itself: a tsconfig.json (`tsc --noEmit`), a conftest.py or a test file (`pytest`), vitest among the devDependencies (`npx vitest run`).

## Consequences
The measurement reads the turn's offer, not the full registry. The orchestrator gives the pipeline no other list, and `orchestrator.ts` may not grow. A turn narrowed in a way not listed above would hide a check tool and wrongly open this exit. Add the narrowing to `measureVerificationTooling` when one appears.

The manifests are read from the orchestrator's project root (`InterventionDeps.projectPath`), not from the worker's workspace lease. A manifest the worker creates in its lease during the run is not seen until the lease is published.
