---
id: shell-runs-what-the-project-declares
kind: decision
tier: 1
status: active
topics: ["agent-loop", "evidence"]
paths: ["src/agents/autonomy/verifier-pipeline-project-commands.ts", "src/agents/autonomy/verifier-pipeline-unverifiable.ts", "src/agents/autonomy/verifier-pipeline.ts"]
purpose: "Keep the unverifiable-failure exit from opening in a project the shell can verify (npm test, pytest, cargo test), without closing it for the notes-only project it was made for."
summary: "With shell_exec in the offer, the unverifiable-failure exit also needs the project's source root to declare no build or test command, read from its manifests; a declared command or an unrecognised project type keeps the gate"
decided_on: 2026-11-11
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
The unverifiable-failure exit (`unverifiable-failure-closes-on-an-honest-report`) reads "nothing here can verify" from the turn's tool offer, where `shell_exec` is not a check tool. A shell runs `npm test`, and the completion review counts that run as a verification (`isVerificationStep`). So in a project whose only check is a shell command, a failure re-run successfully closed on one ask without the test ever running.

## Decision
`measureProjectCommands` (`src/agents/autonomy/verifier-pipeline-project-commands.ts`) reads the project's source root (`sourceProjectPath`, never a workspace lease) and answers `commands`, `none` or `unknown`. The planner calls it only when the offer holds a shell and every other exit condition holds. The exit then needs `none`. The record lands in `evidence.verificationTooling.projectCommands`: the root, that it is the source root, and each manifest with what it declares. The closing summary names them too.
- `commands`: a package.json build/test script (npm's `echo "Error: no test specified" && exit 1` placeholder is not one), a pytest/tox configuration or a `test_*.py` file, a .sln/.csproj, a Unity project, or a build system that carries its own commands (Cargo.toml, go.mod, Makefile, Gradle, CMake, tsconfig.json and the others in `BUILD_SYSTEM_FILES`).
- `unknown`: an unreadable root, directory or manifest, source code of a language with no manifest here, or more than 5,000 entries. The gate stays: an unknown project type may have a command.
- `none`: nothing declared, and every source file found belongs to a language whose manifest was read and declared nothing, or there is no source at all (golden run 4's README-only project).

## Rejected alternatives
- **Count shell_exec as a check tool.** It is on nearly every offer, so the exit would never apply, including golden run 4.
- **Read the lease.** It is the worker's copy. A test script the worker wrote there this run is not the project's verification path.
- **Treat a project with no recognised manifest as `none`.** A `src/main.rs` with no Cargo.toml would then relax the gate on what was not read.

## Consequences
A language or build system not listed reads as `unknown` when its source is present, which keeps the gate. Add the manifest to the module when one appears.
