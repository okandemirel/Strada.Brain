---
id: vendored-mcp-needs-its-dependencies
kind: gotcha
tier: 1
status: active
topics: ["unity-mcp", "ops"]
paths: ["src/config/strada-deps.ts", "src/core/terminal-wizard.ts"]
purpose: "Stop a run from proceeding with no Unity tools at all because the vendored MCP has no node_modules."
summary: "A vendored Strada.MCP needs npm install inside it, or every Unity tool silently vanishes"
decided_on: 2026-08-23
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
A game project skeleton assembled by hand had no `node_modules` in its vendored Strada.MCP. Boot threw "Cannot find package", and two runs proceeded with none of the Unity tools. The only trace was one warning line. `strada-deps.ts` reports the MCP as installed when its checkout exists, and never checks that its dependencies resolve.

## Decision
After creating or copying a project skeleton, run `npm install` in its vendored Strada.MCP before judging what a run did or did not call. Confirm with the boot line "Loaded Strada.MCP tools into main toolchain". Its absence means the whole toolchain is gone, not that a tool went unused. The setup wizard does this step itself.

## Rejected alternatives
- **Trust the preflight's "installed".** It measures the checkout, not the package.

## Consequences
Preflight should check dependency resolution, not only that the checkout exists. That fix is not yet made.
