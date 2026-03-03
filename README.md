<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>AI-Powered Development Agent with Multi-Channel Support</strong><br/>
  Automate your development workflows with intelligent code generation, semantic search, and multi-channel collaboration.
</p>

<p align="center">
  <a href="https://github.com/okandemirel/strada-brain/releases"><img src="https://img.shields.io/github/v/release/okandemirel/strada-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/okandemirel/strada-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/okandemirel/strada-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

---

## Overview

Strada.Brain is an AI-powered development agent that connects to multiple messaging channels and provides intelligent code generation, semantic code search, project analysis, and automated workflows. It features a RAG pipeline with HNSW vector search, an experience replay learning system, and enterprise-grade security.

---

## Architecture

```
+------------------------------------------------------------------+
|                     Presentation Layer                            |
|  Slack (95%)  Discord (90%)  Telegram (90%)  WhatsApp (35%)  CLI (80%)  |
+------------------------------------------------------------------+
         |              |             |             |           |
         v              v             v             v           v
+------------------------------------------------------------------+
|                   Channel Adapter Interface                       |
|  IChannelCore + IChannelSender + IChannelReceiver                |
|  Optional: IChannelStreaming, IChannelRichMessaging               |
+------------------------------------------------------------------+
         |
         v
+------------------------------------------------------------------+
|                    Orchestration Layer                            |
|  Orchestrator (agent loop: LLM -> Tool calls -> LLM -> Response) |
|  Session Manager  |  Rate Limiter  |  Autonomy (PLAN-ACT-VERIFY) |
|  Error Recovery   |  Task Planner  |  Self-Verification          |
+------------------------------------------------------------------+
         |
         v
+------------------------------------------------------------------+
|                      Service Layer                               |
|  AI Provider Chain (Claude, OpenAI, DeepSeek, Groq, Ollama)      |
|  39 Built-in Tools  |  Plugin Loader  |  Browser Automation      |
|  RAG Pipeline + HNSW Vector Search  |  Learning System           |
+------------------------------------------------------------------+
         |
         v
+------------------------------------------------------------------+
|                   Infrastructure Layer                            |
|  DI Container  |  Config  |  Logging (Winston)  |  Metrics       |
|  Security: JWT Auth, RBAC, Path Guard, Secret Sanitizer          |
|  Memory: SQLite + TF-IDF + Vector Embeddings                     |
|  Dashboard: WebSocket real-time metrics + Prometheus              |
+------------------------------------------------------------------+
```

---

## Feature Matrix

| Feature                     | Status      | Description                                        |
|-----------------------------|-------------|----------------------------------------------------|
| Slack channel               | 95%         | Socket mode, rich messages, streaming               |
| Discord channel             | 90%         | Bot with slash commands, embeds                     |
| Telegram channel            | 90%         | Grammy-based, mobile-first                          |
| WhatsApp channel            | 35%         | Baileys-based, session management                   |
| CLI channel                 | 80%         | Readline-based local access                         |
| AI provider chain           | Complete    | Claude, OpenAI, DeepSeek, Groq, Ollama + fallback  |
| RAG pipeline                | Complete    | Chunking, embeddings, HNSW vector search, reranking |
| 39 built-in tools           | Complete    | File I/O, git, shell, search, browser, code quality |
| Learning system             | Complete    | Pattern matching, Bayesian confidence scoring       |
| Security (RBAC)             | Complete    | JWT auth, 5 roles, 14 resource types                |
| Secret sanitizer            | Complete    | 18 pattern types auto-masked                        |
| Path guard                  | Complete    | Directory traversal prevention                      |
| Rate limiter                | Complete    | Per-user, per-hour, budget tracking                 |
| Dashboard                   | Complete    | WebSocket live metrics, Prometheus export            |
| Autonomy layer              | Complete    | Error recovery, task planning, self-verification    |
| Plugin system               | Complete    | Dynamic tool loading from plugins directory          |

---

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- npm
- An AI provider API key (Anthropic recommended)

### Installation

```bash
# Clone the repository
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys and settings

# Start in development mode
npm run dev
```

### Start with a specific channel

```bash
# Start with Slack
npm run dev -- start --channel slack

# Start with Discord
npm run dev -- start --channel discord

# Start with Telegram
npm run dev -- start --channel telegram

# Start in CLI mode
npm run dev -- cli
```

---

## Project Structure

```
src/
  agents/           # Orchestrator, AI providers, tools, autonomy
  channels/         # Channel adapters (Slack, Discord, Telegram, WhatsApp, CLI)
  config/           # Application configuration
  core/             # Bootstrap, DI container
  dashboard/        # Real-time metrics dashboard
  intelligence/     # Project analysis
  learning/         # Experience replay, pattern matching, confidence scoring
  memory/           # Conversation memory, file-based persistence
  rag/              # RAG pipeline, HNSW vector store, embeddings, reranker
  security/         # Auth, RBAC, rate limiter, path guard, secret sanitizer
  validation/       # Zod schemas, input sanitization
```

---

## Security Highlights

- **JWT Authentication** with MFA support and brute-force protection
- **RBAC** with 5 roles (superadmin, admin, developer, operator, viewer)
- **Secret Sanitizer** detects and masks 18 pattern types (API keys, tokens, credentials)
- **Path Guard** prevents directory traversal attacks
- **Rate Limiter** with per-user, per-hour, and budget-based limits
- **Read-Only Mode** for safe exploration without file system changes
- **Input Validation** via Zod schemas at all system boundaries
- **Audit Logging** for complete activity tracking

See [SECURITY.md](SECURITY.md) for the full security hardening guide.

---

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Type checking
npm run typecheck

# Linting
npm run lint
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR guidelines.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built by <a href="https://github.com/okandemirel">okandemirel</a>
</p>
