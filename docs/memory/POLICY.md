# Team memory policy

This directory holds the decisions, gotchas and spike results of the agents
that develop Strada.Brain. It is versioned and shared by every tool: Claude
Code, Codex, and whatever comes next. It replaces knowledge that used to live
in one agent's private notes, where no other agent could see it and nothing
checked it.

## What goes where

| Kind of knowledge | Where it lives | Why |
| --- | --- | --- |
| A rule with enforcement | `docs/contracts/` | Versioned, reviewed, checked by a detector |
| A decision, gotcha or spike result | `docs/memory/entries/` | Stops the same argument or the same trap twice, but enforces nothing |
| A personal preference or a local machine detail | The agent's own memory | It concerns nobody else |
| Work state: what is running, what is next | `git log`, CI and the run itself, read live | Stale within a day |

Two rules, verbatim:

- **Memory is not a status board.** Run, ticket and deploy state is read live
  from `git log`, CI and the run's own stores. It is never mirrored here.
  Stale state is worse than no state, because it is read as current.
- **A durable technical rule goes into a contract, not into memory.** If an
  entry says something the team must obey, that is the signal to open a
  contract (`docs/contracts/README.md`). The entry then points at it.

## Reading

1. `CORE.md` is read at the start of every session. `AGENTS.md` says so.
   It holds tier-0 entries only, and it has a hard limit of 40 lines.
2. `INDEX.md` is scanned before you enter an area. Open only the entries
   whose topic or paths match your change; typically two to five.
3. `entries/` is opened on demand and never read in bulk. When an entry has a
   `conflicts_with`, read both sides. Always read the entries whose kind is
   `gotcha` for the area you are in.

`CORE.md` and `INDEX.md` are DERIVED from `entries/` by
`node scripts/memory-index.mjs`. Never edit or hand-merge them. Regenerate
them in the same change as the entry. `src/team-memory.test.ts` fails when
they are out of date.

## Capturing

An entry is written only if it passes **all three** tests:

1. **Will it recur?** Someone will need it again.
2. **Is it not derivable?** It cannot be read quickly from the code, the
   git history or a contract.
3. **Is not knowing it costly?** Missing it leads to a wrong decision or
   costs about 30 minutes.

When to capture: after choosing between alternatives (deciding NOT to do
something counts), after finding a non-obvious root cause, when the owner
corrects an approach, when a spike concludes, when an external constraint
turns up, and when a large piece of work closes.

Never capture: run or sprint state, personal preferences, anything a
contract already says, commit-message material, or speculation that is not
yet a decision.

Steps:

1. **Dedupe against `INDEX.md`.** Update or supersede the entry on the same
   topic; never copy it.
2. **Check for contradictions (mandatory).** Never write a silent
   contradiction. Do one of these:
   - narrow the scopes so the entries no longer overlap;
   - supersede the old entry, with the reason;
   - set `conflicts_with` on both entries and say what is unresolved.
3. **Pick topics** from `topics.yaml`. The default is tier 1. Tier 0 needs a
   reason and must fit in CORE's 40 lines.
4. **Write the entry**, run `node scripts/memory-index.mjs`, and commit them
   together.
5. **Announce it** in one line in the conversation: `team-memory: <summary>`.

## Entry format

`entries/<YYYY-MM-DD>-<slug>.md`, with JSON-flow frontmatter (the checker
reads it without a YAML library):

```
---
id: <slug>
kind: decision            # decision | guideline | gotcha | spike
tier: 1                   # 0 = in CORE.md, needs a reason in `tier_reason`
status: active            # active | superseded
topics: ["<from topics.yaml>"]
paths: ["src/<area>/**"]
purpose: "<what this entry stops — 'stop X from …'>"
summary: "<one sentence: what was decided or found>"
decided_on: YYYY-MM-DD
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
## Decision
## Rejected alternatives
## Consequences
```

`Rejected alternatives` is never left empty. It is the section that stops
the next agent from proposing what was already tried. When nothing was
rejected, say why.

## Confidentiality

The repository is public. An entry never names, quotes or counts anything
from an external project Strada.Brain was run against: no names, design text,
campaign ids or that project's numbers. Describe Brain's behaviour, and
invent any example. `src/universality.test.ts` checks these files like every
other publishable file.
