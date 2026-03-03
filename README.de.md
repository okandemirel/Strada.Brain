<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>KI-gesteuerter Unity-Entwicklungs-Agent</strong><br/>
  Automatisieren Sie Ihre Strata.Core-Workflows mit intelligenter Code-Generierung, Analyse und Multi-Channel-Kollaboration.
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
  <a href="README.md">English</a> •
  <a href="README.zh.md">中文</a> •
  <a href="README.ja.md">日本語</a> •
  <a href="README.ko.md">한국어</a> •
  <a href="README.tr.md">Türkçe</a> •
  <a href="README.es.md">Español</a> •
  <a href="README.fr.md">Français</a>
</p>

---

## ✨ Funktionen

### 🤖 KI-gesteuerte Entwicklung
- **Intelligente Code-Generierung** - Automatische Erstellung von Modulen, Systemen, Komponenten und Mediatoren
- **Semantische Code-Suche** - 150x schneller mit HNSW-Vektorsuche (im Vergleich zu Brute-Force)
- **Experience Replay Learning** - Lernt aus vergangenen Interaktionen zur kontinuierlichen Verbesserung
- **Multi-Provider KI** - Claude, OpenAI, DeepSeek, Groq und 10+ kompatible Provider

### 💬 Multi-Channel-Unterstützung
Kommunizieren Sie mit Strata.Brain über Ihre bevorzugte Plattform:
- **Telegram** - Mobile-first Entwicklung unterwegs
- **Discord** - Team-Kollaboration mit Rich Embeds
- **Slack** - Enterprise-Workflow-Integration
- **WhatsApp** - Schnelle Korrekturen und Status-Checks
- **CLI** - Direkter Terminal-Zugriff

### 🎮 Unity/Strata.Core-Integration
- **Projektanalyse** - Kartierung der gesamten Codebasis-Struktur
- **Build-Automatisierung** - Automatische Behebung von Kompilierungsfehlern
- **Code-Qualität** - Durchsetzung von Strata.Core-Mustern und Best Practices
- **Architektur-Visualisierung** - Sofortiges Verständnis komplexer Systeme

### 🔒 Enterprise-Sicherheit
- **RBAC** - Rollenbasierte Zugriffskontrolle (5 Rollen, 14 Ressourcentypen)
- **Secret-Sanitisierung** - Automatisches Maskieren von 18 Mustertypen
- **Audit-Logging** - Vollständige Aktivitätsverfolgung
- **Nur-Lesen-Modus** - Sichere Erkundung ohne Änderungen

### 📊 Monitoring & Betrieb
- **Echtzeit-Dashboard** - WebSocket-gesteuerte Live-Metriken
- **Prometheus-Integration** - Export von Metriken in Ihren Stack
- **Smart Alerting** - Discord, Slack, E-Mail, Telegram, PagerDuty
- **Automatische Backups** - Geplante + On-Demand-Backups

---

## 🚀 Schnellstart

### Voraussetzungen
- Node.js >= 20.0.0
- Unity-Projekt mit Strata.Core
- ANTHROPIC_API_KEY (oder anderer KI-Provider)

### Installation

```bash
# Repository klonen
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# Abhängigkeiten installieren
npm install

# Umgebung konfigurieren
cp .env.example .env
# .env mit Ihren Einstellungen bearbeiten

# Entwicklung starten
npm run dev
```

### Docker (Empfohlen für Produktion)

```bash
# Ein-Befehl-Bereitstellung
./scripts/deploy.sh

# Oder manuell
docker-compose up -d
```

---

## 📖 Nutzungsbeispiele

### Neues Modul generieren

**Telegram:**
```
@StrataBrain Erstelle ein Inventar-Modul mit Items, Slots und Gewichtssystem
```

**Discord:**
```
!create-module PlayerStats mit Health, Mana, Stamina Attributen
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI mit patrol, attack, flee Verhalten
```

### Projekt analysieren

```
@StrataBrain Analysiere mein Projekt und erzähle mir vom Kampfsystem
```

Antwort:
```
📊 Projektanalyse

Kampfsystem gefunden in:
├── 📁 Modules/Combat/
│   ├── CombatModule.cs (Einstiegspunkt)
│   ├── Systems/
│   │   ├── DamageSystem.cs (Schaden anwenden)
│   │   └── CombatStateSystem.cs (Zustände verwalten)
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 Wichtige Erkenntnisse:
• Health wird an 3 Stellen geändert
• Keine Validierung für Schadenswerte
• Fehlende Null-Checks in CombatStateSystem
```

### Semantische Suche

```
@StrataBrain Suche "wo wird Spieler-Gesundheit bei Schaden geändert"
```

Ergebnisse in Sekunden mit relevanten Code-Snippets und Dateiorten.

---

## 🏗️ Architektur

```
┌─────────────────────────────────────────┐
│  Präsentationsschicht (5 Channels)     │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  Orchestrierungsschicht                 │
│  Session Manager • Rate Limiter        │
│  Autonomie: PLAN-ACT-VERIFY-RESPOND    │
├─────────────────────────────────────────┤
│  Diensteschicht                         │
│  KI-Provider-Kette • 25+ Tools         │
│  HNSW-Vektorsuche • Lernsystem         │
├─────────────────────────────────────────┤
│  Infrastrukturschicht                   │
│  DI-Container • Sicherheit (RBAC)      │
│  Auth • Konfiguration • Logging        │
└─────────────────────────────────────────┘
```

---

## 🧪 Tests

```bash
# Alle Tests ausführen
npm test

# Mit Coverage ausführen
npm run test:coverage

# Integrationstests ausführen
npm run test:integration
```

**Testabdeckung:**
- 600+ Unit-Tests
- 51 Integrationstests (E2E)
- 85%+ Code-Abdeckung

---

## 📚 Dokumentation

- [📖 Erste Schritte](docs/getting-started.de.md)
- [🏗️ Architektur-Übersicht](docs/architecture.de.md)
- [🔧 Konfigurations-Referenz](docs/configuration.de.md)
- [🔒 Sicherheits-Guide](docs/security/security-overview.de.md)
- [🛠️ Tool-Entwicklung](docs/tools.de.md)
- [📊 API-Referenz](docs/api.de.md)

---

## 🛡️ Sicherheit

Strata.Brain implementiert umfassende Sicherheitsmaßnahmen:

- ✅ **OWASP Top 10** Konformität
- ✅ **RBAC** mit 5 Rollen (von Superadmin bis Viewer)
- ✅ **18 Secret-Patterns** erkannt und maskiert
- ✅ **Path Traversal** Schutz
- ✅ **Rate Limiting** mit Budget-Tracking
- ✅ **Audit Logging** für alle Aktionen
- ✅ **Pentest-Skripte** enthalten

Siehe [Sicherheitsdokumentation](docs/security/security-overview.de.md) für Details.

---

## 🌍 Mehrsprachige Unterstützung

Strata.Brain spricht Ihre Sprache:

| Sprache | Datei | Status |
|---------|-------|--------|
| 🇺🇸 English | [README.md](README.md) | ✅ Vollständig |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ Vollständig |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ Vollständig |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ Vollständig |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ Vollständig |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ Vollständig |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ Vollständig |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ Vollständig |

---

## 🤝 Mitwirken

Wir freuen uns über Beiträge! Siehe [Mitwirkungs-Guide](CONTRIBUTING.de.md) für Details.

```bash
# Fork und Klonen
git clone https://github.com/yourusername/strata-brain.git

# Branch erstellen
git checkout -b feature/amazing-feature

# Änderungen committen
git commit -m "Erstaunliche Funktion hinzufügen"

# Push und PR erstellen
git push origin feature/amazing-feature
```

---

## 📜 Lizenz

MIT-Lizenz - siehe [LICENSE](LICENSE) Datei für Details.

---

## 💖 Danksagungen

- [Strata.Core](https://github.com/strata/core) - Das ECS-Framework, das alles antreibt
- [Grammy](https://grammy.dev) - Telegram Bot Framework
- [Discord.js](https://discord.js.org) - Discord-Integration
- [HNSWLib](https://github.com/nmslib/hnswlib) - Hochleistungs-Vektorsuche

---

<p align="center">
  <strong>🚀 Bereit, Ihre Unity-Entwicklung zu beschleunigen?</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ Stern auf GitHub</a> •
  <a href="https://twitter.com/stratabrain">🐦 Folge auf Twitter</a> •
  <a href="https://discord.gg/stratabrain">💬 Discord beitreten</a>
</p>

<p align="center">
  Mit ❤️ vom Strata-Team erstellt
</p>
