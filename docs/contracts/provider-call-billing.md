---
id: provider-call-billing
status: active
scope: "Every call from src/ that reaches an LLM provider's chat or chatStream outside the engine's model turns: who pays for its tokens, and the one path that writes them to /api/metrics, the rate limiter's daily wall and the cost ledger."
read_trigger: "Before you write provider.chat(, .chatStream(, streamOrChatText( or billedChat( anywhere in src/; when src/agents/providers/billed-call-tripwire.test.ts names a file; when the budget wall, /api/metrics or the cost ledger reads lower than the provider's bill."
keywords: ["billing", "token usage", "usage", "cost ledger", "rate limiter", "daily budget", "metrics", "provider.chat", "streamOrChatText", "billedChat", "billedStreamOrChatText", "onUsage", "recordProviderUsage", "auxiliaryUsage", "faturalama", "bütçe", "maliyet"]
related: ["file-size"]
single_producer: {"file": "src/agents/providers/billed-call.ts", "exports": ["billedChat", "billedStreamOrChatText", "installProviderUsageLedger"]}
rules:
  [{"id": "direct-provider-call-is-billed", "severity": "error", "text": "A provider call outside the engine's self-billing paths goes through billedChat or billedStreamOrChatText and names who pays; a new direct call, a renamed streamOrChatText import, or a file that bills one call through both paths fails.", "detector": {"kind": "vitest", "file": "src/agents/providers/billed-call-tripwire.test.ts"}}]
---
# Provider call billing: every direct call names who pays

A model turn is billed by the engine. Every other provider call used to read
the reply's text and drop its usage, so its tokens reached no cost ledger, no
daily wall and no dashboard counter. The same gap surfaced three times as
"one more caller":

- The goal decomposer billed nothing (task #67, 2026-11-11). Measured with the
  real class: a plan call billed 1,800 in and 600 out, and the run took 0.
- Ten more call sites were found the same day (task #71): node verification,
  capability triage, campaign planning, the acceptance writer, visual
  conformance, style analysis, session summaries, chain synthesis, vault
  symbol summaries and the autonomous loop's reasoning.

Measured on invented design documents, with prompt size divided by four as
the token count: one coverage audit or one style analysis of a 400,000-character
document sends about 100,000 input tokens. That is a fifth of the rate
limiter's default daily token quota (500,000), and none of it was counted.

The fix closes the class instead of patching ten sites. Patching each site
with its own hook was rejected: it needs a ledger dependency threaded
through ten constructors and ten copies of the "not measured" rule, and it
does nothing for the eleventh caller.

## Single producer

`src/agents/providers/billed-call.ts`:

- `billedChat` and `billedStreamOrChatText` make the call with the caller's
  arguments and bill it.
- `installProviderUsageLedger` takes the process ledger, which bootstrap
  installs once (`src/core/bootstrap-spend-counters.ts`).
- The ledger itself is `createProviderUsageLedger` in
  `src/agent-core/engine/accounting.ts`. It ends at the hook a model turn
  bills through, `recordProviderUsage` (metrics, the rate limiter, the run's
  onUsage).

The billing rules live in the producer, not in the callers:

- Each reply that came back is billed once.
- What superseded attempts spent (`auxiliaryUsage`) is billed as the chain
  records it, and so is what a call that threw spent (`error.usage`).
- A reply with no usage, or 0 in and 0 out, is logged "not measured" and
  writes no zero.

## Caller rules

- **Name who pays, nothing else.** Pass `{ purpose, run: { onUsage } }` when
  the call is part of a run, and the run's onUsage books the run's ledger
  row. Pass `{ purpose, ownerless: <BudgetSource> }` when no run owns the
  call; it is then booked to the cost ledger under that source, with
  `purpose` as its trigger. Who pays today:

  | Call | Pays |
  | --- | --- |
  | supervisor node verification, capability triage | the supervisor run (`SupervisorContext.onUsage`) |
  | campaign planning, acceptance writer, visual conformance, style analysis | `chat`: the campaign's own tasks are origin "user", which books as chat |
  | session summary, chain synthesis, agent-core reasoning | `daemon`: background work no run awaits (memory consolidation books there too) |
  | vault symbol summary | `chat`: a user asks for it from the dashboard |

- **Keep the engine's paths where they are.** Model turns, review, reviewer
  and consensus calls, and the goal decomposer bill through
  `recordProviderUsage` or `recordAuxiliaryUsage` themselves. They are
  allowlisted by name in the tripwire. Moving one onto the choke point means
  removing its own billing in the same change.
- **Raise an allowlist count only with the reason the new call is billed.**
  Lower it when a call goes away.

## Don't

- Call `provider.chat`, `chatStream` or `streamOrChatText` from a file outside the tripwire's allowlist, import `streamOrChatText` under another name, or bill one call through both billed-call.ts and the engine's own billing. {#direct-provider-call-is-billed}
- Write a second ledger or counter for a caller. The counters are the ones the model turns use.
- Bill a missing usage as zero. Log it "not measured".

## What it cannot see

- A provider method taken into a variable (`const f = provider.chat; f()`).
- A call through a wrapper defined in an allowlisted file and used elsewhere.
- Other paid endpoints: embeddings and image generation.
- Code outside `src/`, and the test helpers under `src/tests/`.
- Two known residues stay allowlisted with their reason until their
  follow-ups land. Memory consolidation (`stage-agents.ts`) books the cost
  ledger but neither the rate limiter nor metrics. The fallback chain's
  health probe is unbilled.
