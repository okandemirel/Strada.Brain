---
id: governance
status: active
scope: "The files that enforce this repository's rules: the commit checker, the git hooks and their installer, the CI workflows, the contracts, the checker of contracts, and the repo-map doctor."
read_trigger: "Before you change scripts/ci/check-test-integrity.mjs, scripts/git-hooks/*, scripts/install-git-hooks.mjs, .github/workflows/*, a contract in docs/contracts/, src/contracts.test.ts or scripts/repo-map-doctor.mjs; when the commit checker prints 'governed file changed'."
keywords: ["governance", "governed paths", "Governance-Change", "CI", "workflow", "hook", "pre-push", "contract", "checker", "self-loosening", "pinned gate", "yönetişim"]
related: ["test-integrity"]
rules:
  [{"id": "governed-change-says-why", "severity": "error", "text": "A commit that changes a file enforcing the rules carries a Governance-Change: line saying what rule changes and why, and CI judges every push with the checker from its base commit.", "detector": {"kind": "vitest", "file": "src/governance.test.ts"}}]
---
# Governance: who may change the rules

No person reviews a push in this repository. Agents commit straight to main,
and the owner runs no commands. The agent-infrastructure document's answer
for teams is CODEOWNERS plus branch protection, and that answer does not fit
here: CODEOWNERS blocks nothing without a pull-request flow, and there is
none. What fits is this document's other point. The code that runs a gate is
pinned, so a change cannot loosen a check and then pass under the loosened
check in the same push.

The failure this contract prevents was found while the check was being
built (2026-11-04). The first version of the test-integrity step ran the
checker from the pushed commit. A commit could have edited
`check-test-integrity.mjs` to stop counting skips, and then been judged by
that edited checker.

## Single producer

`scripts/ci/check-test-integrity.mjs` holds the governed list (`GOVERNED`) and
judges each commit against it.

- **CI** (`.github/workflows/ci.yml`, verify job) runs the checker as it was in
  the push's base commit, not as the push left it.
- **The pre-push hook** does the same with the remote's copy.

## Caller rules

- **Explain a change to a governed file in the commit itself.** Add a line
  `Governance-Change: <what rule changes, and why the old one was wrong or
  incomplete>`. This line is the review: there is no other.
- **Expect a checker change to apply from the next push.** The push that
  carries a change to the checker is judged by the old checker. That is
  intended.
- **Know what is governed.** Records are not governed, rules are. The
  contracts' index, the team memory, the repo map's cards
  (`docs/architecture/repo_map.yaml`), and baseline numbers that go down change
  as work happens. Gating them would block the work that keeps them honest.
  The repo-map doctor that derives and checks the map is a rule, and is
  governed.
  A pinned number that goes *up* is caught by the test-integrity contract.

## Don't

- Change a governed file without a `Governance-Change:` line in that commit. {#governed-change-says-why}
- Run the checker from the pushed tree in CI.
- Add CODEOWNERS or branch-protection settings as if they enforced something here. Without a pull-request flow they do not.

## What it cannot see

- A change to a detector's own logic: for example, narrowing a ratchet's
  regular expressions inside `src/*-ratchet.test.ts`. Those files also hold
  baselines, which change all the time, so they are not on the governed
  list. A removed case or assertion there is still caught by test integrity.
