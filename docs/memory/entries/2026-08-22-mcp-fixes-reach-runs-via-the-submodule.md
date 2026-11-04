---
id: mcp-fixes-reach-runs-via-the-submodule
kind: gotcha
tier: 1
status: active
topics: ["unity-mcp"]
paths: ["src/config/strada-deps.ts", "src/core/strada-mcp-tool-loader.ts"]
purpose: "Stop a Strada.MCP fix from being reported as live in runs when no run can load it."
summary: "A run loads Strada.MCP from the game's vendored submodule, not from the standalone repository"
decided_on: 2026-08-22
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
A run loads Strada.MCP from `<unity-project>/Packages/Submodules/Strada.MCP`. Fixes committed to the standalone repository sat a dozen commits ahead of the submodule and were reported as "live next run", which none of them could be. Later it turned out that both copies run: the daemon loads the vendored copy and a delegated sub-agent loaded the standalone one. Each copy has its own gitignored `dist/`, so a commit never rebuilds either.

## Decision
Before claiming that an MCP fix affects a run, grep the submodule's source and its `dist/` for a symbol the fix introduces. A live fix needs four things: the source change, a `dist/` rebuild, a push to origin, and a submodule update in the game project. The boot log line "Strada.MCP found {path}" names the copy that was loaded.

## Rejected alternatives
- **Treat a commit to the standalone repository as live.** The paths look identical from inside Strada.MCP; only the boot log tells them apart.

## Consequences
Brain has no such indirection: it runs from its own repository, and its fixes are live at the next process start.
