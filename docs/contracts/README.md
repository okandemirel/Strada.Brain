# Contracts

Each contract here is a behaviour that broke once and was then pinned. A
contract names three things: the single place its behaviour lives, what not to
do, and the test that fails when the rule is broken. Open the contract
**before** you change code in its area. The "Read when" column says when that
is.

| Contract | Scope | Read when |
| --- | --- | --- |
| [path-containment](path-containment.md) | Whether a path lies inside a project, lease, vault or install root | Writing any "inside / under / within" check; comparing a realpath with a typed path; something is called "outside the project" that is not |
| [esm-no-require](esm-no-require.md) | Loading modules in this ESM package | Writing `require(`, a lazy or optional import, or a try/catch around a load; a capability reads "unavailable" with no logged error |
| [gate-needs-an-asker](gate-needs-an-asker.md) | `[STRADA …]` gates and the prompt sentences that ask for what they judge | Adding, renaming or tightening a gate; editing a planner or knowledge-prompt rule or a Strada tool description; a run fails the same gate sprint after sprint |
| [test-integrity](test-integrity.md) | Changing an existing test: removing, skipping, commenting out or rewriting a case or assertion; moving a ratchet's pinned number | Before editing a test because it fails; before any skip/only/todo; before raising a BASELINE or PINNED number; when check-test-integrity prints |
| [file-size](file-size.md) | How long a source file under `src/` may grow | Adding code to a file near or over 1,000 lines; when the size ratchet names a file |
| [governance](governance.md) | The files that enforce the rules: the commit checker, hooks, workflows, contracts | Before changing the checker, a hook, a workflow, a contract or src/contracts.test.ts; when the checker prints 'governed file changed' |

## Adding a contract

- **When to write one.** Write a contract when the same mistake has been made
  twice, or once at real cost. A decision that was discussed and settled is not
  a contract. A one-off mistake goes nowhere.
- **Anatomy.**
  - The frontmatter holds `id` (the file name), `status` (`active` or `draft`),
    `scope`, `read_trigger`, `keywords`, an optional `single_producer`
    (`{"file", "exports"}`), and `rules`.
  - Each rule has a content-keyed `id` (never a position such as `dn-2`), a
    `severity` (`error` or `warn`), its `text`, and a `detector`.
  - The body has three sections: `## Single producer`, `## Caller rules` and
    `## Don't`. Each rule's id appears on its Don't line as `{#id}`.
- **Every rule needs a detector.** `src/contracts.test.ts` refuses a rule that
  has none. Today the one detector kind is `vitest`: a test file that fails
  when the rule is broken and names `docs/contracts/<id>.md` in its text. A
  detector may not contain `.skip(`, `.only(` or `.todo(`.
- **Frontmatter format.** Frontmatter is YAML, and every structured value is
  written in JSON flow style (`["a", "b"]`, `{"k": "v"}`). This lets the
  checker read it without a YAML library.
- **Drafts cannot gate.** A `draft` contract may not carry an `error` rule.
- **What changes with a new contract.**
  - Add a row to the table above.
  - Add at most one row to the router table in `AGENTS.md`, and only if the
    area is touched weekly.
  - Update the pinned counts in `src/contracts.test.ts`. A count that moves
    shows up in the diff, so a rule cannot quietly stop gating.
