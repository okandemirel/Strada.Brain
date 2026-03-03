<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>AI-Powered Unity Development Agent</strong><br/>
  Automate your Strata.Core workflows with intelligent code generation, analysis, and multi-channel collaboration.
</p>

<p align="center">
  <a href="https://github.com/yourusername/strata-brain/releases"><img src="https://img.shields.io/github/v/release/yourusername/strata-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/yourusername/strata-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/strata-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-600%2B-green?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/coverage-85%25-brightgreen?style=flat-square" alt="Coverage">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <a href="README.zh.md">中文</a> •
  <a href="README.ja.md">日本語</a> •
  <a href="README.ko.md">한국어</a> •
  <a href="README.tr.md">Türkçe</a> •
  <a href="README.de.md">Deutsch</a> •
  <a href="README.es.md">Español</a> •
  <a href="README.fr.md">Français</a>
</p>

---

## ✨ Features

### 🤖 AI-Powered Development
- **Smart Code Generation** - Automatically generates Modules, Systems, Components, and Mediators
- **Semantic Code Search** - 150x faster with HNSW vector search (vs brute-force)
- **Experience Replay Learning** - Learns from past interactions to improve over time
- **Multi-Provider AI** - Claude, OpenAI, DeepSeek, Groq, and 10+ compatible providers

### 💬 Multi-Channel Support
Communicate with Strata.Brain through your favorite platform:
- **Telegram** - Mobile-first development on the go
- **Discord** - Team collaboration with rich embeds
- **Slack** - Enterprise workflow integration
- **WhatsApp** - Quick fixes and status checks
- **CLI** - Direct terminal access

### 🎮 Unity/Strata.Core Integration
- **Project Analysis** - Maps your entire codebase structure
- **Build Automation** - Auto-fixes compilation errors
- **Code Quality** - Enforces Strata.Core patterns and best practices
- **Architecture Visualization** - Understand complex systems instantly

### 🔒 Enterprise Security
- **RBAC** - Role-based access control (5 roles, 14 resource types)
- **Secret Sanitization** - 18 pattern types automatically masked
- **Audit Logging** - Complete activity tracking
- **Read-Only Mode** - Safe exploration without changes

### 📊 Monitoring & Operations
- **Real-time Dashboard** - WebSocket-powered live metrics
- **Prometheus Integration** - Export metrics to your stack
- **Smart Alerting** - Discord, Slack, Email, Telegram, PagerDuty
- **Automated Backups** - Scheduled + on-demand backups

---

## 🚀 Quick Start

### Prerequisites
- Node.js >= 20.0.0
- Unity project with Strata.Core
- ANTHROPIC_API_KEY (or other AI provider)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Start development
npm run dev
```

### Docker (Recommended for Production)

```bash
# One-command deployment
./scripts/deploy.sh

# Or manually
docker-compose up -d
```

---

## 📖 Usage Examples

### Generate a New Module

**Telegram:**
```
@StrataBrain create an Inventory module with items, slots, and weight system
```

**Discord:**
```
!create-module PlayerStats with Health, Mana, Stamina attributes
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI with patrol, attack, and flee behaviors
```

### Analyze Project

```
@StrataBrain analyze my project and tell me about the combat system
```

Response:
```
📊 Project Analysis

Combat System found in:
├── 📁 Modules/Combat/
│   ├── CombatModule.cs (entry point)
│   ├── Systems/
│   │   ├── DamageSystem.cs (applies damage)
│   │   └── CombatStateSystem.cs (manages states)
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 Key Insights:
• Health is modified in 3 locations
• No validation on damage values
• Missing null checks in CombatStateSystem
```

### Semantic Search

```
@StrataBrain search "where is player health modified when taking damage"
```

Results in seconds with relevant code snippets and file locations.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│  Presentation Layer (5 Channels)       │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  Orchestration Layer                   │
│  Session Manager • Rate Limiter        │
│  Autonomy: PLAN-ACT-VERIFY-RESPOND     │
├─────────────────────────────────────────┤
│  Service Layer                         │
│  AI Provider Chain • 25+ Tools         │
│  HNSW Vector Search • Learning System  │
├─────────────────────────────────────────┤
│  Infrastructure Layer                  │
│  DI Container • Security (RBAC)        │
│  Auth • Config • Logging               │
└─────────────────────────────────────────┘
```

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run integration tests
npm run test:integration
```

**Test Coverage:**
- 600+ unit tests
- 51 integration tests (E2E)
- 85%+ code coverage

---

## 📚 Documentation

- [📖 Getting Started Guide](docs/getting-started.md)
- [🏗️ Architecture Overview](docs/architecture.md)
- [🔧 Configuration Reference](docs/configuration.md)
- [🔒 Security Guide](docs/security/security-overview.md)
- [🛠️ Tool Development](docs/tools.md)
- [📊 API Reference](docs/api.md)

---

## 🛡️ Security

Strata.Brain implements comprehensive security measures:

- ✅ **OWASP Top 10** compliance
- ✅ **RBAC** with 5 roles (superadmin to viewer)
- ✅ **18 Secret Patterns** detected and masked
- ✅ **Path Traversal** protection
- ✅ **Rate Limiting** with budget tracking
- ✅ **Audit Logging** for all actions
- ✅ **Pentest Scripts** included

See [Security Documentation](docs/security/security-overview.md) for details.

---

## 🌍 Multi-Language Support

Strata.Brain speaks your language:

| Language | File | Status |
|----------|------|--------|
| 🇺🇸 English | [README.md](README.md) | ✅ Complete |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ Complete |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ Complete |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ Complete |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ Complete |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ Complete |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ Complete |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ Complete |

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

```bash
# Fork and clone
git clone https://github.com/yourusername/strata-brain.git

# Create branch
git checkout -b feature/amazing-feature

# Make changes and commit
git commit -m "Add amazing feature"

# Push and create PR
git push origin feature/amazing-feature
```

---

## 📜 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 💖 Acknowledgments

- [Strata.Core](https://github.com/strata/core) - The ECS framework that powers it all
- [Grammy](https://grammy.dev) - Telegram bot framework
- [Discord.js](https://discord.js.org) - Discord integration
- [HNSWLib](https://github.com/nmslib/hnswlib) - High-performance vector search

---

<p align="center">
  <strong>🚀 Ready to supercharge your Unity development?</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ Star us on GitHub</a> •
  <a href="https://twitter.com/stratabrain">🐦 Follow on Twitter</a> •
  <a href="https://discord.gg/stratabrain">💬 Join Discord</a>
</p>

<p align="center">
  Built with ❤️ by the Strata Team
</p>
