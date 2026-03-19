<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Logo Strada.Brain" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Agent de D&eacute;veloppement Propuls&eacute; par l'IA pour les Projets Unity / Strada.Core</strong><br/>
  Un agent de programmation autonome qui se connecte &agrave; un tableau de bord web, Telegram, Discord, Slack, WhatsApp, ou votre terminal &mdash; lit votre base de code, &eacute;crit du code, lance les builds, apprend de ses erreurs et fonctionne de mani&egrave;re autonome avec une boucle daemon 24/7. D&eacute;sormais avec orchestration multi-agent, d&eacute;l&eacute;gation de t&acirc;ches, consolidation de m&eacute;moire, un sous-syst&egrave;me de d&eacute;ploiement avec portes d'approbation, partage de m&eacute;dias avec support de vision LLM, un syst&egrave;me de personnalit&eacute; configurable via SOUL.md, control-plane clarification review, un routage intelligent multi-fournisseur avec commutation dynamique selon la t&acirc;che, une v&eacute;rification par consensus bas&eacute;e sur la confiance, un Agent Core autonome avec boucle de raisonnement OODA, et l'int&eacute;gration Strada.MCP.
</p>

> Note de traduction : pour le comportement runtime actuel, les valeurs par d&eacute;faut des variables d'environnement et la s&eacute;mantique de s&eacute;curit&eacute;, la source canonique est [README.md](README.md). Ce fichier en est une traduction.

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3300%2B-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licence">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <strong>Fran&ccedil;ais</strong>
</p>

---

## Qu'est-ce que c'est ?

Strada.Brain est un agent IA avec lequel vous communiquez via un canal de chat. Vous d&eacute;crivez ce que vous voulez -- "cr&eacute;e un nouveau syst&egrave;me ECS pour le mouvement du joueur" ou "trouve tous les composants qui utilisent la sant&eacute;" -- et l'agent lit votre projet C#, &eacute;crit le code, lance `dotnet build`, corrige les erreurs automatiquement et vous envoie le r&eacute;sultat.

Il dispose d'une m&eacute;moire persistante adoss&eacute;e &agrave; SQLite + vecteurs HNSW, apprend des erreurs pass&eacute;es gr&acirc;ce &agrave; un scoring de confiance hybride pond&eacute;r&eacute;, d&eacute;compose les objectifs complexes en ex&eacute;cution parall&egrave;le via un DAG, synth&eacute;tise automatiquement des cha&icirc;nes d'outils multi-&eacute;tapes avec saga rollback et peut fonctionner en tant que daemon 24/7 avec des d&eacute;clencheurs proactifs. Il supporte l'orchestration multi-agent avec isolation par canal et session, la d&eacute;l&eacute;gation hi&eacute;rarchique de t&acirc;ches entre niveaux d'agents, la consolidation automatique de m&eacute;moire et un sous-syst&egrave;me de d&eacute;ploiement avec portes d'approbation humaine et protection par disjoncteur.

Nouveau dans cette version : Strada.Brain int&egrave;gre d&eacute;sormais un **Agent Core** -- un moteur de raisonnement OODA autonome qui observe l'environnement (modifications de fichiers, &eacute;tat git, r&eacute;sultats de build), raisonne sur les priorit&eacute;s &agrave; l'aide de mod&egrave;les appris et agit de mani&egrave;re proactive. Le syst&egrave;me de **routage multi-fournisseur** s&eacute;lectionne dynamiquement le meilleur fournisseur IA pour chaque type de t&acirc;che (planification, g&eacute;n&eacute;ration de code, d&eacute;bogage, revue) avec des pr&eacute;r&eacute;glages configurables (budget/balanced/performance). Un syst&egrave;me de **consensus bas&eacute; sur la confiance** consulte automatiquement un second fournisseur lorsque la confiance de l'agent est faible, pr&eacute;venant les erreurs sur les op&eacute;rations critiques. Toutes les fonctionnalit&eacute;s se d&eacute;gradent gracieusement -- avec un seul fournisseur, le syst&egrave;me fonctionne de mani&egrave;re identique &agrave; avant sans surco&ucirc;t.

**Ceci n'est pas une biblioth&egrave;que ni une API.** C'est une application autonome que vous ex&eacute;cutez. Elle se connecte &agrave; votre plateforme de chat, lit votre projet Unity sur le disque et fonctionne de mani&egrave;re autonome dans les limites que vous configurez.

---

## D&eacute;marrage Rapide

### Pr&eacute;requis

- **Node.js 20.19+** (ou **22.12+**) et npm
- Au moins un identifiant compatible de fournisseur IA (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.), une session OpenAI ChatGPT/Codex subscription (`OPENAI_AUTH_MODE=chatgpt-subscription`) ou une `PROVIDER_CHAIN` basee uniquement sur `ollama`
- Un **projet Unity** (le chemin donn&eacute; &agrave; l'agent). Strada.Core est recommand&eacute; pour une assistance pleinement consciente du framework.

### 1. Installation

```bash
# Cloner depuis la source (chemin d'installation canonique pour l'instant)
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain

# Aucun `cd` obligatoire : utilisez directement le checkout depuis le dossier parent
./Strada.Brain/strada install-command
./Strada.Brain/strada setup

# Optionnel si vous preferez des commandes plus courtes
cd Strada.Brain
```

```powershell
# Checkout source sous Windows PowerShell
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain
.\Strada.Brain\strada.ps1 install-command
.\Strada.Brain\strada.ps1 setup
```

Executez toutes les commandes `npm` depuis la racine du depot, c'est-a-dire le dossier qui contient `package.json`. Si vous voyez une erreur du type `ENOENT ... /Strada/package.json`, vous etes un niveau trop haut; entrez d'abord dans `Strada.Brain` ou executez `cd Strada.Brain && ...`.

`./strada` est le launcher canonique du checkout source. Au premier lancement, il prepare automatiquement le checkout, donc le setup normal n'a plus besoin de `npm link`.

Si vous sautez `./strada install-command`, continuez a utiliser `./Strada.Brain/strada ...` depuis le dossier parent ou `./strada ...` depuis la racine du depot. Apres installation, `strada ...` fonctionne depuis n'importe ou.

`./strada install-command` met aussi a jour automatiquement votre profil shell afin que les prochains terminaux trouvent `strada` sans modification manuelle du PATH.
Sous Windows, utilisez `.\strada.ps1` depuis le checkout. `install-command` ecrit `strada.cmd` et `strada.ps1` dans `%LOCALAPPDATA%\Strada\bin` et met a jour le PATH utilisateur.

Si vous voulez supprimer plus tard la commande user-local, lancez `strada uninstall` (ou `./strada uninstall` / `.\strada.ps1 uninstall` depuis le checkout). Avec `--purge-config`, Strada supprime aussi les fichiers runtime locaux au repo comme `.env`, `.strada-memory`, `.whatsapp-session`, les logs et `HEARTBEAT.md`. Le checkout du depot lui-meme n'est jamais efface automatiquement.

`strada-brain` n'est pas encore publi&eacute; sur le registre npm public. `npm install -g strada-brain` renverra donc `E404` pour le moment. En attendant une publication npm, utilisez le flux source ci-dessus.

Quand Strada est installe depuis une version npm/tarball empaquetee, sa configuration runtime est stockee par defaut dans `~/.strada` (macOS/Linux) ou `%LOCALAPPDATA%\Strada` (Windows) au lieu de dependre du dossier courant. Utilisez `STRADA_HOME=/chemin/personnalise` si vous voulez un autre app home.

### 2. Configuration

```bash
# Assistant de configuration interactif (terminal ou navigateur web)
./strada setup

# Sauter le choix initial et ouvrir directement la surface de setup voulue
./strada setup --web
./strada setup --terminal
```

```powershell
# Checkout source sous Windows PowerShell
.\strada.ps1 setup
.\strada.ps1 setup --web
.\strada.ps1 setup --terminal
```

Si `./strada setup --web` detecte une version de Node trop ancienne pour construire le portail complet, Strada garde le web comme chemin principal : si `nvm` est disponible, Strada peut installer une version compatible de Node avec votre accord puis revenir directement au setup web ; cette mise a niveau guidee s'execute dans un HOME temporaire propre afin que les options npm incompatibles `prefix` / `globalconfig` ne bloquent pas `nvm`. Sinon, il vous guide vers le telechargement/la mise a niveau. Si vous refusez la mise a niveau, Strada vous propose explicitement de continuer avec le setup terminal.
Sous Windows, ce meme flux prefere `nvm-windows`, puis `winget`, puis seulement le telechargement direct de Node. La commande de relance affichee devient alors `.\strada.ps1 setup --web`.
Si Node 22 est deja installe dans `nvm`, Strada reutilise ce runtime au lieu de le telecharger une nouvelle fois. Le flux de setup web s'ouvre sur l'URL locale racine et conserve cette meme URL lors du passage vers l'application principale.
Cette premiere ouverture navigateur porte aussi un marqueur explicite de setup, afin qu'un ancien onglet portail mis en cache retombe bien sur l'assistant plutot que sur une page morte "Not Found".
Si le premier handoff web tombe pendant le redemarrage, Strada reessaie maintenant ce lancement automatiquement. Une fois la configuration enregistree, Strada garde l'ecran de handoff sur la meme URL jusqu'a ce que l'application principale soit prete ; ne relancez donc pas le setup.

L'assistant vous demande votre chemin de projet Unity, votre cl&eacute; API de fournisseur IA, votre canal par d&eacute;faut et votre langue. `./strada setup` privilegie maintenant **Navigateur Web** par d&eacute;faut ; choisissez **Terminal** seulement si vous voulez explicitement le flux texte le plus rapide.
Le setup terminal accepte des fournisseurs separes par des virgules en une seule saisie (par ex. `kimi,deepseek`) pour le fallback ou l'orchestration multi-agent, ou vous pouvez les ajouter un par un de facon interactive. La boucle "Ajouter un autre ?" n'apparait que lorsqu'un seul fournisseur est saisi. Le choix du fournisseur d'embeddings reste separe.
Quand OpenAI utilise `chatgpt-subscription`, le setup valide maintenant la session locale Codex/ChatGPT avant l'enregistrement. Les sessions expirees sont refusees pendant le setup et egalement signalees par `strada doctor`.
Une fois l'assistant web enregistr&eacute;, Strada bascule vers l'application web principale sur la m&ecirc;me URL afin qu'un refresh pendant la transition ne vous laisse pas sur une page de setup morte.
Lors de ce premier basculement, Strada rejoue aussi le tour d'onboarding et le choix initial d'autonomy dans la premi&egrave;re session de chat, afin que la conversation d'ouverture et l'&eacute;cran Settings refl&egrave;tent imm&eacute;diatement ce qui a &eacute;t&eacute; choisi dans l'assistant.
Si le premier vrai message du chat est technique, Strada commence maintenant &agrave; traiter la t&acirc;che tout de suite et limite l'onboarding &agrave; au plus une courte question de suivi au lieu d'ouvrir un questionnaire d'intake complet.
Si le RAG est activ&eacute; sans fournisseur d'embeddings utilisable, l'assistant vous laisse maintenant aller jusqu'&agrave; l'&eacute;tape de revue ; en revanche Save reste bloqu&eacute; tant que vous n'avez pas choisi un fournisseur d'embeddings valide ou d&eacute;sactiv&eacute; le RAG.
Apr&egrave;s le premier setup r&eacute;ussi, `./strada` sans sous-commande devient votre launcher intelligent :
- au premier usage, il ouvre automatiquement le setup si la config manque
- ensuite, il affiche un panneau terminal pour choisir web, CLI, daemon, setup ou doctor
Apr&egrave;s le setup, lancez un contr&ocirc;le de readiness avant de d&eacute;marrer l'agent :

```bash
# Depuis le checkout source
./strada doctor

# Ou apres `./strada install-command`
strada doctor
```

Sur une installation git/source, `strada doctor` ne traite plus un dossier `dist/` absent comme un blocage si le launcher source fonctionne deja. Cela devient un warning avec la commande exacte du repo root pour `npm run bootstrap` seulement quand vous voulez construire les artefacts packages.

Alternativement, cr&eacute;ez `.env` manuellement :

```env
ANTHROPIC_API_KEY=sk-ant-...      # Votre cl&eacute; API Claude
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Doit contenir Assets/
JWT_SECRET=<g&eacute;n&eacute;rer avec : openssl rand -hex 64>
```

### 3. Ex&eacute;cution

```bash
# Launcher intelligent : ouvre le setup si besoin, sinon le panneau de lancement
strada

# Demarrer directement le canal par defaut en mode daemon
strada --daemon

# D&eacute;marrer avec le canal web par d&eacute;faut
strada start

# Mode CLI interactif (moyen le plus rapide pour tester)
strada start --channel cli

# Mode daemon (fonctionnement autonome 24/7 avec d&eacute;clencheurs proactifs)
strada start --channel web --daemon

# Autres canaux de chat
strada start --channel telegram
strada start --channel discord
strada start --channel slack
strada start --channel whatsapp

# Superviseur toujours actif avec red&eacute;marrage automatique
strada supervise --channel web
```

```powershell
# Launcher source sous Windows PowerShell
.\strada.ps1
.\strada.ps1 --daemon
.\strada.ps1 start
.\strada.ps1 start --channel cli
.\strada.ps1 start --channel web --daemon
```

### 4. Commandes CLI

```bash
./strada                  # Launcher canonique du checkout source
.\strada.ps1             # Launcher source pour Windows PowerShell
strada.cmd               # Companion launcher pour l'invite de commandes Windows
./strada install-command  # Installe une commande bare `strada` pour l'utilisateur
./strada uninstall        # Retire la commande bare installee et les changements PATH/profile geres
.\strada.ps1 uninstall   # Idem depuis le checkout Windows
strada uninstall --purge-config # Supprime aussi les fichiers runtime locaux au repo crees par Strada
strada                    # Launcher intelligent apres install-command
strada --daemon           # Demarrer le canal par defaut en mode daemon
strada --web              # Ouvrir le canal web ou poursuivre la configuration web sur une nouvelle machine
strada --terminal         # Ouvrir le canal terminal ou forcer la configuration terminal sur une nouvelle machine
.\strada.ps1 setup --web # Ouvrir l'assistant web directement depuis PowerShell
.\strada.ps1 setup --terminal # Ouvrir l'assistant terminal depuis PowerShell
.\strada.ps1 doctor      # Lancer doctor depuis PowerShell
./strada setup --web      # Ouvrir directement l'assistant web
./strada setup --terminal # Utiliser directement l'assistant terminal
./strada doctor           # V&eacute;rifier installation/build/config
./strada start            # D&eacute;marrer l'agent
./strada supervise        # Ex&eacute;cuter avec superviseur de red&eacute;marrage automatique
./strada update           # V&eacute;rifier et appliquer les mises &agrave; jour
./strada update --check   # V&eacute;rifier les mises &agrave; jour sans les appliquer
./strada version-info     # Afficher la version, la m&eacute;thode d'installation, l'&eacute;tat de mise &agrave; jour
```

### 5. Communiquez avec l'agent

Une fois lanc&eacute;, envoyez un message via votre canal configur&eacute; :

```
> Analyse la structure du projet
> Cr&eacute;e un nouveau module appel&eacute; "Combat" avec un DamageSystem et un HealthComponent
> Trouve tous les syst&egrave;mes qui requ&ecirc;tent PositionComponent
> Lance le build et corrige les erreurs
```

**Canal web :** Pas de terminal n&eacute;cessaire -- interagissez via le tableau de bord web sur `localhost:3000`.

### 6. Mise &agrave; jour Automatique

Strada.Brain v&eacute;rifie automatiquement les mises &agrave; jour quotidiennement et les applique en cas d'inactivit&eacute;. Les checkouts source et les installations `./strada install-command` se mettent &agrave; jour via git. Apr&egrave;s une mise &agrave; jour git r&eacute;ussie, Strada r&eacute;&eacute;crit aussi les wrappers du bare command install&eacute; afin que `strada` continue de pointer vers le checkout courant. Les commandes de mise &agrave; jour bas&eacute;es sur npm ne s'appliquent qu'une fois une publication npm publique disponible.

| Variable | Par d&eacute;faut | Description |
|----------|---------|-------------|
| `AUTO_UPDATE_ENABLED` | `true` | Activer/d&eacute;sactiver la mise &agrave; jour automatique |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | Fr&eacute;quence de v&eacute;rification (heures) |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | Minutes d'inactivit&eacute; avant d'appliquer la mise &agrave; jour |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm dist-tag : `stable` ou `latest` |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | Red&eacute;marrage automatique apr&egrave;s mise &agrave; jour en cas d'inactivit&eacute; |

---

## Architecture

```
+-----------------------------------------------------------------+
|  Chat Channels                                                   |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter interface
                               |
+------------------------------v----------------------------------+
|  Orchestrator (PAOR Agent Loop)                                  |
|  Plan -> Act -> Observe -> Reflect state machine                 |
|  Instinct retrieval, failure classification, auto-replan         |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| AI Providers | | 30+ Tools  | | Context    | | Learning System  |
| Claude (prim)| | File I/O   | | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git ops    | | (SQLite +  | | Hybrid weighted  |
| DeepSeek,Qwen| | Shell exec | |  HNSW)     | | Instinct life-   |
| MiniMax, Groq| | .NET build | | RAG vectors| |  cycle           |
| Ollama +more | | Strada gen | | Identity   | | Tool chains      |
+--------------+ +------+-----+ +---+--------+ +--+---------------+
                        |           |              |
                +-------v-----------v--------------v------+
                |  Goal Decomposer + Goal Executor        |
                |  DAG-based decomposition, wave-based    |
                |  parallel execution, failure budgets    |
                +---------+------------------+------------+
                          |                  |
          +---------------v------+  +--------v--------------------+
          | Multi-Agent Manager  |  | Task Delegation             |
          | Per-channel sessions |  | TierRouter (4-tier)         |
          | AgentBudgetTracker   |  | DelegationTool + Manager    |
          | AgentRegistry        |  | Max depth 2, budget-aware   |
          +---------------+------+  +--------+--------------------+
                          |                  |
                +---------v------------------v------------+
                |  Memory Decay & Consolidation           |
                |  Exponential decay, idle consolidation   |
                |  HNSW clustering, soft-delete + undo     |
                +-----------------------------------------+
                               |
            +------------------v-------------------+
            |  Daemon (HeartbeatLoop)              |
            |  Cron, file-watch, checklist,        |
            |  webhook, deploy triggers            |
            |  Circuit breakers, budget tracking,  |
            |  trigger deduplication                |
            |  Notification router + digest reports |
            +------------------+-------------------+
                               |
            +------------------v-------------------+
            |  Deployment Subsystem                |
            |  ReadinessChecker, DeployTrigger      |
            |  DeploymentExecutor                   |
            |  Approval gate + circuit breaker      |
            +--------------------------------------+
```

### Fonctionnement de la Boucle Agent

1. **Message re&ccedil;u** depuis un canal de chat (texte, images, vid&eacute;o, audio ou documents)
2. **R&eacute;cup&eacute;ration m&eacute;moire** -- recherche hybride AgentDB (70% s&eacute;mantique HNSW + 30% TF-IDF) pour trouver les conversations pass&eacute;es les plus pertinentes
3. **R&eacute;cup&eacute;ration RAG** -- recherche s&eacute;mantique sur votre code C# (vecteurs HNSW, top 6 r&eacute;sultats)
4. **R&eacute;cup&eacute;ration d'instincts** -- interroge proactivement les motifs appris pertinents pour la t&acirc;che (correspondance s&eacute;mantique + par mots-cl&eacute;s)
5. **Contexte d'identit&eacute;** -- injecte l'identit&eacute; persistante de l'agent (UUID, nombre de d&eacute;marrages, temps de fonctionnement, &eacute;tat de r&eacute;cup&eacute;ration apr&egrave;s crash)
6. **Phase PLAN** -- le LLM cr&eacute;e un plan num&eacute;rot&eacute;, inform&eacute; par les connaissances apprises et les &eacute;checs pass&eacute;s
7. **Phase AGIR** -- le LLM ex&eacute;cute les appels d'outils selon le plan
8. **OBSERVER** -- les r&eacute;sultats sont enregistr&eacute;s ; la r&eacute;cup&eacute;ration d'erreurs analyse les pannes ; le classificateur cat&eacute;gorise les erreurs
9. **R&Eacute;FL&Eacute;CHIR** -- tous les 3 pas (ou en cas d'erreur), le LLM d&eacute;cide : **CONTINUER**, **REPLANIFIER** ou **TERMIN&Eacute;**
10. **Replanification automatique** -- si 3+ &eacute;checs cons&eacute;cutifs du m&ecirc;me type, force une nouvelle approche en &eacute;vitant les strat&eacute;gies ayant &eacute;chou&eacute;
11. **R&eacute;p&eacute;ter** jusqu'&agrave; 50 it&eacute;rations jusqu'&agrave; compl&eacute;tion
12. **Apprentissage** -- les r&eacute;sultats des outils transitent par le TypedEventBus vers le pipeline d'apprentissage pour un stockage imm&eacute;diat des motifs
13. **R&eacute;ponse envoy&eacute;e** &agrave; l'utilisateur via le canal (streaming si support&eacute;)

---

## Syst&egrave;me de M&eacute;moire

Le backend de m&eacute;moire actif est `AgentDBMemory` -- SQLite avec indexation vectorielle HNSW et une architecture &agrave; trois niveaux avec placement automatique.

**M&eacute;moire &agrave; trois niveaux :**
- **M&eacute;moire de travail** -- contexte de la session active, promue automatiquement apr&egrave;s une utilisation soutenue
- **M&eacute;moire &eacute;ph&eacute;m&egrave;re** -- stockage &agrave; court terme, &eacute;vinc&eacute;e automatiquement lorsque les seuils de capacit&eacute; sont atteints
- **M&eacute;moire persistante** -- stockage &agrave; long terme, promue depuis l'&eacute;ph&eacute;m&egrave;re en fonction de la fr&eacute;quence d'acc&egrave;s et de l'importance

**Fonctionnement :**
- Le rognage de session utilise des seuils adapt&eacute;s au fournisseur, puis les segments retir&eacute;s sont persist&eacute;s en m&eacute;moire avant de quitter le contexte actif
- La r&eacute;cup&eacute;ration hybride combine 70% de similarit&eacute; s&eacute;mantique (vecteurs HNSW) avec 30% de correspondance par mots-cl&eacute;s TF-IDF
- L'outil `strada_analyze_project` met en cache l'analyse de la structure du projet pour une injection de contexte instantan&eacute;e
- La m&eacute;moire persiste entre les red&eacute;marrages dans le r&eacute;pertoire `MEMORY_DB_PATH` (d&eacute;faut : `.strada-memory/`)
- La migration automatique depuis l'ancien FileMemoryManager s'ex&eacute;cute au premier d&eacute;marrage

**Repli :** Si l'initialisation d'AgentDB &eacute;choue, le syst&egrave;me bascule automatiquement vers `FileMemoryManager` (JSON + TF-IDF).

---

## Syst&egrave;me d'Apprentissage

Le syst&egrave;me d'apprentissage observe le comportement de l'agent et apprend de ses erreurs via un pipeline &eacute;v&eacute;nementiel.

**Pipeline &eacute;v&eacute;nementiel :**
- Les r&eacute;sultats des outils transitent par le `TypedEventBus` vers une `LearningQueue` s&eacute;rielle pour un traitement imm&eacute;diat
- Pas de traitement par lots bas&eacute; sur des minuteurs -- les motifs sont d&eacute;tect&eacute;s et stock&eacute;s au fur et &agrave; mesure
- La `LearningQueue` utilise un FIFO born&eacute; avec isolation des erreurs (les &eacute;checs d'apprentissage ne font jamais planter l'agent)

**Scoring de confiance hybride pond&eacute;r&eacute; :**
- Confiance = somme pond&eacute;r&eacute;e de 5 facteurs : tauxR&eacute;ussite (0.35), force du motif (0.25), r&eacute;cence (0.20), correspondance contexte (0.15), v&eacute;rification (0.05)
- Les scores de verdict (0.0-1.0) mettent &agrave; jour les compteurs d'&eacute;vidence alpha/beta pour les intervalles de confiance
- Les param&egrave;tres alpha/beta sont maintenus pour l'estimation d'incertitude mais ne sont pas utilis&eacute;s pour le calcul principal de confiance

**Cycle de vie des instincts :**
- **Propos&eacute;** (nouveau) -- confiance inf&eacute;rieure &agrave; 0.7
- **Actif** -- confiance entre 0.7 et 0.9
- **&Eacute;volu&eacute;** -- sup&eacute;rieure &agrave; 0.9, propos&eacute; pour promotion en permanent
- **D&eacute;pr&eacute;ci&eacute;** -- inf&eacute;rieure &agrave; 0.3, marqu&eacute; pour suppression
- **P&eacute;riode de refroidissement** -- fen&ecirc;tre de 7 jours avec exigences minimales d'observation avant les changements de statut
- **Permanent** -- gel&eacute;, plus aucune mise &agrave; jour de confiance

**R&eacute;cup&eacute;ration active :** Les instincts sont interrog&eacute;s proactivement au d&eacute;but de chaque t&acirc;che via l'`InstinctRetriever`. Il recherche par similarit&eacute; de mots-cl&eacute;s et par embeddings vectoriels HNSW pour trouver les motifs appris pertinents, qui sont inject&eacute;s dans le prompt de la phase PLAN.

**Apprentissage inter-sessions :** Les instincts portent des m&eacute;tadonn&eacute;es de provenance (session source, nombre de sessions) pour le transfert de connaissances entre sessions.

---

## D&eacute;composition d'Objectifs

Les requ&ecirc;tes complexes multi-&eacute;tapes sont automatiquement d&eacute;compos&eacute;es en un graphe acyclique dirig&eacute; (DAG) de sous-objectifs.

**GoalDecomposer :**
- La v&eacute;rification heuristique pr&eacute;alable &eacute;vite les appels LLM pour les t&acirc;ches simples (correspondance de motifs pour les indicateurs de complexit&eacute;)
- Le LLM g&eacute;n&egrave;re des structures DAG avec des ar&ecirc;tes de d&eacute;pendance et une profondeur r&eacute;cursive optionnelle (jusqu'&agrave; 3 niveaux)
- L'algorithme de Kahn valide l'absence de cycles dans la structure DAG
- Red&eacute;composition r&eacute;active : lorsqu'un noeud &eacute;choue, il peut &ecirc;tre d&eacute;compos&eacute; en &eacute;tapes de r&eacute;cup&eacute;ration plus petites

**GoalExecutor :**
- Ex&eacute;cution parall&egrave;le par vagues respectant l'ordre des d&eacute;pendances
- Limitation de la concurrence par s&eacute;maphore (`GOAL_MAX_PARALLEL`)
- Budgets d'&eacute;checs (`GOAL_MAX_FAILURES`) avec invites de continuation pour l'utilisateur
- &Eacute;valuation de criticit&eacute; par le LLM pour d&eacute;terminer si un noeud en &eacute;chec doit bloquer ses d&eacute;pendants
- Logique de r&eacute;essai par noeud (`GOAL_MAX_RETRIES`) avec d&eacute;composition de r&eacute;cup&eacute;ration en cas d'&eacute;puisement
- Support AbortSignal pour l'annulation
- &Eacute;tat persistant de l'arbre d'objectifs via `GoalStorage` (SQLite) pour la reprise apr&egrave;s red&eacute;marrage

---

## Synth&egrave;se de Cha&icirc;nes d'Outils

L'agent d&eacute;tecte et synth&eacute;tise automatiquement des motifs de cha&icirc;nes d'outils multi-&eacute;tapes en outils composites r&eacute;utilisables. La V2 ajoute l'ex&eacute;cution parall&egrave;le bas&eacute;e sur un DAG et le saga rollback pour les cha&icirc;nes complexes.

**Pipeline :**
1. **ChainDetector** -- analyse les donn&eacute;es de trajectoire pour trouver des s&eacute;quences d'outils r&eacute;currentes (ex. : `file_read` -> `file_edit` -> `dotnet_build`)
2. **ChainSynthesizer** -- utilise le LLM pour g&eacute;n&eacute;rer un `CompositeTool` avec un mapping entr&eacute;e/sortie et une description ad&eacute;quats
3. **ChainValidator** -- validation post-synth&egrave;se avec retour d'information &agrave; l'ex&eacute;cution ; suit le succ&egrave;s d'ex&eacute;cution des cha&icirc;nes via le scoring de confiance pond&eacute;r&eacute;
4. **ChainManager** -- orchestrateur du cycle de vie : charge les cha&icirc;nes existantes au d&eacute;marrage, lance la d&eacute;tection p&eacute;riodique, invalide automatiquement les cha&icirc;nes lorsque des outils composants sont supprim&eacute;s

**Am&eacute;liorations V2 :**
- **Ex&eacute;cution DAG** -- les &eacute;tapes ind&eacute;pendantes s'ex&eacute;cutent en parall&egrave;le
- **Saga rollback** -- en cas d'&eacute;chec, les &eacute;tapes pr&eacute;c&eacute;dentes sont annul&eacute;es en ordre inverse
- **Versionnage des cha&icirc;nes** -- les anciennes versions sont archiv&eacute;es

**S&eacute;curit&eacute; :** Les outils composites h&eacute;ritent des indicateurs de s&eacute;curit&eacute; les plus restrictifs de leurs outils composants.

**Cascade de confiance :** Les instincts de cha&icirc;nes suivent le m&ecirc;me cycle de vie de confiance que les instincts classiques. Les cha&icirc;nes qui passent sous le seuil de d&eacute;pr&eacute;ciation sont automatiquement d&eacute;senregistr&eacute;es.

---

## Orchestration Multi-Agent

Plusieurs instances d'agents peuvent fonctionner simultan&eacute;ment avec isolation par canal et session.

**AgentManager :**
- Cr&eacute;e et g&egrave;re les instances d'agents par canal/session
- L'isolation des sessions garantit que les agents sur diff&eacute;rents canaux n'interf&egrave;rent pas entre eux
- Configurable via `MULTI_AGENT_ENABLED` (activ&eacute; par d&eacute;faut ; utilisez `false` pour revenir au comportement mono-agent historique)

**AgentBudgetTracker :**
- Suivi budg&eacute;taire par agent en tokens et en co&ucirc;t avec limites configurables
- Plafonds budg&eacute;taires journaliers/mensuels partag&eacute;s entre tous les agents
- L'&eacute;puisement du budget d&eacute;clenche une d&eacute;gradation gracieuse (mode lecture seule) plut&ocirc;t qu'un &eacute;chec brutal

**AgentRegistry :**
- Registre central de toutes les instances d'agents actives
- Supporte les v&eacute;rifications de sant&eacute; et l'arr&ecirc;t gracieux
- Le multi-agent est enti&egrave;rement opt-in : lorsque d&eacute;sactiv&eacute;, le syst&egrave;me fonctionne de mani&egrave;re identique &agrave; la v2.0

---

## D&eacute;l&eacute;gation de T&acirc;ches

Les agents peuvent d&eacute;l&eacute;guer des sous-t&acirc;ches &agrave; d'autres agents en utilisant un syst&egrave;me de routage par niveaux.

**TierRouter (4 niveaux) :**
- **Niveau 1** -- t&acirc;ches simples trait&eacute;es par l'agent courant (pas de d&eacute;l&eacute;gation)
- **Niveau 2** -- complexit&eacute; mod&eacute;r&eacute;e, d&eacute;l&eacute;gu&eacute;e &agrave; un agent secondaire
- **Niveau 3** -- haute complexit&eacute;, d&eacute;l&eacute;gu&eacute;e avec un budget &eacute;tendu
- **Niveau 4** -- t&acirc;ches critiques n&eacute;cessitant des capacit&eacute;s d'agent sp&eacute;cialis&eacute;es

**DelegationManager :**
- G&egrave;re le cycle de vie de la d&eacute;l&eacute;gation : cr&eacute;ation, suivi, compl&eacute;tion, annulation
- Impose une profondeur maximale de d&eacute;l&eacute;gation (d&eacute;faut : 2) pour &eacute;viter les boucles de d&eacute;l&eacute;gation infinies
- Conscient du budget : les t&acirc;ches d&eacute;l&eacute;gu&eacute;es h&eacute;ritent d'une portion du budget restant du parent

**DelegationTool :**
- Expos&eacute; comme un outil que l'agent peut invoquer pour d&eacute;l&eacute;guer du travail
- Inclut l'agr&eacute;gation des r&eacute;sultats des sous-t&acirc;ches d&eacute;l&eacute;gu&eacute;es

---

## D&eacute;gradation et Consolidation de M&eacute;moire

Les entr&eacute;es m&eacute;moire se d&eacute;gradent naturellement au fil du temps selon un mod&egrave;le de d&eacute;gradation exponentielle, tandis que la consolidation en p&eacute;riode d'inactivit&eacute; r&eacute;duit la redondance.

**D&eacute;gradation exponentielle :**
- Chaque entr&eacute;e m&eacute;moire poss&egrave;de un score de d&eacute;gradation qui diminue au fil du temps
- La fr&eacute;quence d'acc&egrave;s et l'importance renforcent la r&eacute;sistance &agrave; la d&eacute;gradation
- Les instincts sont exempt&eacute;s de la d&eacute;gradation (n'expirent jamais)

**Consolidation en p&eacute;riode d'inactivit&eacute; :**
- Pendant les p&eacute;riodes de faible activit&eacute;, le moteur de consolidation identifie les m&eacute;moires s&eacute;mantiquement similaires par clustering HNSW
- Les m&eacute;moires li&eacute;es sont fusionn&eacute;es en r&eacute;sum&eacute;s consolid&eacute;s, r&eacute;duisant le stockage et am&eacute;liorant la qualit&eacute; de r&eacute;cup&eacute;ration
- Suppression douce avec annulation : les m&eacute;moires sources consolid&eacute;es sont marqu&eacute;es comme consolid&eacute;es (non supprim&eacute;es physiquement) et peuvent &ecirc;tre restaur&eacute;es

**Moteur de consolidation :**
- Seuil de similarit&eacute; configurable pour la d&eacute;tection de clusters
- Traitement par lots avec tailles de blocs configurables
- Piste d'audit compl&egrave;te des op&eacute;rations de consolidation

---

## Sous-syst&egrave;me de D&eacute;ploiement

Un syst&egrave;me de d&eacute;ploiement opt-in avec portes d'approbation humaine et protection par disjoncteur.

**ReadinessChecker :**
- Valide la pr&eacute;paration du syst&egrave;me avant le d&eacute;ploiement (&eacute;tat du build, r&eacute;sultats des tests, disponibilit&eacute; des ressources)
- Crit&egrave;res de pr&eacute;paration configurables

**DeployTrigger :**
- S'int&egrave;gre au syst&egrave;me de d&eacute;clencheurs du daemon comme nouveau type de d&eacute;clencheur
- Se d&eacute;clenche lorsque les conditions de d&eacute;ploiement sont remplies (ex. : tous les tests passent, approbation accord&eacute;e)
- Inclut une file d'approbation : les d&eacute;ploiements n&eacute;cessitent une approbation humaine explicite avant ex&eacute;cution

**DeploymentExecutor :**
- Ex&eacute;cute les &eacute;tapes de d&eacute;ploiement en s&eacute;quence avec capacit&eacute; de rollback
- L'assainissement des variables d'environnement emp&ecirc;che la fuite d'identifiants dans les journaux de d&eacute;ploiement
- Disjoncteur : les &eacute;checs de d&eacute;ploiement cons&eacute;cutifs d&eacute;clenchent un refroidissement automatique pour &eacute;viter les pannes en cascade

**S&eacute;curit&eacute; :** Le d&eacute;ploiement est d&eacute;sactiv&eacute; par d&eacute;faut et n&eacute;cessite un opt-in explicite via la configuration. Toutes les actions de d&eacute;ploiement sont journalis&eacute;es et auditables.

---

### Agent Core (Boucle OODA Autonome)

Lorsque le mode daemon est actif, l'Agent Core ex&eacute;cute une boucle continue observer-orienter-d&eacute;cider-agir :

- **Observer** : Collecte l'&eacute;tat de l'environnement depuis 6 observateurs (modifications de fichiers, &eacute;tat git, r&eacute;sultats de build, &eacute;v&eacute;nements de d&eacute;clencheurs, activit&eacute; utilisateur, r&eacute;sultats de tests)
- **Orienter** : &Eacute;value les observations en utilisant une priorit&eacute; inform&eacute;e par l'apprentissage (PriorityScorer avec int&eacute;gration des instincts)
- **D&eacute;cider** : Raisonnement LLM avec limitation de d&eacute;bit consciente du budget (intervalle minimum de 30s, seuil de priorit&eacute;, plancher de budget)
- **Agir** : Soumet des objectifs, notifie l'utilisateur ou attend (l'agent peut d&eacute;cider "rien &agrave; faire")

S&eacute;curit&eacute; : garde tickInFlight, limitation de d&eacute;bit, plancher de budget (10%) et application de DaemonSecurityPolicy.

### Routage Intelligent Multi-Fournisseur

Avec 2 fournisseurs ou plus configur&eacute;s, Strada.Brain route automatiquement les t&acirc;ches vers le fournisseur optimal :

| Type de T&acirc;che | Strat&eacute;gie de Routage |
|-------------------|--------------------------|
| Planification | Fen&ecirc;tre de contexte la plus large (Claude > GPT > Gemini) |
| G&eacute;n&eacute;ration de Code | Appels d'outils puissants (Claude > Kimi > OpenAI) |
| Revue de Code | Mod&egrave;le diff&eacute;rent de l'ex&eacute;cuteur (biais de diversit&eacute;) |
| Questions Simples | Le plus rapide/&eacute;conomique (Groq > Kimi > Ollama) |
| D&eacute;bogage | Analyse d'erreurs puissante |

**Pr&eacute;r&eacute;glages** : `budget` (optimis&eacute; co&ucirc;t), `balanced` (par d&eacute;faut), `performance` (qualit&eacute; d'abord)
**Commutation de Phase PAOR** : Fournisseurs diff&eacute;rents pour la planification, l'ex&eacute;cution et la r&eacute;flexion.
**Consensus** : Confiance basse &rarr; second avis automatique d'un fournisseur diff&eacute;rent.

### Int&eacute;gration Strada.MCP

Strada.Brain d&eacute;tecte [Strada.MCP](https://github.com/okandemirel/Strada.MCP) (serveur MCP Unity) et informe l'agent des capacit&eacute;s MCP disponibles, y compris le contr&ocirc;le d'ex&eacute;cution, les op&eacute;rations de fichiers, git, le build .NET, l'analyse de code et la gestion des sc&egrave;nes/prefabs. Seuls les outils MCP d'action ex&eacute;cutables dans le runtime Brain courant entrent dans la surface d'outils du worker; les capacit&eacute;s MCP limit&eacute;es par le bridge/runtime restent des authoritative docs/resources.

---

## Mode Daemon

Le daemon fournit un fonctionnement autonome 24/7 avec un syst&egrave;me de d&eacute;clencheurs pilot&eacute; par un battement de coeur. Lorsque le mode daemon est actif, la **boucle OODA de l'Agent Core** s'ex&eacute;cute au sein des ticks du daemon, observant l'environnement et agissant de mani&egrave;re proactive entre les interactions utilisateur. La commande `/autonomous on` se propage d&eacute;sormais au DaemonSecurityPolicy, permettant un fonctionnement enti&egrave;rement autonome sans invites d'approbation par action.

```bash
npm run dev -- daemon --channel web
```

**HeartbeatLoop :**
- Intervalle de tick configurable &eacute;valuant les d&eacute;clencheurs enregistr&eacute;s &agrave; chaque cycle
- &Eacute;valuation s&eacute;quentielle des d&eacute;clencheurs pour &eacute;viter les conditions de course sur le budget
- Persistance de l'&eacute;tat d'ex&eacute;cution pour la r&eacute;cup&eacute;ration apr&egrave;s crash

**Types de d&eacute;clencheurs :**
- **Cron** -- t&acirc;ches planifi&eacute;es utilisant des expressions cron
- **Surveillance de fichiers** -- surveille les modifications du syst&egrave;me de fichiers dans les chemins configur&eacute;s
- **Checklist** -- se d&eacute;clenche lorsque des &eacute;l&eacute;ments de la checklist arrivent &agrave; &eacute;ch&eacute;ance
- **Webhook** -- endpoint HTTP POST d&eacute;clenchant des t&acirc;ches sur les requ&ecirc;tes entrantes
- **Deploy** -- se d&eacute;clenche lorsque les conditions de d&eacute;ploiement sont remplies (porte d'approbation requise)

**R&eacute;silience :**
- **Disjoncteurs** -- par d&eacute;clencheur avec refroidissement &agrave; backoff exponentiel, persist&eacute;s entre les red&eacute;marrages
- **Suivi du budget** -- plafond de d&eacute;penses journalier en USD avec &eacute;v&eacute;nements de seuil d'alerte
- **D&eacute;duplication des d&eacute;clencheurs** -- suppression bas&eacute;e sur le contenu et sur les p&eacute;riodes de refroidissement pour &eacute;viter les d&eacute;clenchements en double
- **Suppression de chevauchement** -- ignore les d&eacute;clencheurs qui ont d&eacute;j&agrave; une t&acirc;che active en cours d'ex&eacute;cution

**S&eacute;curit&eacute; :**
- `DaemonSecurityPolicy` contr&ocirc;le quels outils n&eacute;cessitent l'approbation de l'utilisateur lorsqu'ils sont invoqu&eacute;s par des d&eacute;clencheurs du daemon
- `ApprovalQueue` avec expiration configurable pour les op&eacute;rations d'&eacute;criture

**Rapports :**
- `NotificationRouter` achemine les &eacute;v&eacute;nements vers les canaux configur&eacute;s selon le niveau d'urgence (silencieux/bas/moyen/haut/critique)
- Limitation du d&eacute;bit par urgence et support des heures calmes (notifications non critiques mises en tampon)
- `DigestReporter` g&eacute;n&egrave;re des rapports de synth&egrave;se p&eacute;riodiques
- Toutes les notifications sont journalis&eacute;es dans un historique SQLite

---

## Syst&egrave;me d'Identit&eacute;

L'agent maintient une identit&eacute; persistante entre les sessions et les red&eacute;marrages.

**IdentityStateManager** (adoss&eacute; &agrave; SQLite) :
- UUID unique g&eacute;n&eacute;r&eacute; au premier d&eacute;marrage
- Nombre de d&eacute;marrages, temps de fonctionnement cumul&eacute;, horodatages de derni&egrave;re activit&eacute;
- Compteurs totaux de messages et de t&acirc;ches
- D&eacute;tection d'arr&ecirc;t propre pour la r&eacute;cup&eacute;ration apr&egrave;s crash
- Cache de compteurs en m&eacute;moire avec vidage p&eacute;riodique pour minimiser les &eacute;critures SQLite

**R&eacute;cup&eacute;ration apr&egrave;s crash :**
- Au d&eacute;marrage, si la session pr&eacute;c&eacute;dente ne s'est pas termin&eacute;e proprement, un `CrashRecoveryContext` est construit
- Inclut la dur&eacute;e d'indisponibilit&eacute;, les arbres d'objectifs interrompus et le nombre de d&eacute;marrages
- Inject&eacute; dans le prompt syst&egrave;me pour que le LLM reconnaisse naturellement le crash et puisse reprendre le travail interrompu

---

## R&eacute;f&eacute;rence de Configuration

Toute la configuration se fait via des variables d'environnement. Consultez `.env.example` pour la liste compl&egrave;te.

### Obligatoires

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Cl&eacute; API Claude (fournisseur LLM principal) |
| `UNITY_PROJECT_PATH` | Chemin absolu vers la racine de votre projet Unity (doit contenir `Assets/`) |
| `JWT_SECRET` | Secret pour la signature JWT. G&eacute;n&eacute;rer : `openssl rand -hex 64` |

### Fournisseurs d'IA

Tout fournisseur compatible OpenAI fonctionne. Tous les fournisseurs ci-dessous sont d&eacute;j&agrave; impl&eacute;ment&eacute;s&nbsp;; la plupart s'activent avec une cl&eacute; API, et OpenAI peut aussi r&eacute;utiliser l'abonnement local ChatGPT/Codex de cette machine pour les conversations.

| Variable | Fournisseur | Mod&egrave;le par D&eacute;faut |
|----------|-------------|-------------------|
| `ANTHROPIC_API_KEY` | Claude (principal) | `claude-sonnet-4-20250514` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `DEEPSEEK_API_KEY` | DeepSeek | `deepseek-chat` |
| `GROQ_API_KEY` | Groq | `llama-3.3-70b-versatile` |
| `QWEN_API_KEY` | Alibaba Qwen | `qwen-plus` |
| `KIMI_API_KEY` | Moonshot Kimi | `moonshot-v1-8k` |
| `MINIMAX_API_KEY` | MiniMax | `MiniMax-M2.7` |
| `MISTRAL_API_KEY` | Mistral AI | `mistral-large-latest` |
| `TOGETHER_API_KEY` | Together AI | `meta-llama/Llama-3-70b-chat-hf` |
| `FIREWORKS_API_KEY` | Fireworks AI | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `GEMINI_API_KEY` | Google Gemini | `gemini-pro` |
| `OLLAMA_BASE_URL` | Ollama (local) | `llama3` |
| `PROVIDER_CHAIN` | Ordre de basculement | ex. `claude,kimi,deepseek,ollama` |
| `OPENAI_AUTH_MODE` | Mode d'authentification OpenAI | `api-key` (par d&eacute;faut) ou `chatgpt-subscription` |
| `OPENAI_CHATGPT_AUTH_FILE` | Fichier de session Codex optionnel | `~/.codex/auth.json` par d&eacute;faut quand `OPENAI_AUTH_MODE=chatgpt-subscription` |

**Cha&icirc;ne de fournisseurs :** D&eacute;finissez `PROVIDER_CHAIN` avec une liste de noms de fournisseurs s&eacute;par&eacute;s par des virgules. Strada reste le plan de contr&ocirc;le et s'en sert comme pool d'orchestration par d&eacute;faut pour le worker principal, le routage du superviseur et les fallbacks. Exemple : `PROVIDER_CHAIN=kimi,deepseek,claude` utilise Kimi en premier, DeepSeek si Kimi &eacute;choue, puis Claude.
La clarification fait aussi partie de ce plan de contr&ocirc;le. Un worker peut proposer une question &agrave; l'utilisateur, mais Strada ex&eacute;cute d'abord une phase interne de `clarification-review` avant qu'un brouillon puisse devenir un tour `ask_user`.
La finalisation passe maintenant elle aussi par un verifier pipeline interne. La v&eacute;rification de build, le targeted repro / failing-path, la revue des logs, la conformance Strada et la completion review doivent &ecirc;tre propres avant que Strada termine. `/routing info` et le dashboard affichent maintenant &agrave; la fois les traces d'ex&eacute;cution r&eacute;elles et les phase outcomes (`approved`, `continued`, `replanned`, `blocked`).
Strada conserve d&eacute;sormais aussi un execution journal et une rollback memory internes pour chaque t&acirc;che. Les replans peuvent r&eacute;utiliser le dernier checkpoint stable, m&eacute;moriser les branches &eacute;puis&eacute;es, transporter un project/world anchor et renvoyer des adaptive phase scores vers le routing sans lore de fournisseur hardcod&eacute;. Ces scores tiennent maintenant aussi compte du verifier clean rate, du rollback pressure, du retry count, des repeated failure fingerprints, des repeated world-context failures, du phase-local token cost, du provider catalog freshness et de l'official alignment / capability drift du catalogue partag&eacute;.
La m&eacute;moire est maintenant s&eacute;par&eacute;e par r&ocirc;le : user profile state garde nom/pr&eacute;f&eacute;rences/autonomy, task execution memory garde session summaries/open items/rollback state, et project/world memory est maintenant inject&eacute; explicitement &agrave; partir du project root actif plus la AgentDB analysis en cache. Task execution memory ne garde que le `latest snapshot` de l'identit&eacute; active ; la `persisted chronology` d'un task run exact n'y vit pas. Cette m&ecirc;me couche project/world alimente maintenant aussi la recovery memory et l'adaptive routing, pendant que semantic retrieval ajoute toujours la m&eacute;moire pertinente en direct s&eacute;par&eacute;ment.
Le `execution replay` cross-session suit maintenant cette m&ecirc;me voie : Strada enregistre des project/world-aware recovery summaries dans les learning trajectories et r&eacute;injecte les success/failure branches les plus pertinentes comme couche de contexte `Execution Replay` avant de retenter un travail similaire.
La corr&eacute;lation du replay est maintenant aussi persist&eacute;e avec un `taskRunId` scoped au chat, afin que des t&acirc;ches concurrentes dans le m&ecirc;me chat ne m&eacute;langent pas leur phase telemetry ni leur recovery history. La `persisted chronology` d'un task run exact vit dans ces learning trajectories / replay contexts index&eacute;es par `taskRunId`.
Ce m&ecirc;me chemin de learning mat&eacute;rialise maintenant aussi des runtime self-improvement artifacts : les motifs r&eacute;p&eacute;t&eacute;s &agrave; forte confiance naissent d'abord comme `skill`, `workflow` ou `knowledge_patch` en &eacute;tat `shadow`; seules des &eacute;valuations shadow propres et valid&eacute;es par le verifier les promeuvent en guidance `active`. `/routing info` et le dashboard affichent une t&eacute;l&eacute;m&eacute;trie identity-scoped pour le projet actif : &eacute;tat, &eacute;chantillons et r&eacute;partition clean/retry/failure.
Ce replay context persiste maintenant aussi la phase/provider telemetry, afin que l'adaptive routing puisse r&eacute;utiliser les workers qui ont d&eacute;j&agrave; r&eacute;ussi sur des t&acirc;ches similaires au lieu de ne regarder que la runtime history en m&eacute;moire.

**Important :** `OPENAI_AUTH_MODE=chatgpt-subscription` couvre uniquement les tours de conversation OpenAI dans Strada. Cela ne donne pas de quota API ni embeddings OpenAI. Si vous choisissez `EMBEDDING_PROVIDER=openai`, il vous faut toujours `OPENAI_API_KEY`.
Strada ne renvoie pas les prochaines etapes evidentes a l'utilisateur. Si un fournisseur renvoie une analyse incomplete, demande quoi faire ensuite, ou affirme une completion large sans preuves suffisantes, Strada rouvre la boucle, relance une passe d'inspection/revue, et ne repond que lorsque le resultat est verifie ou qu'un vrai blocage externe subsiste.

### Canaux de Chat

**Web :**
| Variable | Description |
|----------|-------------|
| `WEB_CHANNEL_PORT` | Port du tableau de bord web (d&eacute;faut : `3000`) |

**Telegram :**
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token obtenu de @BotFather |
| `ALLOWED_TELEGRAM_USER_IDS` | IDs utilisateur Telegram s&eacute;par&eacute;s par des virgules (obligatoire, refuse tout si vide) |

**Discord :**
| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Token du bot Discord |
| `DISCORD_GUILD_ID` | ID du serveur (guild) Discord |
| `ALLOWED_DISCORD_USER_IDS` | IDs utilisateur s&eacute;par&eacute;s par des virgules (refuse tout si vide) |
| `ALLOWED_DISCORD_ROLE_IDS` | IDs de r&ocirc;le s&eacute;par&eacute;s par des virgules pour l'acc&egrave;s par r&ocirc;le |

**Slack :**
| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Token de bot `xoxb-...` |
| `SLACK_APP_TOKEN` | Token au niveau application `xapp-...` (pour le mode socket) |
| `SLACK_SIGNING_SECRET` | Secret de signature de l'application Slack |
| `ALLOWED_SLACK_USER_IDS` | IDs utilisateur s&eacute;par&eacute;s par des virgules (**ouvert &agrave; tous si vide**) |
| `ALLOWED_SLACK_WORKSPACES` | IDs d'espace de travail s&eacute;par&eacute;s par des virgules (**ouvert &agrave; tous si vide**) |

**WhatsApp :**
| Variable | Description |
|----------|-------------|
| `WHATSAPP_SESSION_PATH` | R&eacute;pertoire pour les fichiers de session (d&eacute;faut : `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | Num&eacute;ros de t&eacute;l&eacute;phone s&eacute;par&eacute;s par des virgules (optionnel ; vide = acc&egrave;s ouvert) |

### Fonctionnalit&eacute;s

| Variable | D&eacute;faut | Description |
|----------|--------|-------------|
| `RAG_ENABLED` | `true` | Active la recherche s&eacute;mantique de code sur votre projet C# |
| `EMBEDDING_PROVIDER` | `auto` | Fournisseur d'embeddings : `auto`, `openai`, `gemini`, `mistral`, `together`, `fireworks`, `qwen`, `ollama` |
| `EMBEDDING_DIMENSIONS` | (d&eacute;faut fournisseur) | Dimensions des vecteurs de sortie (Matryoshka : 128-3072 pour Gemini/OpenAI) |
| `MEMORY_ENABLED` | `true` | Active la m&eacute;moire persistante des conversations |
| `MEMORY_DB_PATH` | `.strada-memory` | R&eacute;pertoire des fichiers de la base de donn&eacute;es m&eacute;moire |
| `WEB_CHANNEL_PORT` | `3000` | Port du tableau de bord web |
| `DASHBOARD_ENABLED` | `false` | Active le tableau de bord de surveillance HTTP |
| `DASHBOARD_PORT` | `3100` | Port du serveur du tableau de bord |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | Active le tableau de bord en temps r&eacute;el WebSocket |
| `ENABLE_PROMETHEUS` | `false` | Active l'endpoint de m&eacute;triques Prometheus (port 9090) |
| `MULTI_AGENT_ENABLED` | `true` | Activer l'orchestration multi-agent |
| `TASK_DELEGATION_ENABLED` | `false` | Activer la d&eacute;l&eacute;gation de t&acirc;ches entre agents |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | Profondeur maximale de cha&icirc;ne de d&eacute;l&eacute;gation |
| `DEPLOY_ENABLED` | `false` | Activer le sous-syst&egrave;me de d&eacute;ploiement |
| `SOUL_FILE` | `soul.md` | Chemin vers le fichier de personnalit&eacute; de l'agent (rechargement &agrave; chaud lors des changements) |
| `SOUL_FILE_WEB` | (non d&eacute;fini) | Remplacement de personnalit&eacute; par canal pour le canal web |
| `SOUL_FILE_TELEGRAM` | (non d&eacute;fini) | Remplacement de personnalit&eacute; par canal pour Telegram |
| `SOUL_FILE_DISCORD` | (non d&eacute;fini) | Remplacement de personnalit&eacute; par canal pour Discord |
| `SOUL_FILE_SLACK` | (non d&eacute;fini) | Remplacement de personnalit&eacute; par canal pour Slack |
| `SOUL_FILE_WHATSAPP` | (non d&eacute;fini) | Remplacement de personnalit&eacute; par canal pour WhatsApp |
| `READ_ONLY_MODE` | `false` | Bloque toutes les op&eacute;rations d'&eacute;criture |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, ou `debug` |

### Routage et Consensus

| Variable | D&eacute;faut | Description |
|----------|--------|-------------|
| `ROUTING_PRESET` | `balanced` | Pr&eacute;r&eacute;glage de routage : `budget`, `balanced` ou `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | Active la commutation de phase PAOR entre fournisseurs |
| `CONSENSUS_MODE` | `auto` | Mode consensus : `auto`, `critical-only`, `always` ou `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | Seuil de confiance pour d&eacute;clencher le consensus |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Nombre maximum de fournisseurs &agrave; consulter pour le consensus |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | Budget journalier (USD) pour le mode daemon |

### Limitation de D&eacute;bit

| Variable | D&eacute;faut | Description |
|----------|--------|-------------|
| `RATE_LIMIT_ENABLED` | `false` | Active la limitation de d&eacute;bit |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | Limite de messages par utilisateur par minute (0 = illimit&eacute;) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | Limite horaire par utilisateur |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | Quota journalier global de tokens |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | Plafond de d&eacute;penses journalier en USD |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | Plafond de d&eacute;penses mensuel en USD |

### S&eacute;curit&eacute;

| Variable | D&eacute;faut | Description |
|----------|--------|-------------|
| `REQUIRE_MFA` | `false` | Exige l'authentification multi-facteurs |
| `BROWSER_HEADLESS` | `true` | Ex&eacute;cute l'automatisation du navigateur en mode headless |
| `BROWSER_MAX_CONCURRENT` | `5` | Nombre maximal de sessions de navigateur simultan&eacute;es |

---

## Outils

L'agent dispose de plus de 40 outils int&eacute;gr&eacute;s organis&eacute;s par cat&eacute;gorie :

### Op&eacute;rations sur les Fichiers
| Outil | Description |
|-------|-------------|
| `file_read` | Lit les fichiers avec num&eacute;ros de ligne, pagination offset/limit (limite 512 Ko) |
| `file_write` | Cr&eacute;e ou &eacute;crase les fichiers (limite 256 Ko, cr&eacute;ation automatique des r&eacute;pertoires) |
| `file_edit` | &Eacute;dition par recherche-remplacement avec v&eacute;rification d'unicit&eacute; |
| `file_delete` | Supprime un fichier unique |
| `file_rename` | Renomme ou d&eacute;place des fichiers au sein du projet |
| `file_delete_directory` | Suppression r&eacute;cursive de r&eacute;pertoire (limite de s&eacute;curit&eacute; de 50 fichiers) |

### Recherche
| Outil | Description |
|-------|-------------|
| `glob_search` | Recherche de fichiers par motif glob (max 50 r&eacute;sultats) |
| `grep_search` | Recherche de contenu par regex dans les fichiers (max 20 correspondances) |
| `list_directory` | Listage de r&eacute;pertoire avec tailles de fichiers |
| `code_search` | Recherche s&eacute;mantique/vectorielle via RAG -- requ&ecirc;tes en langage naturel |
| `memory_search` | Recherche dans la m&eacute;moire persistante visible des conversations |

### G&eacute;n&eacute;ration de Code Strada
| Outil | Description |
|-------|-------------|
| `strada_analyze_project` | Scan complet du projet C# -- modules, syst&egrave;mes, composants, services |
| `strada_create_module` | G&eacute;n&egrave;re un &eacute;chafaudage de module complet (`.asmdef`, config, r&eacute;pertoires) |
| `strada_create_component` | G&eacute;n&egrave;re des structs de composants ECS avec d&eacute;finitions de champs |
| `strada_create_mediator` | G&eacute;n&egrave;re un `EntityMediator<TView>` avec liaisons de composants |
| `strada_create_system` | G&eacute;n&egrave;re des squelettes `SystemBase`/`JobSystemBase`/`BurstSystem` |

### Git
| Outil | Description |
|-------|-------------|
| `git_status` | Statut de l'arbre de travail |
| `git_diff` | Afficher les modifications |
| `git_log` | Historique des commits |
| `git_commit` | Indexer et committer |
| `git_push` | Pousser vers le d&eacute;p&ocirc;t distant |
| `git_branch` | Lister, cr&eacute;er ou basculer de branche |
| `git_stash` | Push, pop, list ou drop du stash |

### .NET / Unity
| Outil | Description |
|-------|-------------|
| `dotnet_build` | Lance `dotnet build`, analyse les erreurs MSBuild en sortie structur&eacute;e |
| `dotnet_test` | Lance `dotnet test`, analyse les r&eacute;sultats pass/fail/skip |

### Interaction Agent
| Outil | Description |
|-------|-------------|
| `ask_user` | N'est pas un outil d'action normal pour le worker; il ne devient visible que lorsque `clarification-review` confirme qu'il est vraiment n&eacute;cessaire |
| `show_plan` | N'est pas un outil d'action normal pour le worker; il n'est montr&eacute; comme tour de revue du plan que si l'utilisateur a explicitement demand&eacute; &agrave; voir le plan d'abord |
| `switch_personality` | Change la personnalit&eacute; de l'agent &agrave; l'ex&eacute;cution (casual/formal/minimal/default) |

### Autres
| Outil | Description |
|-------|-------------|
| `shell_exec` | Ex&eacute;cute des commandes shell (timeout 30s, liste de blocage de commandes dangereuses) |
| `code_quality` | Analyse de qualit&eacute; de code par fichier ou par projet |
| `rag_index` | D&eacute;clenche la r&eacute;-indexation incr&eacute;mentale ou compl&egrave;te du projet |

---

## Commandes Chat

Commandes slash disponibles dans tous les canaux de chat :

| Commande | Description |
|----------|-------------|
| `/daemon` | Afficher le statut du daemon |
| `/daemon start` | D&eacute;marrer la boucle de battement de coeur du daemon |
| `/daemon stop` | Arr&ecirc;ter la boucle de battement de coeur du daemon |
| `/daemon triggers` | Afficher les d&eacute;clencheurs actifs |
| `/agent` | Afficher le statut de l'Agent Core |
| `/routing` | Afficher le statut du routage et le pr&eacute;r&eacute;glage |
| `/routing preset <name>` | Changer le pr&eacute;r&eacute;glage de routage (budget/balanced/performance) |
| `/routing info` | Afficher les d&eacute;cisions de routage r&eacute;centes, les traces d'ex&eacute;cution r&eacute;elles, les phase outcomes, les adaptive phase scores et la t&eacute;l&eacute;m&eacute;trie identity-scoped de runtime self-improvement pour le projet actif, avec verifier clean rate, rollback pressure, retry count, token-cost telemetry, provider catalog freshness, official alignment / capability drift et artifact promotion telemetry |

---

## Pipeline RAG

Le pipeline RAG (Retrieval-Augmented Generation) indexe votre code source C# pour la recherche s&eacute;mantique.

**Flux d'indexation :**
1. Scanne les fichiers `**/*.cs` dans votre projet Unity
2. D&eacute;coupe le code de mani&egrave;re structurelle -- en-t&ecirc;tes de fichiers, classes, m&eacute;thodes, constructeurs
3. G&eacute;n&egrave;re les embeddings via le fournisseur configur&eacute; -- OpenAI (`text-embedding-3-small`), Gemini (`gemini-embedding-2-preview` avec dimensions Matryoshka 128-3072), Mistral, Ollama ou autres. D&eacute;finir `EMBEDDING_DIMENSIONS` pour contr&ocirc;ler la taille de sortie
4. Stocke les vecteurs dans un index HNSW pour une recherche rapide par plus proches voisins approximatifs
5. S'ex&eacute;cute automatiquement au d&eacute;marrage (en arri&egrave;re-plan, non bloquant)

**Flux de recherche :**
1. La requ&ecirc;te est convertie en embedding par le m&ecirc;me fournisseur
2. La recherche HNSW retourne `topK * 3` candidats
3. Le reclasseur attribue un score : similarit&eacute; vectorielle (60%) + chevauchement de mots-cl&eacute;s (25%) + bonus structurel (15%)
4. Les 6 meilleurs r&eacute;sultats (au-dessus du score 0.2) sont inject&eacute;s dans le contexte du LLM

**Note :** Le pipeline RAG ne supporte actuellement que les fichiers C#. Le d&eacute;coupeur est sp&eacute;cifique au C#.

---

## Capacit&eacute;s des Canaux

| Capacit&eacute; | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|----------|-----|----------|---------|-------|----------|-----|
| Messagerie texte | Oui | Oui | Oui | Oui | Oui | Oui |
| Pi&egrave;ces jointes m&eacute;dias | Oui (base64) | Oui (photo/doc/vid&eacute;o/voix) | Oui (toute pi&egrave;ce jointe) | Oui (t&eacute;l&eacute;chargement de fichier) | Oui (image/vid&eacute;o/audio/doc) | Non |
| Vision (image→LLM) | Oui | Oui | Oui | Oui | Oui | Non |
| Streaming (&eacute;dition en place) | Oui | Oui | Oui | Oui | Oui | Oui |
| Indicateur de saisie | Oui | Oui | Oui | No-op | Oui | Non |
| Dialogues de confirmation | Oui (modal) | Oui (clavier inline) | Oui (boutons) | Oui (Block Kit) | Oui (r&eacute;ponse num&eacute;rot&eacute;e) | Oui (readline) |
| Support des fils | Non | Non | Oui | Oui | Non | Non |
| Limiteur de d&eacute;bit (sortant) | Oui (par session) | Non | Oui (token bucket) | Oui (fen&ecirc;tre glissante 4 niveaux) | Limitation en ligne | Non |

### Streaming

Tous les canaux impl&eacute;mentent le streaming par &eacute;dition en place. La r&eacute;ponse de l'agent appara&icirc;t progressivement au fur et &agrave; mesure que le LLM la g&eacute;n&egrave;re. Les mises &agrave; jour sont limit&eacute;es par plateforme pour &eacute;viter les limites de d&eacute;bit (WhatsApp/Discord : 1/s, Slack : 2/s).

### Authentification

- **Telegram** : Refus par d&eacute;faut. Vous devez d&eacute;finir `ALLOWED_TELEGRAM_USER_IDS`.
- **Discord** : Refus par d&eacute;faut. Vous devez d&eacute;finir `ALLOWED_DISCORD_USER_IDS` ou `ALLOWED_DISCORD_ROLE_IDS`.
- **Slack** : **Ouvert par d&eacute;faut.** Si `ALLOWED_SLACK_USER_IDS` est vide, tout utilisateur Slack peut acc&eacute;der au bot. D&eacute;finissez la liste d'autorisation pour la production.
- **WhatsApp** : Ouvert par d&eacute;faut. Si `WHATSAPP_ALLOWED_NUMBERS` est d&eacute;fini, l'adaptateur limite les messages entrants &agrave; cette liste d'autorisation.

---

## S&eacute;curit&eacute;

### Couche 1 : Authentification des Canaux
Listes d'autorisation sp&eacute;cifiques &agrave; chaque plateforme, v&eacute;rifi&eacute;es &agrave; l'arriv&eacute;e du message (avant tout traitement).

### Couche 2 : Limitation de D&eacute;bit
Fen&ecirc;tre glissante par utilisateur (minute/heure) + plafonds globaux quotidiens/mensuels en tokens et en USD.

### Couche 3 : Gardien de Chemin
Chaque op&eacute;ration sur les fichiers r&eacute;sout les liens symboliques et valide que le chemin reste dans la racine du projet. Plus de 30 motifs sensibles sont bloqu&eacute;s (`.env`, `.git/credentials`, cl&eacute;s SSH, certificats, `node_modules/`).

### Couche 4 : S&eacute;curit&eacute; des M&eacute;dias
Toutes les pi&egrave;ces jointes m&eacute;dias sont valid&eacute;es avant traitement : liste d'autorisation MIME, limites de taille par type (20 Mo image, 50 Mo vid&eacute;o, 25 Mo audio, 10 Mo document), v&eacute;rification des octets magiques et protection SSRF sur les URLs de t&eacute;l&eacute;chargement.

### Couche 5 : Assainisseur de Secrets
24 motifs regex d&eacute;tectent et masquent les identifiants dans toutes les sorties d'outils avant qu'elles n'atteignent le LLM. Couvre : cl&eacute;s OpenAI, tokens GitHub, tokens Slack/Discord/Telegram, cl&eacute;s AWS, JWT, authentification Bearer, cl&eacute;s PEM, URLs de bases de donn&eacute;es et motifs g&eacute;n&eacute;riques de secrets.

### Couche 6 : Mode Lecture Seule
Quand `READ_ONLY_MODE=true`, 23 outils d'&eacute;criture sont enti&egrave;rement retir&eacute;s de la liste d'outils de l'agent -- le LLM ne peut m&ecirc;me pas tenter de les appeler.

### Couche 7 : Confirmation des Op&eacute;rations
Les op&eacute;rations d'&eacute;criture (&eacute;criture de fichiers, commits Git, ex&eacute;cution shell) peuvent n&eacute;cessiter une confirmation de l'utilisateur via l'interface interactive du canal (boutons, claviers inline, invites texte).

### Couche 8 : Assainissement des Sorties d'Outils
Toutes les sorties d'outils sont limit&eacute;es &agrave; 8192 caract&egrave;res et nettoy&eacute;es des motifs de cl&eacute;s API avant d'&ecirc;tre renvoy&eacute;es au LLM.

### Couche 9 : RBAC (Interne)
5 r&ocirc;les (superadmin, admin, developer, viewer, service) avec une matrice de permissions couvrant 9 types de ressources. Le moteur de politiques supporte des conditions bas&eacute;es sur le temps, l'IP et des conditions personnalis&eacute;es.

### Couche 10 : S&eacute;curit&eacute; du Daemon
`DaemonSecurityPolicy` impose des exigences d'approbation au niveau des outils pour les op&eacute;rations d&eacute;clench&eacute;es par le daemon. Les outils d'&eacute;criture n&eacute;cessitent l'approbation explicite de l'utilisateur via l'`ApprovalQueue` avant ex&eacute;cution.

---

## Tableau de Bord et Surveillance

### Tableau de Bord HTTP (`DASHBOARD_ENABLED=true`)
Accessible &agrave; `http://localhost:3100` (localhost uniquement). Affiche : disponibilit&eacute;, nombre de messages, utilisation des tokens, sessions actives, tableau d'utilisation des outils, statistiques de s&eacute;curit&eacute;. Rafra&icirc;chissement automatique toutes les 3 secondes.

### Endpoints de Sant&eacute;
- `GET /health` -- Sonde de vivacit&eacute; (`{"status":"ok"}`)
- `GET /ready` -- V&eacute;rification approfondie de disponibilit&eacute; : v&eacute;rifie la m&eacute;moire et la sant&eacute; des canaux. Retourne 200 (pr&ecirc;t), 207 (d&eacute;grad&eacute;), ou 503 (non pr&ecirc;t)

### Prometheus (`ENABLE_PROMETHEUS=true`)
M&eacute;triques &agrave; `http://localhost:9090/metrics`. Compteurs pour les messages, appels d'outils, tokens. Histogrammes pour la dur&eacute;e des requ&ecirc;tes, dur&eacute;e des outils, latence LLM. M&eacute;triques Node.js par d&eacute;faut (CPU, heap, GC, boucle d'&eacute;v&eacute;nements).

### Tableau de Bord WebSocket (`ENABLE_WEBSOCKET_DASHBOARD=true`)
M&eacute;triques en temps r&eacute;el pouss&eacute;es chaque seconde. Supporte les connexions authentifi&eacute;es, la surveillance par heartbeat ainsi que les handlers de commandes/notifications enregistr&eacute;s par l'application. Si `WEBSOCKET_DASHBOARD_AUTH_TOKEN` est d&eacute;fini, utilisez ce bearer token ; sinon, le tableau de bord same-origin inject&eacute; bootstrappe automatiquement un token li&eacute; au processus.

### Syst&egrave;me de M&eacute;triques
`MetricsStorage` (SQLite) enregistre le taux de compl&eacute;tion des t&acirc;ches, le nombre d'it&eacute;rations, l'utilisation des outils et la r&eacute;utilisation des motifs. `MetricsRecorder` capture les m&eacute;triques par session. La commande CLI `metrics` affiche les m&eacute;triques historiques.

---

## D&eacute;ploiement

### Docker

```bash
docker-compose up -d
```

Le fichier `docker-compose.yml` inclut l'application, la stack de surveillance et le reverse proxy nginx.

### Mode Daemon

```bash
# Fonctionnement autonome 24/7 avec boucle de battement de coeur et d&eacute;clencheurs proactifs
node dist/index.js daemon --channel web

# Red&eacute;marrage automatique en cas de crash avec backoff exponentiel (1s &agrave; 60s, jusqu'&agrave; 10 red&eacute;marrages)
node dist/index.js daemon --channel telegram
```

### Checklist de Production

- [ ] D&eacute;finir `NODE_ENV=production`
- [ ] D&eacute;finir `LOG_LEVEL=warn` ou `error`
- [ ] Configurer `RATE_LIMIT_ENABLED=true` avec des plafonds de budget
- [ ] D&eacute;finir les listes d'autorisation des canaux (surtout Slack -- ouvert par d&eacute;faut)
- [ ] D&eacute;finir `READ_ONLY_MODE=true` si vous ne souhaitez qu'une exploration s&eacute;curis&eacute;e
- [ ] Activer `DASHBOARD_ENABLED=true` pour la surveillance
- [ ] Activer `ENABLE_PROMETHEUS=true` pour la collecte de m&eacute;triques
- [ ] G&eacute;n&eacute;rer un `JWT_SECRET` robuste
- [ ] Configurer les limites de budget du daemon (`RATE_LIMIT_DAILY_BUDGET_USD`)

---

## Tests

```bash
npm test                         # Suite complete par defaut (batch pour la stabilite)
npm run test:watch               # Mode watch
npm test -- --coverage           # Avec couverture
npm test -- src/agents/tools/file-read.test.ts  # Fichier unique / passage cible
npm test -- src/dashboard/prometheus.test.ts    # Suite ciblee via le runner par defaut
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Valider la derive de l'API Strada.Core
npm run test:file-build-flow     # Flux local d'integration .NET en opt-in
npm run test:unity-fixture       # Flux local Unity compile/test en opt-in
npm run test:hnsw-perf           # Suite opt-in de benchmark / recall HNSW
npm run typecheck                # V&eacute;rification de types TypeScript
npm run lint                     # ESLint
```

Notes :
- `npm test` utilise un runner Vitest par lots avec des workers `fork` pour eviter l'ancien chemin OOM de la suite complete.
- Les tests dashboard qui dependent du bind socket sont ignores par defaut ; utilisez `LOCAL_SERVER_TESTS=1` pour une verification locale reelle.
- `sync:check` valide la connaissance Strada.Core de Strada.Brain face a un checkout reel ; la CI l'impose avec `--max-drift-score 0`.
- `test:file-build-flow`, `test:unity-fixture` et `test:hnsw-perf` restent volontairement opt-in car ils demandent des outils de build locaux, un editeur Unity licencie ou des charges de benchmark lourdes.
- `test:unity-fixture` peut encore echouer si l'environnement local Unity batchmode / licence est instable, meme lorsque le code genere est correct.

---

## Structure du Projet

```
src/
  index.ts              # Point d'entr&eacute;e CLI (Commander.js)
  core/
    bootstrap.ts        # S&eacute;quence compl&egrave;te d'initialisation -- tout le c&acirc;blage se fait ici
    event-bus.ts        # TypedEventBus pour la communication &eacute;v&eacute;nementielle d&eacute;coupl&eacute;e
    tool-registry.ts    # Instanciation et enregistrement des outils
  agents/
    orchestrator.ts     # Boucle d'agent PAOR, gestion de sessions, streaming
    agent-state.ts      # Machine &agrave; &eacute;tats de phase (Planifier/Agir/Observer/R&eacute;fl&eacute;chir)
    paor-prompts.ts     # Constructeurs de prompts sensibles aux phases
    instinct-retriever.ts # R&eacute;cup&eacute;ration proactive de motifs appris
    failure-classifier.ts # Cat&eacute;gorisation des erreurs et d&eacute;clencheurs de replanification automatique
    autonomy/           # R&eacute;cup&eacute;ration d'erreurs, planification de t&acirc;ches, auto-v&eacute;rification
    context/            # Prompt syst&egrave;me (base de connaissances Strada.Core)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + autres
    tools/              # 30+ impl&eacute;mentations d'outils (ask_user, show_plan, switch_personality, ...)
    soul/               # Chargeur de personnalit&eacute; SOUL.md avec rechargement &agrave; chaud et remplacements par canal
    plugins/            # Chargeur de plugins externes
  profiles/             # Fichiers de profils de personnalit&eacute; : casual.md, formal.md, minimal.md
  channels/
    telegram/           # Bot bas&eacute; sur Grammy
    discord/            # Bot discord.js avec commandes slash
    slack/              # Slack Bolt (mode socket) avec Block Kit
    whatsapp/           # Client bas&eacute; sur Baileys avec gestion de sessions
    web/                # Canal web Express + WebSocket
    cli/                # REPL Readline
  web-portal/           # Interface de chat React + Vite (th&egrave;me sombre/clair, upload de fichiers, streaming, onglet tableau de bord, panneau lat&eacute;ral)
  memory/
    file-memory-manager.ts   # Backend historique : JSON + TF-IDF (repli)
    unified/
      agentdb-memory.ts      # Backend actif : SQLite + HNSW, placement automatique &agrave; 3 niveaux
      agentdb-adapter.ts     # Adaptateur IMemoryManager pour AgentDBMemory
      migration.ts           # Migration FileMemoryManager historique -> AgentDB
      consolidation-engine.ts # Consolidation de m&eacute;moire en p&eacute;riode d'inactivit&eacute; avec clustering HNSW
      consolidation-types.ts  # D&eacute;finitions de types et interfaces de consolidation
    decay/                    # Syst&egrave;me de d&eacute;gradation exponentielle de la m&eacute;moire
  rag/
    rag-pipeline.ts     # Orchestration indexation + recherche + formatage
    chunker.ts          # D&eacute;coupage structurel sp&eacute;cifique au C#
    hnsw/               # Stockage vectoriel HNSW (hnswlib-node)
    embeddings/         # Fournisseurs d'embeddings OpenAI et Ollama
    reranker.ts         # Reclassement pond&eacute;r&eacute; (vectoriel + mots-cl&eacute;s + structurel)
  learning/
    pipeline/
      learning-pipeline.ts  # D&eacute;tection de motifs, cr&eacute;ation d'instincts, propositions d'&eacute;volution
      learning-queue.ts     # Processeur asynchrone s&eacute;riel pour l'apprentissage &eacute;v&eacute;nementiel
      embedding-queue.ts    # G&eacute;n&eacute;ration d'embeddings asynchrone born&eacute;e
    scoring/
      confidence-scorer.ts  # Confiance hybride pond&eacute;r&eacute;e (5 facteurs), Elo, intervalles de Wilson
    matching/
      pattern-matcher.ts    # Correspondance de motifs par mots-cl&eacute;s + s&eacute;mantique
    hooks/
      error-learning-hooks.ts  # Hooks de capture erreur/r&eacute;solution
    storage/
      learning-storage.ts  # Stockage SQLite pour instincts, trajectoires, motifs
      migrations/          # Migrations de sch&eacute;ma (provenance inter-sessions)
    chains/
      chain-detector.ts    # D&eacute;tection de s&eacute;quences d'outils r&eacute;currentes
      chain-synthesizer.ts # G&eacute;n&eacute;ration d'outils composites par LLM
      composite-tool.ts    # Outil composite ex&eacute;cutable
      chain-validator.ts   # Validation post-synth&egrave;se, retour d'information &agrave; l'ex&eacute;cution
      chain-manager.ts     # Orchestrateur du cycle de vie complet
  multi-agent/
    agent-manager.ts    # Cycle de vie multi-agent et isolation des sessions
    agent-budget-tracker.ts  # Suivi budg&eacute;taire par agent
    agent-registry.ts   # Registre central des agents actifs
  delegation/
    delegation-manager.ts    # Gestion du cycle de vie de la d&eacute;l&eacute;gation
    delegation-tool.ts       # Outil de d&eacute;l&eacute;gation c&ocirc;t&eacute; agent
    tier-router.ts           # Routage de t&acirc;ches &agrave; 4 niveaux
  goals/
    goal-decomposer.ts  # D&eacute;composition d'objectifs en DAG (proactive + r&eacute;active)
    goal-executor.ts    # Ex&eacute;cution parall&egrave;le par vagues avec budgets d'&eacute;checs
    goal-validator.ts   # D&eacute;tection de cycles DAG par algorithme de Kahn
    goal-storage.ts     # Persistance SQLite des arbres d'objectifs
    goal-progress.ts    # Suivi et rapports de progression
    goal-resume.ts      # Reprise des arbres d'objectifs interrompus apr&egrave;s red&eacute;marrage
    goal-renderer.ts    # Visualisation de l'arbre d'objectifs
  daemon/
    heartbeat-loop.ts   # Boucle principale tick-&eacute;valuation-d&eacute;clenchement
    trigger-registry.ts # Enregistrement et cycle de vie des d&eacute;clencheurs
    daemon-storage.ts   # Persistance SQLite de l'&eacute;tat du daemon
    daemon-events.ts    # D&eacute;finitions d'&eacute;v&eacute;nements typ&eacute;s du sous-syst&egrave;me daemon
    daemon-cli.ts       # Commandes CLI de gestion du daemon
    budget/
      budget-tracker.ts # Suivi du budget journalier en USD
    resilience/
      circuit-breaker.ts # Disjoncteur par d&eacute;clencheur avec backoff exponentiel
    security/
      daemon-security-policy.ts  # Exigences d'approbation pour le daemon
      approval-queue.ts          # File d'approbation avec expiration
    dedup/
      trigger-deduplicator.ts    # D&eacute;duplication par contenu + p&eacute;riode de refroidissement
    triggers/
      cron-trigger.ts        # Planification par expression cron
      file-watch-trigger.ts  # Surveillance des modifications du syst&egrave;me de fichiers
      checklist-trigger.ts   # &Eacute;l&eacute;ments de checklist &agrave; &eacute;ch&eacute;ance
      webhook-trigger.ts     # Endpoint webhook HTTP POST
      deploy-trigger.ts      # D&eacute;clencheur de d&eacute;ploiement avec porte d'approbation
    deployment/
      deployment-executor.ts # Ex&eacute;cution de d&eacute;ploiement avec rollback
      readiness-checker.ts   # Validation de pr&eacute;paration avant d&eacute;ploiement
    reporting/
      notification-router.ts # Routage des notifications par urgence
      digest-reporter.ts     # G&eacute;n&eacute;ration de synth&egrave;ses p&eacute;riodiques
      digest-formatter.ts    # Formatage des rapports pour les canaux
      quiet-hours.ts         # Mise en tampon des notifications non critiques
  identity/
    identity-state.ts   # Identit&eacute; persistante de l'agent (UUID, nombre de d&eacute;marrages, temps de fonctionnement)
    crash-recovery.ts   # D&eacute;tection de crash et contexte de r&eacute;cup&eacute;ration
  tasks/
    task-manager.ts     # Gestion du cycle de vie des t&acirc;ches
    task-storage.ts     # Persistance SQLite des t&acirc;ches
    background-executor.ts # Ex&eacute;cution de t&acirc;ches en arri&egrave;re-plan avec int&eacute;gration des objectifs
    message-router.ts   # Routage des messages vers l'orchestrateur
    command-detector.ts # D&eacute;tection des commandes slash
    command-handler.ts  # Ex&eacute;cution des commandes
  metrics/
    metrics-storage.ts  # Stockage SQLite des m&eacute;triques
    metrics-recorder.ts # Capture de m&eacute;triques par session
    metrics-cli.ts      # Commande CLI d'affichage des m&eacute;triques
  utils/
    media-processor.ts  # T&eacute;l&eacute;chargement de m&eacute;dias, validation (MIME/taille/octets magiques), protection SSRF
  security/             # Auth, RBAC, gardien de chemin, limiteur de d&eacute;bit, assainisseur de secrets
  intelligence/         # Analyse C#, analyse de projet, qualit&eacute; de code
  dashboard/            # Tableaux de bord HTTP, WebSocket, Prometheus
  config/               # Configuration d'environnement valid&eacute;e par Zod
  validation/           # Sch&eacute;mas de validation d'entr&eacute;e
```

---

## Contribuer

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour la configuration du d&eacute;veloppement, les conventions de code et les directives pour les PR.

---

## Licence

Licence MIT - voir [LICENSE](LICENSE) pour les d&eacute;tails.
