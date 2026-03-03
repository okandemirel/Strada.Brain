<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>Agent de Développement Unity Propulsé par IA</strong><br/>
  Automatisez vos flux de travail Strata.Core avec la génération de code intelligente, l'analyse et la collaboration multi-canal.
</p>

<p align="center">
  <a href="https://github.com/yourusername/strata-brain/releases"><img src="https://img.shields.io/github/v/release/yourusername/strata-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/yourusername/strata-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/strata-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-600%2B-green?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/couverture-85%25-brightgreen?style=flat-square" alt="Coverage">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="README.zh.md">中文</a> •
  <a href="README.ja.md">日本語</a> •
  <a href="README.ko.md">한국어</a> •
  <a href="README.tr.md">Türkçe</a> •
  <a href="README.de.md">Deutsch</a> •
  <a href="README.es.md">Español</a>
</p>

---

## ✨ Fonctionnalités

### 🤖 Développement Propulsé par IA
- **Génération Intelligente de Code** - Génère automatiquement des Modules, Systèmes, Composants et Médiateurs
- **Recherche Sémantique de Code** - 150x plus rapide avec la recherche vectorielle HNSW (vs force brute)
- **Apprentissage par Répétition d'Expériences** - Apprend des interactions passées pour s'améliorer continuellement
- **IA Multi-Fournisseur** - Claude, OpenAI, DeepSeek, Groq et 10+ fournisseurs compatibles

### 💬 Support Multi-Canal
Communiquez avec Strata.Brain via votre plateforme préférée :
- **Telegram** - Développement mobile-first en déplacement
- **Discord** - Collaboration d'équipe avec des embeds riches
- **Slack** - Intégration aux flux de travail d'entreprise
- **WhatsApp** - Corrections rapides et vérifications d'état
- **CLI** - Accès direct au terminal

### 🎮 Intégration Unity/Strata.Core
- **Analyse de Projet** - Cartographie la structure complète de votre base de code
- **Automatisation de Build** - Corrige automatiquement les erreurs de compilation
- **Qualité de Code** - Applique les modèles Strata.Core et les meilleures pratiques
- **Visualisation d'Architecture** - Comprenez instantanément les systèmes complexes

### 🔒 Sécurité Entreprise
- **RBAC** - Contrôle d'accès basé sur les rôles (5 rôles, 14 types de ressources)
- **Assainissement des Secrets** - Masquage automatique de 18 types de motifs
- **Journal d'Audit** - Suivi complet des activités
- **Mode Lecture Seule** - Exploration sécurisée sans modifications

### 📊 Surveillance et Opérations
- **Tableau de Bord en Temps Réel** - Métriques en direct via WebSocket
- **Intégration Prometheus** - Exportez les métriques vers votre stack
- **Alertes Intelligentes** - Discord, Slack, Email, Telegram, PagerDuty
- **Sauvegardes Automatiques** - Sauvegardes planifiées + à la demande

---

## 🚀 Démarrage Rapide

### Prérequis
- Node.js >= 20.0.0
- Projet Unity avec Strata.Core
- ANTHROPIC_API_KEY (ou autre fournisseur IA)

### Installation

```bash
# Cloner le dépôt
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# Installer les dépendances
npm install

# Configurer l'environnement
cp .env.example .env
# Éditer .env avec vos paramètres

# Démarrer le développement
npm run dev
```

### Docker (Recommandé pour la Production)

```bash
# Déploiement en une commande
./scripts/deploy.sh

# Ou manuellement
docker-compose up -d
```

---

## 📖 Exemples d'Utilisation

### Générer un Nouveau Module

**Telegram:**
```
@StrataBrain crée un module Inventaire avec items, slots et système de poids
```

**Discord:**
```
!create-module PlayerStats avec attributs Health, Mana, Stamina
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI avec comportements patrol, attack, flee
```

### Analyser le Projet

```
@StrataBrain analyse mon projet et dis-moi tout sur le système de combat
```

Réponse :
```
📊 Analyse de Projet

Système de Combat trouvé dans :
├── 📁 Modules/Combat/
│   ├── CombatModule.cs (point d'entrée)
│   ├── Systems/
│   │   ├── DamageSystem.cs (applique les dégâts)
│   │   └── CombatStateSystem.cs (gère les états)
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 Insights Clés :
• Health est modifié à 3 endroits
• Pas de validation sur les valeurs de dégâts
• Vérifications nulles manquantes dans CombatStateSystem
```

### Recherche Sémantique

```
@StrataBrain recherche "où la santé du joueur est modifiée quand il subit des dégâts"
```

Résultats en secondes avec des extraits de code pertinents et les emplacements des fichiers.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│  Couche de Présentation (5 Canaux)     │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  Couche d'Orchestration                 │
│  Gestionnaire de Session • Limiter de Débit │
│  Autonomie : PLAN-ACT-VERIFY-RESPOND   │
├─────────────────────────────────────────┤
│  Couche de Services                     │
│  Chaîne de Fournisseurs IA • 25+ Outils│
│  Recherche Vectorielle HNSW • Système d'Apprentissage │
├─────────────────────────────────────────┤
│  Couche d'Infrastructure                │
│  Conteneur DI • Sécurité (RBAC)        │
│  Auth • Configuration • Logging        │
└─────────────────────────────────────────┘
```

---

## 🧪 Tests

```bash
# Exécuter tous les tests
npm test

# Exécuter avec couverture
npm run test:coverage

# Exécuter les tests d'intégration
npm run test:integration
```

**Couverture de Tests :**
- 600+ tests unitaires
- 51 tests d'intégration (E2E)
- 85%+ couverture de code

---

## 📚 Documentation

- [📖 Guide de Démarrage](docs/getting-started.fr.md)
- [🏗️ Vue d'Ensemble de l'Architecture](docs/architecture.fr.md)
- [🔧 Référence de Configuration](docs/configuration.fr.md)
- [🔒 Guide de Sécurité](docs/security/security-overview.fr.md)
- [🛠️ Développement d'Outils](docs/tools.fr.md)
- [📊 Référence API](docs/api.fr.md)

---

## 🛡️ Sécurité

Strata.Brain met en œuvre des mesures de sécurité complètes :

- ✅ **OWASP Top 10** conformité
- ✅ **RBAC** avec 5 rôles (de superadmin à viewer)
- ✅ **18 Motifs de Secrets** détectés et masqués
- ✅ **Path Traversal** protection
- ✅ **Rate Limiting** avec suivi de budget
- ✅ **Audit Logging** pour toutes les actions
- ✅ **Scripts de Pentest** inclus

Voir la [Documentation de Sécurité](docs/security/security-overview.fr.md) pour les détails.

---

## 🌍 Support Multi-Langue

Strata.Brain parle votre langue :

| Langue | Fichier | Statut |
|--------|---------|--------|
| 🇺🇸 English | [README.md](README.md) | ✅ Complet |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ Complet |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ Complet |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ Complet |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ Complet |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ Complet |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ Complet |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ Complet |

---

## 🤝 Contribuer

Les contributions sont les bienvenues ! Voir le [Guide de Contribution](CONTRIBUTING.fr.md) pour les détails.

```bash
# Fork et cloner
git clone https://github.com/yourusername/strata-brain.git

# Créer une branche
git checkout -b feature/fonctionnalite-incroyable

# Faire les changements et commit
git commit -m "Ajouter fonctionnalité incroyable"

# Push et créer PR
git push origin feature/fonctionnalite-incroyable
```

---

## 📜 Licence

Licence MIT - voir le fichier [LICENSE](LICENSE) pour les détails.

---

## 💖 Remerciements

- [Strata.Core](https://github.com/strata/core) - Le framework ECS qui alimente tout
- [Grammy](https://grammy.dev) - Framework de bot Telegram
- [Discord.js](https://discord.js.org) - Intégration Discord
- [HNSWLib](https://github.com/nmslib/hnswlib) - Recherche vectorielle haute performance

---

<p align="center">
  <strong>🚀 Prêt à accélérer votre développement Unity ?</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ Donnez-nous une étoile sur GitHub</a> •
  <a href="https://twitter.com/stratabrain">🐦 Suivez-nous sur Twitter</a> •
  <a href="https://discord.gg/stratabrain">💬 Rejoignez Discord</a>
</p>

<p align="center">
  Construit avec ❤️ par l'Équipe Strata
</p>
