# Microsoft Teams — Manual Verification Runbook

Automated tests cannot reach a real Teams tenant, so the Teams channel must be
verified by hand against a live Azure Bot before it is considered shipped. This
runbook is the complete, step-by-step checklist.

It specifically exercises the fixes that have no automated coverage:

- **Async (delayed) delivery** — a long-running answer is delivered *after* the
  inbound HTTP turn context is gone, via a persisted conversation reference
  (the original bug never delivered it).
- **Single-tenant auth** — `MicrosoftAppType=SingleTenant` +
  `MicrosoftAppTenantId` must be threaded into the adapter or proactive
  (`continueConversationAsync`) sends fail. Wired in `bootstrap-channels.ts` as
  of `d1ec3b61`; this runbook is how you confirm it on a real tenant.
- **Restart-mid-task reference persistence**, **18k+ char chunking**,
  **allowlist gating**, **feedback reactions**.

Relevant code: `src/channels/teams/channel.ts`, `src/core/bootstrap-channels.ts`
(case `'teams'`), `src/config/config.ts` (`teams*` keys).

---

## Part A — Setup

### 1. Install the optional Teams dependencies
`botbuilder` and `botframework-connector` are declared in
`optionalDependencies`, so a normal `npm ci` / `npm install` already installs
them. Confirm they are present in the deploy environment:

```bash
node -e "require.resolve('botbuilder'); require.resolve('botframework-connector'); console.log('teams deps OK')"
```

If the install was run with `--omit=optional` (or they failed to build on the
platform), install them explicitly:

```bash
npm install botbuilder botframework-connector
```

The channel loads them via a dynamic `import()`; if they are missing, `connect()`
throws at boot and the Teams channel will not start.

### 2. Create / locate the Azure Bot + app registration
- In the Azure portal, create an **Azure Bot** resource (or reuse an existing one).
- Note the **Microsoft App ID** (client ID).
- Create a **client secret** under the app registration → this is the
  **App Password**.
- Decide the **tenancy** of the app registration:
  - **Multi-tenant** (default) — works across tenants.
  - **Single-tenant** — issued tokens are scoped to one home tenant; you also
    need the **Tenant ID**.

### 3. Configure environment variables
Set in the deploy environment (e.g. `.env`):

| Variable | Required | Notes |
|---|---|---|
| `CHANNEL` | yes | set to `teams` |
| `TEAMS_APP_ID` | yes | Microsoft App ID |
| `TEAMS_APP_PASSWORD` | yes | client secret |
| `TEAMS_APP_TYPE` | single-tenant only | `MultiTenant` (default) or `SingleTenant` |
| `TEAMS_APP_TENANT_ID` | single-tenant only | home tenant GUID |
| `TEAMS_ALLOWED_USER_IDS` | recommended | comma-separated AAD object IDs / UPNs allowed to DM the bot |
| `TEAMS_ALLOW_OPEN_ACCESS` | optional | `true` opens the bot to all senders (default `false` = deny-all unless allowlisted) |

Confirm install / build / config / embedding readiness with the built-in doctor:

```bash
node dist/index.js doctor      # checks install, build, config, and embedding readiness
```

> The single-tenant pair (`TEAMS_APP_TYPE`/`TEAMS_APP_TENANT_ID`) is now
> asserted in `src/config/config.test.ts` and threaded through to the adapter.

### 4. Expose the local messaging endpoint
The channel listens on `127.0.0.1:3978` and serves `POST /api/messages`.

- Start a tunnel to `http://127.0.0.1:3978` (e.g. `ngrok http 3978`, dev tunnel,
  or your reverse proxy).
- In the Azure Bot resource → **Configuration** → **Messaging endpoint**, set:
  `https://<your-tunnel-host>/api/messages`.

### 5. Build and boot
```bash
npm run build
node dist/index.js     # or your normal start command
```

Confirm in the logs:
- `Teams channel listening { port: 3978, host: "127.0.0.1" }`
- No `botbuilder` import error.
- For single-tenant: no auth/JWT errors on the first inbound message.

### 6. Add the bot to Teams
Add the bot to Teams (App Studio / Developer Portal manifest, or sideload), then
open a 1:1 chat with it.

---

## Part B — Functional verification matrix

For each step record PASS/FAIL and notes. Steps 7–14 are the acceptance set.

### 7. Basic round-trip
Send a short DM (e.g. `hello`). **Expect:** a reply in the same chat within a few
seconds.

### 8. CRITICAL — delayed (async) delivery
Send a request that takes **30–120s** to answer (e.g. a multi-step task or a long
analysis). **Expect:** the answer arrives **after** the delay, in the same chat.

This is the core regression: the inbound HTTP turn context is torn down when the
request returns, so the late reply must be delivered **proactively** via the
persisted conversation reference. Before the fix, this answer never arrived.

- Watch logs for the proactive send (`continueConversationAsync`).
- **FAIL signature:** log line `Teams cannot deliver reply: no active turn
  context or stored conversation reference`, or no message ever arrives.

### 9. 18k+ character chunking
Ask for a very long answer (> 18,000 chars). **Expect:** multiple sequential
messages, in order, with no truncation and no dropped final chunk. Chunk size cap
is `TEAMS_MAX_MESSAGE_LENGTH = 18_000`.

### 10. Restart-mid-task (reference persistence)
1. Send a long-running request (as in step 8).
2. **Before it finishes**, restart the daemon (stop + start).
3. **Expect:** after restart, the reply is still delivered to the chat.

Mechanism: conversation references are mirrored to
`.strada/teams-conversation-references.json` and restored on `connect()`.

- Confirm the file exists and contains your chat after the first message.
- **FAIL signature:** reply lost after restart, or the references file missing/empty.

### 11. Allowlist denial
With `TEAMS_ALLOW_OPEN_ACCESS=false` and a non-empty `TEAMS_ALLOWED_USER_IDS`,
send a DM from a user **not** on the allowlist. **Expect:** the message is
ignored — no processing, no reply.

### 12. Open-access mode (optional)
Temporarily set `TEAMS_ALLOW_OPEN_ACCESS=true`, restart, and send from a
non-allowlisted user. **Expect:** it is now answered. **Revert to `false`
afterwards.**

### 13. Single-tenant vs multi-tenant auth
This is what loose-end #1 (`d1ec3b61`) fixed — verify both modes:

- **Single-tenant:** set `TEAMS_APP_TYPE=SingleTenant` + `TEAMS_APP_TENANT_ID=<tenant
  GUID>` matching a single-tenant app registration. Reboot. Run steps 7 **and 8**
  (the proactive path is the one that breaks without correct tenancy).
  **Expect:** both inbound and the delayed proactive reply succeed.
  **FAIL signature:** auth/401 or token-audience errors on the proactive send.
- **Multi-tenant:** unset `TEAMS_APP_TYPE`/`TEAMS_APP_TENANT_ID` (defaults to
  `MultiTenant`) with a multi-tenant registration. Reboot. Re-run steps 7–8.
  **Expect:** still works (no regression).

### 14. Feedback reactions
Send a thumbs-up / thumbs-down (reaction or the text the bot recognizes).
**Expect:** an acknowledgment message (e.g. "Thanks for the positive
feedback!") and, if learning is enabled, the feedback is attributed to the most
recent response's instinct IDs.

---

## Sign-off

| # | Check | Result | Notes |
|---|---|---|---|
| 7 | Basic round-trip | ☐ | |
| 8 | Delayed (async) delivery — CRITICAL | ☐ | |
| 9 | 18k+ char chunking | ☐ | |
| 10 | Restart-mid-task persistence | ☐ | |
| 11 | Allowlist denial | ☐ | |
| 12 | Open-access mode | ☐ | |
| 13 | Single-tenant + multi-tenant auth | ☐ | |
| 14 | Feedback reactions | ☐ | |

Teams is verified once 7–11, 13, and 14 PASS (12 is an optional toggle check).
