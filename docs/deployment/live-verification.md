# Live Verification Runbook — Channels & Providers

Automated tests in this repo run **in-process** against real local SQLite and
in-memory objects. They deliberately **never** touch a real Discord/Slack/Teams
workspace or a real OpenAI/Kimi/Gemini/Ollama endpoint — those need live
credentials and a network, so they cannot be unit-tested honestly.

This runbook is how a human operator proves the parts that the test suite cannot.
**It verifies nothing by itself.** It is the procedure + the one round-trip you
run **with your own real credentials** to get a real green. Every step below
requires your live secrets/services; the harness only makes that verification
*possible*.

Companion script: `scripts/provider-smoke.mjs` (Part C) automates the
single provider round-trip. There is also the existing, deeper Teams runbook at
`docs/deployment/teams-verification.md` (Part B step "teams" points to it).

Relevant code:
- Channels: `src/channels/<name>/`, wired in `src/core/bootstrap-channels.ts`.
- Providers: `src/agents/providers/` (`provider-registry.ts`,
  `provider-manager.ts`), credential collection in `src/core/provider-config.ts`,
  boot wiring in `src/core/bootstrap-providers.ts`.
- Config / env mapping: `src/config/config.ts`.

---

## Part 0 — Prerequisites (do this once)

```bash
npm ci
npm run build          # produces dist/ — every boot/smoke command below uses it
node dist/index.js doctor   # checks install, build, config, embedding readiness
```

Secrets live in the resolved `.env` (for a source checkout that is the repo root;
see `src/common/runtime-paths.ts → resolveDotenvPath`). **Never commit `.env`.**

Supported channel types (from `src/common/constants.ts`):
`web, telegram, discord, whatsapp, cli, slack, matrix, irc, teams`.

Two equivalent ways to select a channel at boot:

```bash
node dist/index.js --discord                 # root flag shortcut
node dist/index.js start --channel discord   # explicit start subcommand
```

`web` is the default channel. A graceful shutdown is `Ctrl-C` (SIGINT) or
`node dist/index.js kill`.

> **Honesty note.** A PASS here means *this operator, with these credentials, on
> this machine, at this moment* got a real round-trip. It is not a substitute for
> CI and it does not generalize to other tenants/keys.

---

## Part A — How to read each entry

Each channel/provider below gives you:

- **Required env / credentials** — the minimum `.env` keys.
- **Boot command** — the exact command to start it.
- **Round-trip test** — the single action you perform.
- **Expected log line(s)** — what a healthy boot/round-trip prints.
- **FAIL signature** — what failure looks like.

Log lines are emitted by `winston` in the format
`<timestamp> [level] <message> <json-meta>`. Grep the console or the configured
`LOG_FILE`.

---

## Part B — Channels

### discord

| | |
|---|---|
| **Env** | `DISCORD_BOT_TOKEN` (required); `DISCORD_GUILD_ID`, `ALLOWED_DISCORD_USER_IDS`, `ALLOWED_DISCORD_ROLE_IDS` (recommended for allowlisting) |
| **Boot** | `node dist/index.js --discord` |
| **Round-trip** | In a server/DM the bot can see, send `@StradaBot hello` (or a DM `hello`). |
| **Expected logs** | `Starting Discord bot...` then `Discord bot connected as <tag>` / `Discord bot logged in as <tag>`. A reply appears in the same channel within a few seconds. |
| **FAIL signature** | No `connected as` line (token invalid → discord.js login throws); `Scheduling Discord reconnection` looping (gateway/intents issue); message ignored = sender not on the allowlist. |

### slack

| | |
|---|---|
| **Env** | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` (required); `SLACK_APP_TOKEN` + `SLACK_SOCKET_MODE=true` for Socket Mode (default is socket mode unless disabled); `ALLOWED_SLACK_WORKSPACES`, `ALLOWED_SLACK_USER_IDS` (recommended) |
| **Boot** | `node dist/index.js --slack` |
| **Round-trip** | DM the bot or `@mention` it in a channel it is in: `hello`. |
| **Expected logs** | `Slack channel connected { ... socketMode: true }`. A reply lands in the same conversation. |
| **FAIL signature** | No `Slack channel connected` line (bad bot/app token or, in HTTP mode, the request URL/`SLACK_SIGNING_SECRET` mismatch); `Slack channel disconnected` immediately after connect. In non-socket (HTTP) mode the events endpoint must be reachable on the configured port. |

### telegram

| | |
|---|---|
| **Env** | `TELEGRAM_BOT_TOKEN` (required); `ALLOWED_TELEGRAM_USER_IDS` (recommended) |
| **Boot** | `node dist/index.js --telegram` |
| **Round-trip** | Open the bot in Telegram, send `hello`. |
| **Expected logs** | `Starting Telegram bot...` then `Telegram bot started: @<username>`. Reply in the same chat. |
| **FAIL signature** | No `Telegram bot started` line (401 from BotFather token); message ignored = sender id not in `ALLOWED_TELEGRAM_USER_IDS`. |

### whatsapp

| | |
|---|---|
| **Env** | `WHATSAPP_SESSION_PATH` (where the auth session is stored), `WHATSAPP_ALLOWED_NUMBERS` (recommended) — no API key; pairing is via QR. |
| **Boot** | `node dist/index.js --whatsapp` (run attached to a TTY so the QR renders). |
| **Round-trip** | First run: scan the QR printed in the terminal with WhatsApp → Linked devices. Then message the linked number `hello`. |
| **Expected logs** | A QR code printed to the terminal (`printQRInTerminal`), then `WhatsApp connected!`. Reply in the same chat. |
| **FAIL signature** | `WhatsApp logged out. Delete session and re-scan QR.` (stale/invalid session at `WHATSAPP_SESSION_PATH`); no `WhatsApp connected!` after scanning = pairing failed. |

### teams

Teams has its own complete, deeper runbook because of async/proactive delivery,
single-tenant auth, chunking, and reference persistence.

| | |
|---|---|
| **Env** | `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` (required); `TEAMS_APP_TYPE`/`TEAMS_APP_TENANT_ID` for single-tenant; `TEAMS_ALLOWED_USER_IDS`, `TEAMS_ALLOW_OPEN_ACCESS` |
| **Boot** | `node dist/index.js --teams` (listens `127.0.0.1:3978`, `POST /api/messages`; needs a tunnel to the Azure Bot messaging endpoint) |
| **Round-trip** | Follow **`docs/deployment/teams-verification.md`** — at minimum its step 7 (basic round-trip) and step 8 (CRITICAL delayed/proactive delivery). |
| **Expected logs** | `Teams channel listening { port: 3978, host: "127.0.0.1" }`; no `botbuilder` import error. |
| **FAIL signature** | `Teams cannot deliver reply: no active turn context or stored conversation reference`; auth/401 on the proactive send (tenancy misconfig). See the Teams runbook. |

### matrix

| | |
|---|---|
| **Env** | `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID` (required); `MATRIX_ALLOWED_USER_IDS`, `MATRIX_ALLOWED_ROOM_IDS`, `MATRIX_ALLOW_OPEN_ACCESS` (access control) |
| **Boot** | `node dist/index.js --matrix` |
| **Round-trip** | Invite the bot user to a room (or DM it) and send `hello`. |
| **Expected logs** | `Matrix channel connected { userId: <MATRIX_USER_ID> }`. Reply in the same room. |
| **FAIL signature** | No `Matrix channel connected` line (bad homeserver URL or access token → sync rejected); message ignored = room/user not allowlisted and open-access off. |

### irc

| | |
|---|---|
| **Env** | `IRC_SERVER`, `IRC_NICK`, `IRC_CHANNELS` (required); `IRC_ALLOWED_USERS`, `IRC_ALLOW_OPEN_ACCESS` (access control) |
| **Boot** | `node dist/index.js --irc` |
| **Round-trip** | Join one of `IRC_CHANNELS` from another client and address the bot (`<IRC_NICK>: hello`). |
| **Expected logs** | `IRC channel connected { nick: <IRC_NICK>, server: <IRC_SERVER> }`. Reply in the channel. |
| **FAIL signature** | `IRC connection aborted (retries exhausted)`; `IRC link down: cannot send message (not connected)`; nick collision / no `connected` line. |

### web

| | |
|---|---|
| **Env** | none required to boot (defaults are local). `WEB_CHANNEL_PORT` (default `3000`) sets the port. |
| **Boot** | `node dist/index.js --web` (or just `node dist/index.js`; `web` is the default channel). First run with no valid config launches the browser **setup wizard** on the configured port. |
| **Round-trip** | Open `http://127.0.0.1:<WEB_CHANNEL_PORT>` (default `http://127.0.0.1:3000`), connect the websocket UI, and send `hello`. |
| **Expected logs** | `Web channel running at http://127.0.0.1:<port>` on the console. A streamed reply appears in the page. |
| **FAIL signature** | `Cannot start web mode because port ... is already in use` (another runtime; use `node dist/index.js status` / `kill` / `restart`); page loads but no reply = the provider chain is failing (run Part C). |

### cli

| | |
|---|---|
| **Env** | none for the channel itself (you still need a working provider — see Part C). |
| **Boot** | `node dist/index.js cli` (or `node dist/index.js --cli`) |
| **Round-trip** | At the prompt type `hello` and press Enter. |
| **Expected logs** | Console banner `=== Strada Brain CLI ===` then `Type your messages below. Type 'exit' or 'quit' to stop.`; an answer prints inline. |
| **FAIL signature** | `Brain not ready yet.` (bootstrap/provider not ready); no answer = provider chain failing (Part C). Exit with `exit`/`quit` → `Strada Brain CLI disconnected.` |

---

## Part C — Providers (the one round-trip)

All provider verification reduces to: **does one real, minimal completion succeed,
and which provider answered?** That is exactly what `scripts/provider-smoke.mjs`
does. It reuses the production wiring (`collectProviderCredentials`,
`detectConfiguredResponseProviders`, `createProvider`) and the same `.env`
resolution as the app, makes **at most one tiny call per provider**, stops at the
first success, and prints which provider answered.

```bash
npm run build
node scripts/provider-smoke.mjs            # try the whole configured order
node scripts/provider-smoke.mjs --list     # show what's configured, make NO call
node scripts/provider-smoke.mjs --provider kimi   # force one provider
```

Exit codes: `0` = a provider answered, or a clean skip (nothing configured);
`1` = a configured provider was tried and the live call failed; `2` = build
missing or config invalid.

Expected success output (the load-bearing line):

```
[smoke] ✅ ANSWERED BY: <provider name>
[smoke]    reply: "pong"
```

If nothing is configured it prints `[smoke] SKIP — no AI provider credentials
are configured.` and exits `0` — it does **not** crash or fake a call.

The per-provider rows below give the env keys and the FAIL signature. The
**boot** verification is identical for every provider: configure its keys, run
`node scripts/provider-smoke.mjs --provider <name>`, expect `ANSWERED BY`.

### openai-subscription (ChatGPT/Codex subscription)

| | |
|---|---|
| **Env** | One of: `OPENAI_AUTH_MODE=chatgpt-subscription`; **or** `OPENAI_SUBSCRIPTION_ACCESS_TOKEN` + `OPENAI_SUBSCRIPTION_ACCOUNT_ID`; **or** `OPENAI_CHATGPT_AUTH_FILE` (path to a local Codex `auth.json`). |
| **Round-trip** | `node scripts/provider-smoke.mjs --provider openai` |
| **Expected** | `ANSWERED BY: OpenAI` |
| **FAIL signature** | `OpenAI provider requires an API key or ChatGPT/Codex subscription auth` (no subscription creds resolved); 401/403 on the call = token expired / wrong account id. |

> An ordinary `OPENAI_API_KEY` is the **api-key** mode of the same provider; set
> it instead of the subscription vars if that is what you have.

### kimi (Moonshot)

| | |
|---|---|
| **Env** | `KIMI_API_KEY` |
| **Round-trip** | `node scripts/provider-smoke.mjs --provider kimi` |
| **Expected** | `ANSWERED BY: Kimi (Moonshot)` |
| **FAIL signature** | `Kimi (Moonshot) provider requires an API key`; 401 from `https://api.kimi.com/coding/v1` = bad/expired key. |

### openrouter

OpenRouter is now a **first-class provider** (`OpenRouterProvider`, registered in
`PROVIDER_CLASS_MAP` and `PROVIDER_PRESETS`, base URL `https://openrouter.ai/api/v1`).
It is OpenAI-compatible and authenticates via a dedicated `OPENROUTER_API_KEY`.

| | |
|---|---|
| **Env** | `OPENROUTER_API_KEY` (required), optional `OPENROUTER_MODEL` (default `openai/gpt-5.2` — override with any OpenRouter-namespaced model id), and add `openrouter` to `PROVIDER_CHAIN`. |
| **Round-trip** | `node scripts/provider-smoke.mjs --provider openrouter` |
| **Expected** | `ANSWERED BY: openrouter` |
| **FAIL signature** | `OpenRouter provider requires an API key` = no `OPENROUTER_API_KEY`; 401 = bad/expired key; 404 on the model = the configured `OPENROUTER_MODEL` id is not on OpenRouter's catalog (override it). |

> **Note.** Only the provider's HTTP behaviour against the real OpenRouter endpoint
> is unverified (unit tests cover header/auth/capability wiring with mocked fetch).
> The default model id `openai/gpt-5.2` is plausible but not confirmed against the
> live OpenRouter catalog — set `OPENROUTER_MODEL` to a model you know exists.

### opencode (Zen/Go)

| | |
|---|---|
| **Env** | `OPENCODE_API_KEY` (required), optional `OPENCODE_DEFAULT_MODEL` (default `qwen3.6-plus` — override with any bare model id, e.g. `deepseek-v4-flash`), and optional `OPENCODE_BASE_URL` (default `https://opencode.ai/zen/v1` — set `https://opencode.ai/go/v1` for the Go platform). |
| **Round-trip** | `node scripts/provider-smoke.mjs --provider opencode` |
| **Expected** | `ANSWERED BY: OpenCode (Zen/Go)` |
| **FAIL signature** | `OpenCode (Zen/Go) provider requires an API key`; non-2xx from `https://opencode.ai/zen/v1` (or configured base URL); `Model ... is not supported` = `OPENCODE_DEFAULT_MODEL` is no longer offered — override it with a currently available model. |

### ollama / local

| | |
|---|---|
| **Env** | none (no key). `OLLAMA_BASE_URL` (default `http://localhost:11434`). The local server must be running and have a model pulled. |
| **Round-trip** | `ollama serve` (in another shell) and e.g. `ollama pull llama3.3`, then `node scripts/provider-smoke.mjs --provider ollama`. |
| **Expected** | `ANSWERED BY: ollama` (or the labelled local provider). At app boot you also get `Ollama verified as reachable { baseUrl: ... }`. |
| **FAIL signature** | At boot: `Ollama is configured but unreachable at <url>; ... Start Ollama ('ollama serve') or fix OLLAMA_BASE_URL.` In the smoke script: a `fetch failed`/connection-refused error = server not running or wrong base URL or model not pulled. |

### gemini

| | |
|---|---|
| **Env** | `GEMINI_API_KEY` |
| **Round-trip** | `node scripts/provider-smoke.mjs --provider gemini` |
| **Expected** | `ANSWERED BY: Google Gemini` |
| **FAIL signature** | `Google Gemini provider requires an API key`; 401/403 from `https://generativelanguage.googleapis.com/v1beta/openai`. |

### deepseek

| | |
|---|---|
| **Env** | `DEEPSEEK_API_KEY` |
| **Round-trip** | `node scripts/provider-smoke.mjs --provider deepseek` |
| **Expected** | `ANSWERED BY: DeepSeek` |
| **FAIL signature** | `DeepSeek provider requires an API key`; 401 from `https://api.deepseek.com/v1`. |

> Other OpenAI-compatible presets exist in the registry and verify the same way
> (`--provider qwen|minimax|groq|mistral|together|fireworks`).

---

## Part D — End-to-end (channel + provider together)

The smoke script proves the **provider** half. To prove a real
channel-to-provider round-trip in one shot:

1. Configure one channel (Part B) **and** at least one provider (Part C).
2. `node scripts/provider-smoke.mjs` → expect `✅ ANSWERED BY: ...`.
3. Boot that channel and send `hello`.
4. Confirm both: the channel's `connected/listening/started` log line **and** an
   actual reply in the channel.

A PASS is only valid for the exact credentials/services you used. Record them
(redacted), the date, and the operator.

---

## Sign-off

| Target | Boot log seen | Round-trip reply | Result | Notes |
|---|---|---|---|---|
| discord | ☐ | ☐ | ☐ | |
| slack | ☐ | ☐ | ☐ | |
| telegram | ☐ | ☐ | ☐ | |
| whatsapp | ☐ | ☐ | ☐ | |
| teams (see teams runbook) | ☐ | ☐ | ☐ | |
| matrix | ☐ | ☐ | ☐ | |
| irc | ☐ | ☐ | ☐ | |
| web | ☐ | ☐ | ☐ | |
| cli | ☐ | ☐ | ☐ | |
| openai-subscription | n/a | ☐ smoke | ☐ | |
| kimi | n/a | ☐ smoke | ☐ | |
| openrouter (native provider) | n/a | ☐ smoke | ☐ | |
| opencode | n/a | ☐ smoke | ☐ | |
| ollama / local | ☐ reachable | ☐ smoke | ☐ | |
| gemini | n/a | ☐ smoke | ☐ | |
| deepseek | n/a | ☐ smoke | ☐ | |

> Reminder: this document and `scripts/provider-smoke.mjs` make verification
> **possible**. They do not themselves prove the system works — only a real run
> with real credentials does, and only for that run.
