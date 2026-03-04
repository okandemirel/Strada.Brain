<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Agent de Developpement Propulse par l'IA pour les Projets Unity / Strada.Core</strong><br/>
  Un agent de programmation autonome qui se connecte a un tableau de bord web, Telegram, Discord, Slack, WhatsApp, ou votre terminal &mdash; lit votre base de code, ecrit du code, lance les builds et apprend de ses erreurs.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licence">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.zh.md">中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <strong>Français</strong>
</p>

---

## Qu'est-ce que c'est ?

Strada.Brain est un agent IA avec lequel vous communiquez via un canal de chat. Vous decrivez ce que vous voulez -- "cree un nouveau systeme ECS pour le mouvement du joueur" ou "trouve tous les composants qui utilisent la sante" -- et l'agent lit votre projet C#, ecrit le code, lance `dotnet build`, corrige les erreurs automatiquement et vous envoie le resultat. Il dispose d'une memoire persistante, apprend de ses erreurs passees et peut utiliser plusieurs fournisseurs d'IA avec basculement automatique.

**Ceci n'est pas une bibliotheque ni une API.** C'est une application autonome que vous executez. Elle se connecte a votre plateforme de chat, lit votre projet Unity sur le disque et fonctionne de maniere autonome dans les limites que vous configurez.

---

## Demarrage Rapide

### Prerequis

- **Node.js 20+** et npm
- Une **cle API Anthropic** (Claude) -- les autres fournisseurs sont optionnels
- Un **projet Unity** avec le framework Strada.Core (le chemin que vous donnez a l'agent)

### 1. Installation

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. Configuration

```bash
cp .env.example .env
```

Ouvrez `.env` et definissez au minimum :

```env
ANTHROPIC_API_KEY=sk-ant-...      # Votre cle API Claude
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Doit contenir Assets/
JWT_SECRET=<generer avec : openssl rand -hex 64>
```

### 3. Lancement

```bash
# Canal web (defaut) - l'assistant de configuration s'ouvre sur localhost:3000
# Si aucun .env n'existe, l'assistant vous guide a travers la configuration initiale
npm start

# Ou explicitement avec le canal web
npm run dev -- start --channel web

# Mode CLI interactif (moyen le plus rapide pour tester)
npm run dev -- cli

# Ou avec un canal de chat
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. Communiquez avec l'agent

Une fois lance, envoyez un message via votre canal configure :

```
> Analyse la structure du projet
> Cree un nouveau module appele "Combat" avec un DamageSystem et un HealthComponent
> Trouve tous les systemes qui requetent PositionComponent
> Lance le build et corrige les erreurs
```

**Canal web :** Pas de terminal necessaire -- interagissez via le tableau de bord web sur `localhost:3000`.

---

## Architecture

```
+-----------------------------------------------------------------+
|  Canaux de Chat                                                  |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    Interface IChannelAdapter
                               |
+------------------------------v----------------------------------+
|  Orchestrateur (Boucle Agent)                                    |
|  Prompt systeme + Memoire + Contexte RAG -> LLM -> Appels outils|
|  Jusqu'a 50 iterations d'outils par message                      |
|  Autonomie : recuperation d'erreurs, detection de blocage,       |
|  verification de build                                           |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| Fournisseurs IA|  | 30+ Outils     |  | Sources de Contexte|
| Claude (princ.)|  | E/S fichiers   |  | Memoire (TF-IDF)   |
| OpenAI, Kimi   |  | Operations Git |  | RAG (vecteurs HNSW)|
| DeepSeek, Qwen |  | Exec. shell    |  | Analyse de projet  |
| MiniMax, Groq  |  | Build/test .NET|  | Modeles appris     |
| Ollama (local) |  | Navigateur     |  +--------------------+
| + 4 autres     |  | Codegen Strata |
+----------------+  +----------------+
```

### Fonctionnement de la Boucle Agent

1. **Un message arrive** depuis un canal de chat
2. **Recuperation memoire** -- trouve les 3 conversations passees les plus pertinentes (TF-IDF)
3. **Recuperation RAG** -- recherche semantique sur votre base de code C# (vecteurs HNSW, top 6 resultats)
4. **Analyse en cache** -- injecte la structure du projet si elle a ete analysee precedemment
5. **Appel LLM** avec prompt systeme + contexte + definitions d'outils
6. **Execution des outils** -- si le LLM appelle des outils, ils s'executent et les resultats sont renvoyes au LLM
7. **Controles d'autonomie** -- la recuperation d'erreurs analyse les echecs, le detecteur de blocage avertit si l'agent est coince, l'auto-verification force un `dotnet build` avant de repondre si des fichiers `.cs` ont ete modifies
8. **Repetition** jusqu'a 50 iterations jusqu'a ce que le LLM produise une reponse textuelle finale
9. **Reponse envoyee** a l'utilisateur via le canal (streaming si supporte)

---

## Reference de Configuration

Toute la configuration se fait via des variables d'environnement. Consultez `.env.example` pour la liste complete.

### Obligatoires

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Cle API Claude (fournisseur LLM principal) |
| `UNITY_PROJECT_PATH` | Chemin absolu vers la racine de votre projet Unity (doit contenir `Assets/`) |
| `JWT_SECRET` | Secret pour la signature JWT. Generer : `openssl rand -hex 64` |

### Fournisseurs d'IA

Tout fournisseur compatible OpenAI fonctionne. Tous les fournisseurs ci-dessous sont deja implementes et n'ont besoin que d'une cle API pour etre actives.

| Variable | Fournisseur | Modele par Defaut |
|----------|-------------|-------------------|
| `ANTHROPIC_API_KEY` | Claude (principal) | `claude-sonnet-4-20250514` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `DEEPSEEK_API_KEY` | DeepSeek | `deepseek-chat` |
| `GROQ_API_KEY` | Groq | `llama-3.3-70b-versatile` |
| `QWEN_API_KEY` | Alibaba Qwen | `qwen-plus` |
| `KIMI_API_KEY` | Moonshot Kimi | `moonshot-v1-8k` |
| `MINIMAX_API_KEY` | MiniMax | `abab6.5s-chat` |
| `MISTRAL_API_KEY` | Mistral AI | `mistral-large-latest` |
| `TOGETHER_API_KEY` | Together AI | `meta-llama/Llama-3-70b-chat-hf` |
| `FIREWORKS_API_KEY` | Fireworks AI | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `GEMINI_API_KEY` | Google Gemini | `gemini-pro` |
| `OLLAMA_BASE_URL` | Ollama (local) | `llama3` |
| `PROVIDER_CHAIN` | Ordre de basculement | ex. `claude,kimi,deepseek,ollama` |

**Chaine de fournisseurs :** Definissez `PROVIDER_CHAIN` avec une liste de noms de fournisseurs separes par des virgules. Le systeme essaie chacun dans l'ordre, basculant en cas d'echec. Exemple : `PROVIDER_CHAIN=kimi,deepseek,claude` utilise Kimi en premier, DeepSeek si Kimi echoue, puis Claude.

### Canaux de Chat

**Web :**
| Variable | Description |
|----------|-------------|
| `WEB_CHANNEL_PORT` | Port du tableau de bord web (defaut : `3000`) |

**Telegram :**
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token obtenu de @BotFather |
| `ALLOWED_TELEGRAM_USER_IDS` | IDs utilisateur Telegram separes par des virgules (obligatoire, refuse tout si vide) |

**Discord :**
| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Token du bot Discord |
| `DISCORD_CLIENT_ID` | ID client de l'application Discord |
| `ALLOWED_DISCORD_USER_IDS` | IDs utilisateur separes par des virgules (refuse tout si vide) |
| `ALLOWED_DISCORD_ROLE_IDS` | IDs de role separes par des virgules pour l'acces par role |

**Slack :**
| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Token de bot `xoxb-...` |
| `SLACK_APP_TOKEN` | Token au niveau application `xapp-...` (pour le mode socket) |
| `SLACK_SIGNING_SECRET` | Secret de signature de l'application Slack |
| `ALLOWED_SLACK_USER_IDS` | IDs utilisateur separes par des virgules (**ouvert a tous si vide**) |
| `ALLOWED_SLACK_WORKSPACES` | IDs d'espace de travail separes par des virgules (**ouvert a tous si vide**) |

**WhatsApp :**
| Variable | Description |
|----------|-------------|
| `WHATSAPP_SESSION_PATH` | Repertoire pour les fichiers de session (defaut : `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | Numeros de telephone separes par des virgules |

### Fonctionnalites

| Variable | Defaut | Description |
|----------|--------|-------------|
| `RAG_ENABLED` | `true` | Active la recherche semantique de code sur votre projet C# |
| `EMBEDDING_PROVIDER` | `openai` | Fournisseur d'embeddings : `openai` ou `ollama` |
| `MEMORY_ENABLED` | `true` | Active la memoire persistante des conversations |
| `MEMORY_DB_PATH` | `.strata-memory` | Repertoire des fichiers de la base de donnees memoire |
| `WEB_CHANNEL_PORT` | `3000` | Port du tableau de bord web |
| `DASHBOARD_ENABLED` | `false` | Active le tableau de bord de surveillance HTTP |
| `DASHBOARD_PORT` | `3001` | Port du serveur du tableau de bord |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | Active le tableau de bord en temps reel WebSocket |
| `ENABLE_PROMETHEUS` | `false` | Active l'endpoint de metriques Prometheus (port 9090) |
| `READ_ONLY_MODE` | `false` | Bloque toutes les operations d'ecriture |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, ou `debug` |

### Limitation de Debit

| Variable | Defaut | Description |
|----------|--------|-------------|
| `RATE_LIMIT_ENABLED` | `false` | Active la limitation de debit |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | Limite de messages par utilisateur par minute (0 = illimite) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | Limite horaire par utilisateur |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | Quota journalier global de tokens |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | Plafond de depenses journalier en USD |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | Plafond de depenses mensuel en USD |

### Securite

| Variable | Defaut | Description |
|----------|--------|-------------|
| `REQUIRE_MFA` | `false` | Exige l'authentification multi-facteurs |
| `BROWSER_HEADLESS` | `true` | Execute l'automatisation du navigateur en mode headless |
| `BROWSER_MAX_CONCURRENT` | `5` | Nombre maximal de sessions de navigateur simultanees |

---

## Outils

L'agent dispose de plus de 30 outils integres organises par categorie :

### Operations sur les Fichiers
| Outil | Description |
|-------|-------------|
| `file_read` | Lit les fichiers avec numeros de ligne, pagination offset/limit (limite 512Ko) |
| `file_write` | Cree ou ecrase les fichiers (limite 256Ko, creation automatique des repertoires) |
| `file_edit` | Edition par recherche-remplacement avec verification d'unicite |
| `file_delete` | Supprime un fichier unique |
| `file_rename` | Renomme ou deplace des fichiers au sein du projet |
| `file_delete_directory` | Suppression recursive de repertoire (limite de securite de 50 fichiers) |

### Recherche
| Outil | Description |
|-------|-------------|
| `glob_search` | Recherche de fichiers par motif glob (max 50 resultats) |
| `grep_search` | Recherche de contenu par regex dans les fichiers (max 20 correspondances) |
| `list_directory` | Listage de repertoire avec tailles de fichiers |
| `code_search` | Recherche semantique/vectorielle via RAG -- requetes en langage naturel |
| `memory_search` | Recherche dans la memoire persistante des conversations |

### Generation de Code Strada
| Outil | Description |
|-------|-------------|
| `strata_analyze_project` | Scan complet du projet C# -- modules, systemes, composants, services |
| `strata_create_module` | Genere un echafaudage de module complet (`.asmdef`, config, repertoires) |
| `strata_create_component` | Genere des structs de composants ECS avec definitions de champs |
| `strata_create_mediator` | Genere un `EntityMediator<TView>` avec liaisons de composants |
| `strata_create_system` | Genere `SystemBase`/`JobSystemBase`/`SystemGroup` |

### Git
| Outil | Description |
|-------|-------------|
| `git_status` | Statut de l'arbre de travail |
| `git_diff` | Afficher les modifications |
| `git_log` | Historique des commits |
| `git_commit` | Indexer et committer |
| `git_push` | Pousser vers le depot distant |
| `git_branch` | Lister, creer ou basculer de branche |
| `git_stash` | Push, pop, list ou drop du stash |

### .NET / Unity
| Outil | Description |
|-------|-------------|
| `dotnet_build` | Lance `dotnet build`, analyse les erreurs MSBuild en sortie structuree |
| `dotnet_test` | Lance `dotnet test`, analyse les resultats pass/fail/skip |

### Autres
| Outil | Description |
|-------|-------------|
| `shell_exec` | Execute des commandes shell (timeout 30s, liste de blocage de commandes dangereuses) |
| `code_quality` | Analyse de qualite de code par fichier ou par projet |
| `rag_index` | Declenche la re-indexation incrementale ou complete du projet |

---

## Capacites des Canaux

| Capacite | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|----------|-----|----------|---------|-------|----------|-----|
| Messagerie texte | Oui | Oui | Oui | Oui | Oui | Oui |
| Streaming (edition en place) | Oui | Oui | Oui | Oui | Oui | Oui |
| Indicateur de saisie | Oui | Oui | Oui | No-op | Oui | Non |
| Dialogues de confirmation | Oui (modal) | Oui (clavier inline) | Oui (boutons) | Oui (Block Kit) | Oui (reponse numerotee) | Oui (readline) |
| Envoi de fichiers | Oui | Non | Non | Oui | Oui | Non |
| Support des fils | Non | Non | Oui | Oui | Non | Non |
| Limiteur de debit (sortant) | Oui (par-session) | Non | Oui (token bucket) | Oui (fenetre glissante 4 niveaux) | Limitation en ligne | Non |

### Streaming

Tous les canaux implementent le streaming par edition en place. La reponse de l'agent apparait progressivement au fur et a mesure que le LLM la genere. Les mises a jour sont limitees par plateforme pour eviter les limites de debit (WhatsApp/Discord : 1/s, Slack : 2/s).

### Authentification

- **Telegram** : Refus par defaut. Vous devez definir `ALLOWED_TELEGRAM_USER_IDS`.
- **Discord** : Refus par defaut. Vous devez definir `ALLOWED_DISCORD_USER_IDS` ou `ALLOWED_DISCORD_ROLE_IDS`.
- **Slack** : **Ouvert par defaut.** Si `ALLOWED_SLACK_USER_IDS` est vide, tout utilisateur Slack peut acceder au bot. Definissez la liste d'autorisation pour la production.
- **WhatsApp** : Utilise la liste d'autorisation `WHATSAPP_ALLOWED_NUMBERS` verifiee localement dans l'adaptateur.

---

## Systeme de Memoire

Le backend de memoire en production est `FileMemoryManager` -- des fichiers JSON avec indexation textuelle TF-IDF pour la recherche.

**Fonctionnement :**
- Lorsque l'historique de session depasse 40 messages, les anciens messages sont resumes et stockes comme entrees de conversation
- L'agent recupere automatiquement les 3 souvenirs les plus pertinents avant chaque appel LLM
- L'outil `strata_analyze_project` met en cache l'analyse de la structure du projet pour une injection de contexte instantanee
- La memoire persiste entre les redemarrages dans le repertoire `MEMORY_DB_PATH` (defaut : `.strata-memory/`)

**Backend avance (implemente, pas encore connecte) :** `AgentDBMemory` avec SQLite + recherche vectorielle HNSW, memoire a trois niveaux (travail/ephemere/persistante), recuperation hybride (70% semantique + 30% TF-IDF). Entierement code mais non connecte au bootstrap -- `FileMemoryManager` est le backend actif.

---

## Pipeline RAG

Le pipeline RAG (Retrieval-Augmented Generation) indexe votre code source C# pour la recherche semantique.

**Flux d'indexation :**
1. Scanne les fichiers `**/*.cs` dans votre projet Unity
2. Decoupe le code de maniere structurelle -- en-tetes de fichiers, classes, methodes, constructeurs
3. Genere les embeddings via OpenAI (`text-embedding-3-small`) ou Ollama (`nomic-embed-text`)
4. Stocke les vecteurs dans un index HNSW pour une recherche rapide par plus proches voisins approximatifs
5. S'execute automatiquement au demarrage (en arriere-plan, non bloquant)

**Flux de recherche :**
1. La requete est convertie en embedding par le meme fournisseur
2. La recherche HNSW retourne `topK * 3` candidats
3. Le re-classeur attribue un score : similarite vectorielle (60%) + chevauchement de mots-cles (25%) + bonus structurel (15%)
4. Les 6 meilleurs resultats (au-dessus du score 0.2) sont injectes dans le contexte du LLM

**Note :** Le pipeline RAG ne supporte actuellement que les fichiers C#. Le decoupeur est specifique au C#.

---

## Systeme d'Apprentissage

Le systeme d'apprentissage observe le comportement de l'agent et apprend de ses erreurs :

- Les **modeles d'erreur** sont captures avec indexation en texte integral
- Les **solutions** sont liees aux modeles d'erreur pour une recuperation future
- Les **instincts** sont des comportements appris atomiques avec des scores de confiance bayesiens
- Les **trajectoires** enregistrent les sequences d'appels d'outils avec leurs resultats
- Les scores de confiance utilisent le **classement Elo** et les **intervalles de score de Wilson** pour la validite statistique
- Les instincts en dessous de 0.3 de confiance sont deprecies ; au-dessus de 0.9, ils sont proposes pour promotion

Le pipeline d'apprentissage s'execute sur des minuteurs : detection de modeles toutes les 5 minutes, propositions d'evolution toutes les heures. Les donnees sont stockees dans une base de donnees SQLite separee (`learning.db`).

---

## Securite

### Couche 1 : Authentification des Canaux
Listes d'autorisation specifiques a chaque plateforme, verifiees a l'arrivee du message (avant tout traitement).

### Couche 2 : Limitation de Debit
Fenetre glissante par utilisateur (minute/heure) + plafonds globaux quotidiens/mensuels en tokens et en USD.

### Couche 3 : Gardien de Chemin
Chaque operation sur les fichiers resout les liens symboliques et valide que le chemin reste dans la racine du projet. Plus de 30 motifs sensibles sont bloques (`.env`, `.git/credentials`, cles SSH, certificats, `node_modules/`).

### Couche 4 : Assainisseur de Secrets
24 motifs regex detectent et masquent les identifiants dans toutes les sorties d'outils avant qu'elles n'atteignent le LLM. Couvre : cles OpenAI, tokens GitHub, tokens Slack/Discord/Telegram, cles AWS, JWT, authentification Bearer, cles PEM, URLs de bases de donnees et motifs generiques de secrets.

### Couche 5 : Mode Lecture Seule
Quand `READ_ONLY_MODE=true`, 23 outils d'ecriture sont entierement retires de la liste d'outils de l'agent -- le LLM ne peut meme pas tenter de les appeler.

### Couche 6 : Confirmation des Operations
Les operations d'ecriture (ecriture de fichiers, commits Git, execution shell) peuvent necessiter une confirmation de l'utilisateur via l'interface interactive du canal (boutons, claviers inline, invites texte).

### Couche 7 : Assainissement des Sorties d'Outils
Toutes les sorties d'outils sont limitees a 8192 caracteres et nettoyees des motifs de cles API avant d'etre renvoyees au LLM.

### Couche 8 : RBAC (Interne)
5 roles (superadmin, admin, developer, viewer, service) avec une matrice de permissions couvrant 9 types de ressources. Le moteur de politiques supporte des conditions basees sur le temps, l'IP et des conditions personnalisees.

---

## Tableau de Bord et Surveillance

### Tableau de Bord HTTP (`DASHBOARD_ENABLED=true`)
Accessible a `http://localhost:3001` (localhost uniquement). Affiche : disponibilite, nombre de messages, utilisation des tokens, sessions actives, tableau d'utilisation des outils, statistiques de securite. Rafraichissement automatique toutes les 3 secondes.

### Endpoints de Sante
- `GET /health` -- Sonde de vivacite (`{"status":"ok"}`)
- `GET /ready` -- Verification approfondie de disponibilite : verifie la memoire et la sante des canaux. Retourne 200 (pret), 207 (degrade), ou 503 (non pret)

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metriques a `http://localhost:9090/metrics`. Compteurs pour les messages, appels d'outils, tokens. Histogrammes pour la duree des requetes, duree des outils, latence LLM. Metriques Node.js par defaut (CPU, heap, GC, boucle d'evenements).

### Tableau de Bord WebSocket (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Metriques en temps reel poussees chaque seconde. Supporte les connexions authentifiees et les commandes a distance (rechargement de plugins, vidage du cache, recuperation des logs).

---

## Deploiement

### Docker

```bash
docker-compose up -d
```

Le fichier `docker-compose.yml` inclut l'application, la stack de surveillance et le reverse proxy nginx.

### Mode Daemon

```bash
# Redemarrage automatique en cas de crash avec backoff exponentiel (1s a 60s, jusqu'a 10 redemarrages)
node dist/index.js daemon --channel telegram
```

### Checklist de Production

- [ ] Definir `NODE_ENV=production`
- [ ] Definir `LOG_LEVEL=warn` ou `error`
- [ ] Configurer `RATE_LIMIT_ENABLED=true` avec des plafonds de budget
- [ ] Definir les listes d'autorisation des canaux (surtout Slack -- ouvert par defaut)
- [ ] Definir `READ_ONLY_MODE=true` si vous ne souhaitez qu'une exploration securisee
- [ ] Activer `DASHBOARD_ENABLED=true` pour la surveillance
- [ ] Activer `ENABLE_PROMETHEUS=true` pour la collecte de metriques
- [ ] Generer un `JWT_SECRET` robuste

---

## Tests

```bash
npm test                         # Lancer les 1560+ tests
npm run test:watch               # Mode watch
npm test -- --coverage           # Avec couverture
npm test -- src/agents/tools/file-read.test.ts  # Fichier unique
npm run typecheck                # Verification de types TypeScript
npm run lint                     # ESLint
```

94 fichiers de test couvrant : agents, canaux, securite, RAG, memoire, apprentissage, tableau de bord, flux d'integration.

---

## Structure du Projet

```
src/
  index.ts              # Point d'entree CLI (Commander.js)
  core/
    bootstrap.ts        # Sequence complete d'initialisation -- tout le cablage se fait ici
    di-container.ts     # Conteneur DI (disponible mais le cablage manuel domine)
    tool-registry.ts    # Instanciation et enregistrement des outils
  agents/
    orchestrator.ts     # Boucle agent principale, gestion de sessions, streaming
    autonomy/           # Recuperation d'erreurs, planification de taches, auto-verification
    context/            # Prompt systeme (base de connaissances Strada.Core)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + autres
    tools/              # 30+ implementations d'outils
    plugins/            # Chargeur de plugins externes
  channels/
    telegram/           # Bot base sur Grammy
    discord/            # Bot discord.js avec commandes slash
    slack/              # Slack Bolt (mode socket) avec Block Kit
    whatsapp/           # Client base sur Baileys avec gestion de sessions
    cli/                # REPL Readline
  memory/
    file-memory-manager.ts   # Backend actif : JSON + TF-IDF
    unified/                 # Backend AgentDB : SQLite + HNSW (pas encore connecte)
  rag/
    rag-pipeline.ts     # Orchestration indexation + recherche + formatage
    chunker.ts          # Decoupage structurel specifique au C#
    hnsw/               # Stockage vectoriel HNSW (hnswlib-node)
    embeddings/         # Fournisseurs d'embeddings OpenAI et Ollama
    reranker.ts         # Re-classement pondere (vectoriel + mots-cles + structurel)
  security/             # Auth, RBAC, gardien de chemin, limiteur de debit, assainisseur de secrets
  learning/             # Correspondance de modeles, score de confiance, cycle de vie des instincts
  intelligence/         # Analyse C#, analyse de projet, qualite de code
  dashboard/            # Tableaux de bord HTTP, WebSocket, Prometheus
  config/               # Configuration d'environnement validee par Zod
  validation/           # Schemas de validation d'entree
```

---

## Contribuer

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour la configuration du developpement, les conventions de code et les directives pour les PR.

---

## Licence

Licence MIT - voir [LICENSE](LICENSE) pour les details.
