# Codebase Memory Vault

Mémoire de code persistante, par projet, pour Strada.Brain. Le vault remplace la relecture des fichiers à chaque requête par une récupération hybride (BM25 + vecteurs) et symbolique (Personalized PageRank sur un graphe d'appels / imports), afin que l'agent puisse répondre à des questions sur un projet Unity — ou sur sa propre source — sans réinjecter l'arborescence complète à chaque tour.

> Note de traduction : la version anglaise canonique est [`docs/vault.md`](./vault.md). Ce fichier en est une traduction.

---

## 1. Vue d'ensemble

### Le problème

À chaque tour, l'agent a tendance à relire des fichiers déjà vus :

- Les fenêtres de contexte se remplissent de source dupliquée.
- Les budgets de tokens sont consommés par des I/O fichier répétitives.
- Le raisonnement cross-fichier (qui appelle `Player.Move` ? quels systèmes touchent `HealthComponent` ?) exige de nouveaux greps.

### La solution

Un index par projet adossé à SQLite (`<project>/.strada/vault/index.db`) qui :

1. Découpe et indexe la source (BM25 FTS5 + embeddings vectoriels HNSW).
2. Extrait symboles et arêtes d'appels / imports vers un graphe.
3. Sert une récupération classée, respectant un budget de tokens, via un pipeline hybride.
4. Se met à jour seul via un watcher chokidar, un write-hook, ou la commande manuelle `/vault sync`.
5. Indexe automatiquement la source de Strada.Brain lui-même via le **SelfVault**, pour que l'agent puisse introspecter son propre code.

Le vault est opt-in (`config.vault.enabled = false` par défaut). Une fois activé, il démarre avec l'agent et expose des outils, des APIs HTTP et une page de portail.

---

## 2. Démarrage rapide

```bash
# Activer le sous-système
export STRADA_VAULT_ENABLED=true

# Démarrer Strada.Brain
npm start
```

Dans n'importe quel canal :

```
/vault init /chemin/vers/projet/unity
/vault sync
/vault status
```

Le SelfVault (indexation de la source de Strada.Brain) démarre automatiquement au boot quand `vault.enabled=true`. Désactivez-le avec `config.vault.self.enabled=false`.

Le portail expose les mêmes fonctionnalités sur [`/admin/vaults`](http://localhost:3000/admin/vaults) : onglets Files / Search / Graph.

---

## 3. Aperçu de l'architecture

Le vault se compose de trois couches conceptuelles :

| Couche | Contenu | Source |
|---|---|---|
| **L1 — Métadonnées de fichier** | Chemin, hash de contenu (xxhash64), mtime, taille, langue, nature | `discovery.ts`, `reindexFile` |
| **L2 — Graphe de symboles** | Symboles, arêtes d'appels / imports, wikilinks markdown | Extracteurs Tree-sitter WASM dans `src/vault/symbol-extractor/` |
| **L3 — Chunks hybrides** | Texte chunké + FTS5 BM25 + embeddings vectoriels HNSW | `chunker.ts`, fournisseur d'embeddings |

Transversal :

- **PPR (Personalized PageRank)** sur L2 re-classe les résultats de L3 quand `VaultQuery.focusFiles` est défini.
- **graph.canvas** (JSON Canvas 1.0) est un artefact dérivé écrit dans `<project>/.strada/vault/graph.canvas`, reconstruit au démarrage à froid, lors d'un `/vault sync`, et à la purge du watcher.

---

## 4. Phase 1 — Recherche hybride

### Stockage

Un SQLite par vault (`better-sqlite3`, WAL + `foreign_keys=ON`) :

| Table | Rôle |
|---|---|
| `vault_files` | Chemin, hash blob xxhash64, mtime, taille, langue, nature |
| `vault_chunks` | chunkId (sha256 tronqué), path FK, plage de lignes, contenu, nombre de tokens |
| `vault_chunks_fts` | Table virtuelle FTS5, classée par BM25 |
| `vault_embeddings` | Pointeur vers le store vectoriel HNSW externe |
| `vault_meta` | Paires clé/valeur ; contient `indexer_version`, marqueurs de migration |

### Chunking

Chunking conscient du langage via `chunker.ts` ; détection de la nature du fichier (source / test / config / markdown) via `discovery.ts`. Les fichiers inchangés sont court-circuités par xxhash64 — pas de re-embedding.

### Chemins de mise à jour

Trois chemins maintiennent l'index à jour :

| Chemin | Déclencheur | Budget |
|---|---|---|
| Watcher chokidar | Changements FS utilisateur | Debounce 800 ms (défaut) |
| Write-hook | Écritures d'outils de Strada.Brain | Budget sync de 200 ms |
| Outil `/vault sync` | Manuel, réindexation complète | Aucun budget |

Les trois honorent le court-circuit par hash de `reindexFile`.

### Pipeline de requête

`VaultRegistry.query({ text })` :

1. Par vault : rappel BM25 (FTS5) + vectoriel (HNSW).
2. **Reciprocal Rank Fusion** (k = 60) fusionne les deux listes classées.
3. `langFilter` / `pathGlob` optionnels restreignent les résultats.
4. Si `focusFiles` est défini, **Personalized PageRank** sur le graphe de symboles re-classe.
5. `packByBudget` emballe gourmandement les chunks jusqu'au budget de tokens demandé.
6. Entre vaults : tri par score fusionné, plafonné à `topK`.

### Outils

Trois outils s'enregistrent dans le registre d'outils de l'agent au boot (`initVaultsFromBootstrap` dans `stage-knowledge.ts`) :

| Outil | Rôle |
|---|---|
| `vault_init` | Attache un chemin de projet et construit son vault |
| `vault_sync` | Réindexation complète d'un vault existant |
| `vault_status` | Rapporte santé du vault, nombre de fichiers, nombre de symboles, dernière synchro |

---

## 5. Phase 2 — Graphe de symboles, PPR, SelfVault, Graph UI

La Phase 2 ajoute une couche L2 de symboles déterministe au-dessus de la recherche hybride L3 de la Phase 1.

### Nouvelles tables

Ajoutées dans `schema.sql` ; `vault_meta.indexer_version = 'phase2.v1'`.

| Table | Rôle |
|---|---|
| `vault_symbols` | Fonctions, classes, méthodes, champs avec informations de localisation |
| `vault_edges` | Arêtes d'appel / import / référence entre symboles |
| `vault_wikilinks` | Références markdown `[[wikilink]]` |

### Extracteurs

Extracteurs Tree-sitter WASM, un par langage, dans `src/vault/symbol-extractor/` :

- TypeScript
- C#
- Markdown (extracteur regex de wikilinks)

Une nouvelle instance `Parser` est créée à chaque appel pour garantir la sécurité en concurrence. L'extraction par fichier est plafonnée à 2 Mo.

### Identifiants de symboles

```
<lang>::<relPath>::<qualifiedName>
```

Exemples :

```
csharp::Assets/Scripts/Player.cs::Game.Player.Move
typescript::src/foo.ts::Foo.bar
```

Les externes non résolus (références dont la cible n'est pas dans le vault) utilisent :

```
<lang>::unresolved::<label>
```

### graph.canvas

Un artefact JSON Canvas 1.0 dans `<project>/.strada/vault/graph.canvas`, régénéré à :

- Démarrage à froid
- `/vault sync`
- Purge du watcher

Les écritures sont atomiques (fichier temporaire + rename).

### Personalized PageRank

`src/vault/ppr.ts` s'exécute quand `VaultQuery.focusFiles` est défini, re-classant les résultats hybrides via le graphe d'arêtes. La formule de damping est normalisée pour que la distribution stationnaire somme à 1. Quand `focusFiles` est omis, le chemin RRF seul est préservé.

### SelfVault

`src/vault/self-vault.ts` indexe automatiquement la source de Strada.Brain. Il couvre :

- `src/`
- `web-portal/src/`
- `tests/`
- `docs/`
- `AGENTS.md`
- `CLAUDE.md`

Les liens symboliques sont ignorés pendant la découverte (empêche toute évasion de répertoire).

### Onglet Graph

La page de portail `/admin/vaults` gagne un onglet **Graph** qui rend `graph.canvas` via `@xyflow/react` + `@dagrejs/dagre`. Aucune nouvelle dépendance frontend.

---

## 6. Référence de configuration

Tous les flags vivent sous `config.vault` (`src/config/config.ts`).

| Flag | Défaut | Variable d'env | Description |
|---|---|---|---|
| `enabled` | `false` | `STRADA_VAULT_ENABLED` | Interrupteur principal du sous-système vault |
| `writeHookBudgetMs` | `200` | `STRADA_VAULT_WRITE_HOOK_BUDGET_MS` | Ms max. pendant lesquelles le write-hook peut bloquer les écritures d'outils |
| `debounceMs` | `800` | `STRADA_VAULT_DEBOUNCE_MS` | Debounce chokidar pour les rafales de changements FS |
| `embeddingFallback` | `'local'` | — | `'none'` désactive le fallback ; `'local'` utilise un embedder local si le fournisseur renvoie `null` |
| `self.enabled` | `true` | — | Mettre à `false` pour désactiver le SelfVault |

---

## 7. Référence de l'API HTTP

Tous les endpoints vivent sous `/api/vaults/*` et requièrent l'authentification du dashboard.

### `GET /api/vaults`

Liste les vaults.

```json
[
  {
    "id": "unity-project",
    "kind": "unity-project",
    "rootPath": "/chemin/absolu/vers/unity",
    "fileCount": 1243,
    "symbolCount": 9128,
    "lastSyncAt": "2026-04-14T14:02:11.000Z"
  }
]
```

### `POST /api/vaults/:id/search`

Recherche hybride. Corps de la requête plafonné par `maxBytes` pour la protection DoS.

Requête :

```json
{
  "text": "calcul des dégâts",
  "topK": 20,
  "tokenBudget": 4000,
  "langFilter": "csharp",
  "pathGlob": "Assets/**",
  "focusFiles": ["Assets/Scripts/Player.cs"]
}
```

Réponse :

```json
{
  "results": [
    {
      "chunkId": "...",
      "path": "Assets/Scripts/DamageSystem.cs",
      "range": [12, 48],
      "score": 0.82,
      "content": "..."
    }
  ]
}
```

### `GET /api/vaults/:id/files/*`

Parcourt l'arborescence et retourne le contenu markdown / brut par fichier (utilisé par l'onglet Files).

### `GET /api/vaults/:id/canvas`

Sert `graph.canvas` (JSON Canvas 1.0).

### `GET /api/vaults/:id/symbols/by-name?q=<shortName>`

Recherche des symboles par nom court.

```json
[
  {
    "symbolId": "csharp::Assets/Scripts/Player.cs::Game.Player.Move",
    "kind": "method",
    "path": "Assets/Scripts/Player.cs",
    "range": [42, 58]
  }
]
```

### `GET /api/vaults/:id/symbols/:symbolId/callers`

Liste les arêtes d'appel entrantes (ensemble de résultats borné).

```json
{
  "symbolId": "csharp::Assets/Scripts/Player.cs::Game.Player.Move",
  "callers": [
    {
      "symbolId": "csharp::Assets/Scripts/InputHandler.cs::Game.InputHandler.Update",
      "path": "Assets/Scripts/InputHandler.cs",
      "line": 27
    }
  ]
}
```

### Événements WebSocket

- `vault:update` — diffuse les lots de dirty-set aux clients portail connectés.

---

## 8. Guide de l'UI du portail

La page `/admin/vaults` (`web-portal/src/pages/VaultsPage.tsx`) a trois onglets :

### Files

- Arborescence de fichiers chargée à la demande depuis la racine du vault.
- Prévisualisation par fichier : markdown rendu pour `.md`, source brute sinon.
- Les fichiers touchés par l'agent sont mis en évidence.

### Search

- Champ de requête + contrôles topK / budget de tokens.
- Filtre de langue et glob de chemin optionnels.
- Les résultats affichent score, chemin, plage de lignes et contenu du chunk.

### Graph

- Rend `graph.canvas` via `@xyflow/react` + `@dagrejs/dagre`.
- Nœuds : symboles, groupés par fichier.
- Arêtes : appels, imports, wikilinks.
- Cliquez sur un nœud pour ouvrir le symbole dans l'onglet Files.

---

## 9. Sécurité

Durcissement appliqué pendant la revue de la Phase 2 (commit `5563d48`) :

- **Écritures atomiques du canvas** — fichier temporaire + rename ; pas de lecture de fichier partiel.
- **Saut des liens symboliques** dans la découverte du SelfVault — empêche l'évasion de répertoire via des symlinks pointant hors du dépôt.
- **Nouveau `Parser` Tree-sitter à chaque appel** — sécurité en concurrence ; aucun état partagé de parser.
- **Plafond `maxBytes` du corps de requête** sur l'endpoint de recherche — protection DoS.
- **GC des arêtes orphelines** — les arêtes référençant des fichiers supprimés sont retirées à la réindexation.
- **Normalisation du damping PPR** — la distribution stationnaire somme à 1 (pas de dérive ni de biais).
- **Plafond de 2 Mo pour l'extraction de symboles par fichier** — borne mémoire / CPU par parse.
- **Invalidation du cache d'arêtes à chaque `reindexFile`** — empêche tout état de graphe obsolète.
- **Résultats bornés pour `findCallers`** — pas de parcours de graphe non borné.

La sécurité standard de Strada.Brain s'applique : le vault respecte la sanitisation de chemin, vit sous `<project>/.strada/vault/`, et tous les accès portail / HTTP passent par la couche d'authentification du dashboard.

---

## 10. Feuille de route

### Phase 3 (planifiée)

- **Résumés déroulants Haiku** — un modèle à faible coût résume fichiers / modules au changement ; les résumés sont stockés dans `vault_meta` et injectés dans les prompts comme alternative moins chère au packing complet des chunks.
- **Montée en puissance du FrameworkVault** — étend l'abstraction vault à la documentation du framework Strada.Core avec recherche sémantique et extraction de docstrings.
- **Couplage bidirectionnel avec le pipeline Learning** — le graphe de symboles du vault alimente le système d'apprentissage (provenance de patterns liée aux symboles) ; les artefacts d'apprentissage (`skill`, `workflow`, `knowledge_patch`) pointent vers les symboles qui les ont fait émerger.

---

## 11. Liens

- **Source** : [`src/vault/`](../src/vault/)
  - Interface : `src/vault/vault.interface.ts`
  - Vault Unity : `src/vault/unity-project-vault.ts`
  - Self vault : `src/vault/self-vault.ts`
  - Registre : `src/vault/vault-registry.ts`
  - PPR : `src/vault/ppr.ts`
  - Extracteurs de symboles : `src/vault/symbol-extractor/`
  - Chunking : `src/vault/chunker.ts`
  - Découverte : `src/vault/discovery.ts`
- **Spécification de conception** : [`docs/superpowers/specs/2026-04-13-codebase-memory-vault-design.md`](./superpowers/specs/2026-04-13-codebase-memory-vault-design.md)
- **Page du portail** : `web-portal/src/pages/VaultsPage.tsx`
- **Enregistrement d'outils** : `stage-knowledge.ts :: initVaultsFromBootstrap`
- **Version anglaise (canonique)** : [`docs/vault.md`](./vault.md)
