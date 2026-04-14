# Codebase Memory Vault (Phase 1 + Phase 2)

> Persistente, projektspezifische Codebasis-Erinnerung fuer Strada.Brain. Ersetzt das wiederholte Einlesen derselben Dateien pro Anfrage durch eine hybride (BM25 + Vektor) und symbolische (PPR ueber Call-/Import-Graph) Suche. Versteht sowohl Unity-Projekte als auch Strada.Brains eigenen Quellcode (SelfVault).
>
> English version: [docs/vault.md](vault.md)

---

## 1. Ueberblick

Der **Codebase Memory Vault** ist eine persistente Gedaechtnisschicht, die Strada.Brain pro Projekt einen vorindexierten, durchsuchbaren Blick auf die gesamte Codebasis gibt. Statt bei jeder Benutzeranfrage erneut Dateien zu oeffnen und in den Kontext zu laden, baut der Vault einmalig einen Index auf (SQLite + Vektorstore) und beantwortet Anfragen anschliessend mit fusionierten BM25- und Vektor-Ergebnissen, optional neu gerankt durch Personalized PageRank ueber den Symbolgraphen.

**Warum das wichtig ist:**

- **Massive Token-Einsparungen** — der Agent liest Dateien nicht mehr spekulativ, sondern ruft gezielte, token-budgetierte Chunks ab.
- **Schnellere Antworten** — lokale SQLite + HNSW, kein Netzwerk-Roundtrip pro Retrieval.
- **Bessere Code-Navigation** — der Symbolgraph liefert Callers/Callees, nicht nur Volltext-Treffer.
- **Selbstbewusstsein** — via **SelfVault** kennt Strada.Brain seinen eigenen Quellcode und kann sich selbst besser erweitern und debuggen.
- **Unity-nativ** — `UnityProjectVault` versteht die typische Struktur (`Assets/`, `Packages/`, `ProjectSettings/`).

Der Vault ist als optionales Subsystem konzipiert (`config.vault.enabled: false` standardmaessig) und aktiviert sich ausschliesslich, wenn das Flag gesetzt oder die Env-Variable `STRADA_VAULT_ENABLED=true` exportiert wird.

---

## 2. Schnellstart

```bash
# 1. Aktivieren per Env-Variable
export STRADA_VAULT_ENABLED=true

# 2. Strada.Brain starten
npm start

# 3. Im Chat: einen Unity-Projekt-Vault anlegen und synchronisieren
/vault init /path/to/unity/project
/vault sync
/vault status
```

Nach `/vault sync` liegt der Index unter `<project>/.strada/vault/index.db` (SQLite, WAL-Modus) und der Symbolgraph unter `<project>/.strada/vault/graph.canvas` (JSON Canvas 1.0). Der Vault nimmt danach automatisch Dateiaenderungen via Watcher auf; manuelle Neu-Synchronisation ist nur bei groesseren Umbauten noetig.

**SelfVault** (Strada.Brains eigener Quellcode) wird bei aktivem Vault automatisch mitindexiert, sofern `config.vault.self.enabled` auf `true` steht (Default).

---

## 3. Architektur-Ueberblick

Der Vault ist in drei logische Ebenen gegliedert:

| Ebene | Inhalt | Tabelle(n) / Store | Zweck |
|-------|--------|--------------------|-------|
| **L1** | Datei-Metadaten | `vault_files` | Pfad, xxhash64-Content-Hash, mtime, Sprache, Kind |
| **L2** | Symbolgraph | `vault_symbols`, `vault_edges`, `vault_wikilinks` | Funktionen/Klassen, Call-/Import-Kanten, Markdown-Wikilinks |
| **L3** | Hybride Chunks | `vault_chunks`, `vault_chunks_fts`, `vault_embeddings` | BM25 (FTS5) + HNSW-Vektoren fuer semantische Suche |

**Retrieval-Pipeline** (`VaultRegistry.query(...)`):

1. Pro Vault: BM25-Recall (FTS5) und Vektor-Recall (HNSW) parallel.
2. **Reciprocal Rank Fusion** (k = 60) verbindet beide Rangfolgen zu einer fusionierten Liste.
3. Optionale Filter (`langFilter`, `pathGlob`) schraenken das Ergebnis ein.
4. Wenn `VaultQuery.focusFiles` gesetzt ist: **Personalized PageRank** ueber den Symbolgraph re-ranked die Top-N.
5. `packByBudget(chunks, tokenBudget)` packt greedy bis zum angeforderten Token-Budget.
6. Vault-uebergreifend: sortiert nach fusioniertem RRF-Score, gekappt auf `topK`.

**Schluessel-Komponenten im Quellcode** (`src/vault/`):

- `vault.interface.ts` — `IVault`-Kontrakt, den alle Vaults erfuellen.
- `unity-project-vault.ts` — indexiert `<unity-project>/` nach `<unity-project>/.strada/vault/`.
- `self-vault.ts` — indexiert den Strada.Brain-Repo-Root.
- `vault-registry.ts` — Singleton-Lookup, fan-out `query()` ueber alle Vaults.
- `ppr.ts` — Personalized PageRank mit normalisiertem Damping.
- `symbol-extractor/` — Tree-sitter WASM-Extraktoren fuer TypeScript, C# und Markdown-Wikilinks.

---

## 4. Phase 1 — Hybride Suche

Phase 1 liefert die Datei- und Chunk-Ebene sowie die kombinierte BM25-/Vektor-Suche.

### 4.1 Storage-Layout

Pro Vault wird eine eigene SQLite-Datenbank angelegt:

```
<project>/.strada/vault/
├── index.db               # SQLite (better-sqlite3, WAL + FK, immer per-Vault)
├── codebase/              # Generierte Markdown-Projektion (optional)
└── hnsw/                  # Externer HNSW-Store fuer Embeddings
```

**Tabellen** (`schema.sql`):

- `vault_files` — `(path, blobHash, mtime, size, lang, kind)` mit xxhash64-Content-Hash.
- `vault_chunks` — `(chunkId, path FK, startLine, endLine, content, tokens)`. `chunkId` ist eine verkuerzte SHA-256 des Inhalts.
- `vault_chunks_fts` — FTS5-Virtual-Table, BM25-Scoring.
- `vault_embeddings` — Zeiger in den externen HNSW-Store.
- `vault_meta` — Schluessel/Wert-Tabelle fuer Migrationen (`indexer_version`, Phase-Tag etc.).

### 4.2 Update-Pfade

Drei Wege halten den Index aktuell. Alle drei respektieren den xxhash64-Short-Circuit: unveraenderte Dateien werden **nie** neu embeddet.

| Pfad | Ausloeser | Debounce / Budget | Zweck |
|------|-----------|-------------------|-------|
| **chokidar-Watcher** | Externe FS-Aenderungen | 800 ms (Default) | Benutzer schreibt in der IDE |
| **Write-Hook** | Strada.Brains eigene Tool-Writes | 200 ms Sync-Budget | Agent schreibt waehrend einer Task |
| **Manual Sync** | `/vault sync` | n/a | On-Demand-Full-Reindex |

### 4.3 Token-Budget-Packing

`packByBudget(chunks, tokenBudget)` ist ein greedy First-Fit-Algorithmus, der die hoechstbewerteten Chunks einpackt, bis das Budget erschoepft ist. Dadurch kann der Agent sagen: _"Gib mir die relevantesten 2000 Tokens zu `DamageSystem`"_ — und bekommt keine einzige Zeile mehr.

### 4.4 Chat-Tools

Beim Bootstrap registriert die Vault-Initialisierung drei Tools in der Agent-Tool-Registry:

- `vault_init` — Neuen Vault fuer einen Pfad anlegen.
- `vault_sync` — Full-Reindex erzwingen.
- `vault_status` — Zaehler, letzter Sync, Watcher-Zustand.

### 4.5 Portal

Die Admin-Seite `/admin/vaults` im Web-Portal bietet:

- **Vault-Liste** — alle registrierten Vaults mit Status.
- **Files-Tab** — Dateibaum-Explorer mit Markdown-/Raw-Preview.
- **Search-Tab** — interaktive Hybrid-Query-UI mit Rank-Scores.

HTTP-Oberflaeche unter `/api/vaults/*`. Das WS-Event `vault:update` broadcastet Dirty-Set-Batches in Echtzeit.

---

## 5. Phase 2 — Symbolgraph, PPR, SelfVault, Graph UI

Phase 2 baut auf Phase 1 auf und fuegt eine deterministische Symbolschicht (L2) sowie eine graphbasierte Re-Ranking-Strategie hinzu.

### 5.1 Neue Tabellen

```
vault_symbols   — (id, path, lang, qname, kind, startLine, endLine)
vault_edges     — (fromId, toId, kind)   — call, import, extends, reference
vault_wikilinks — (fromPath, target)     — Markdown [[Link]]-Kanten
vault_meta.indexer_version = 'phase2.v1'
```

### 5.2 Symbol-ID-Format

Jedes Symbol hat eine stabile, sprachuebergreifende ID:

```
<lang>::<relPath>::<qualifiedName>
```

Beispiele:

- `csharp::Assets/Scripts/Player.cs::Game.Player.Move`
- `typescript::src/foo.ts::Foo.bar`

Unresolved externs (z. B. Calls auf externe Libraries) verwenden:

```
<lang>::unresolved::<label>
```

### 5.3 Tree-sitter Extraktoren

`src/vault/symbol-extractor/` enthaelt WASM-basierte Tree-sitter-Extraktoren fuer:

- **TypeScript / TSX** — Funktionen, Klassen, Methoden, Imports.
- **C#** — Klassen, Methoden, Namespaces, Using-Direktiven.
- **Markdown** — `[[Wikilinks]]` (Regex-basiert).

Jeder Extraktor verwendet einen **frischen Parser-Instance pro Aufruf** (Security-Hardening, siehe Abschnitt 9) und hat eine **2 MB-Obergrenze** pro Datei, um Tree-sitter vor pathologischen Eingaben zu schuetzen.

### 5.4 JSON Canvas Export

Nach jedem Cold-Start, nach `/vault sync` und nach dem Leerlaufen des Watcher-Draining wird `<project>/.strada/vault/graph.canvas` atomar neu geschrieben. Das Format ist **JSON Canvas 1.0**, das direkt im Portal gerendert und z. B. auch in Obsidian geladen werden kann.

### 5.5 Personalized PageRank

`src/vault/ppr.ts` implementiert Personalized PageRank ueber den `vault_edges`-Graphen. Sobald `VaultQuery.focusFiles` gesetzt ist, werden die Top-Kandidaten aus Schritt 2 der Pipeline mit dem PPR-Score neu gewichtet — Symbole nahe an den Fokus-Dateien (im Call-/Import-Graph) steigen auf. Der Damping-Faktor ist normalisiert, um Bias durch variable Out-Degrees zu vermeiden.

Ohne `focusFiles` bleibt der RRF-only-Pfad aktiv — keine PPR-Kosten, wenn der Aufrufer keinen Fokus angibt.

### 5.6 SelfVault

`src/vault/self-vault.ts` indexiert Strada.Brain selbst:

- `src/`, `web-portal/src/`, `tests/`, `docs/`
- `AGENTS.md`, `CLAUDE.md`

Der SelfVault **ueberspringt Symlinks** (Symlink-Traversal-Schutz) und respektiert dasselbe xxhash64-Short-Circuit-Verhalten. Dadurch kann der Agent semantische Fragen ueber seinen eigenen Quellcode beantworten ("Wo wird `InstinctRetriever` verwendet?") ohne den kompletten Repo-Baum zu lesen.

Optional via `config.vault.self.enabled = false` deaktivierbar.

### 5.7 Neue HTTP-Endpoints

| Methode | Pfad | Zweck |
|---------|------|-------|
| `GET` | `/api/vaults/:id/canvas` | Serviert `graph.canvas` (JSON Canvas 1.0) |
| `GET` | `/api/vaults/:id/symbols/by-name?q=X` | Findet Symbole nach Kurznamen |
| `GET` | `/api/vaults/:id/symbols/:symbolId/callers` | Listet eingehende Call-Edges |

### 5.8 Graph-Tab im Portal

`/admin/vaults` bekommt einen **Graph-Tab**, der den Canvas via `@xyflow/react` + `@dagrejs/dagre` rendert — **ohne** neue Frontend-Abhaengigkeiten (beide sind bereits im Portal verfuegbar). Hierarchisches Dagre-Layout, klickbare Knoten, die direkt in den Files-Tab springen.

---

## 6. Konfigurationsreferenz

Alle Vault-Optionen liegen unter `config.vault` (siehe `src/config/config.ts`):

| Schluessel | Typ | Default | Beschreibung |
|------------|-----|---------|-------------|
| `enabled` | `boolean` | `false` | Master-Schalter. Env: `STRADA_VAULT_ENABLED` |
| `writeHookBudgetMs` | `number` | `200` | Max. synchroner Write-Hook-Budget in ms. Env: `STRADA_VAULT_WRITE_HOOK_BUDGET_MS` |
| `debounceMs` | `number` | `800` | chokidar-Debounce in ms. Env: `STRADA_VAULT_DEBOUNCE_MS` |
| `embeddingFallback` | `'none' \| 'local'` | `'local'` | Lokaler Embedding-Fallback, wenn der Provider fehlschlaegt |
| `self.enabled` | `boolean` | `true` | SelfVault einschliessen |

### Env-Beispiel

```env
STRADA_VAULT_ENABLED=true
STRADA_VAULT_WRITE_HOOK_BUDGET_MS=200
STRADA_VAULT_DEBOUNCE_MS=800
```

---

## 7. HTTP-API-Referenz

Alle Endpoints sind unter `/api/vaults/` gebunden. Der Server bindet nur auf `127.0.0.1` (wie der Rest des Web-Kanals).

| Methode | Pfad | Zweck |
|---------|------|-------|
| `GET` | `/api/vaults` | Liste aller registrierten Vaults |
| `GET` | `/api/vaults/:id/files` | Dateibaum mit Metadaten |
| `GET` | `/api/vaults/:id/files/*` | Einzeldatei (raw oder Markdown-Projektion) |
| `POST` | `/api/vaults/:id/query` | Hybrid-Query (`text`, `topK`, `tokenBudget`, `focusFiles?`) |
| `POST` | `/api/vaults/:id/sync` | Full-Reindex ausloesen |
| `GET` | `/api/vaults/:id/status` | Zaehler, letzter Sync, Watcher-State |
| `GET` | `/api/vaults/:id/canvas` | JSON Canvas 1.0 Export |
| `GET` | `/api/vaults/:id/symbols/by-name?q=X` | Symbole nach Kurznamen |
| `GET` | `/api/vaults/:id/symbols/:symbolId/callers` | Eingehende Call-Edges |

**WebSocket-Event:**

```json
{ "type": "vault:update", "vaultId": "...", "dirty": ["path/a.ts", "path/b.cs"] }
```

### Request-Size-Cap

Der Request-Body ist auf einen sicheren Deckel begrenzt (DoS-Schutz, siehe Abschnitt 9). Uebergrosse Payloads werden mit `413 Payload Too Large` abgelehnt.

---

## 8. Portal-UI-Leitfaden

Die Admin-Seite `/admin/vaults` besteht aus drei Tabs:

### 8.1 Files-Tab

- Dateibaum-Explorer auf der linken Seite, Filterung nach Sprache und Pfad-Glob.
- Preview rechts: Raw-Ansicht oder die generierte Markdown-Projektion unter `.strada/vault/codebase/`.
- Metadaten-Zeile: letzter Hash, mtime, Token-Count, Chunk-Anzahl.

### 8.2 Search-Tab

- Text-Eingabe, Optionen fuer `langFilter`, `pathGlob`, `topK`, `tokenBudget`.
- Ergebnisliste zeigt: Chunk-Titel, Rank-Score (RRF), Einzel-Scores (BM25, Vektor), PPR-Score wenn `focusFiles` gesetzt.
- Klick auf einen Treffer springt in den Files-Tab zur entsprechenden Datei.

### 8.3 Graph-Tab

- Rendering via `@xyflow/react` + `@dagrejs/dagre`-Layout.
- Knoten: Symbole; Kanten: `call`, `import`, `extends`, `reference`, `wikilink`.
- Klick auf Knoten -> Symbol-Details (callers, callees, Pfad).
- Wird aus dem JSON Canvas Endpoint gespeist und aktualisiert sich ueber das `vault:update`-WS-Event.

---

## 9. Sicherheit

Phase 2 enthaelt ein dediziertes Security-Hardening (Commit `5563d48`):

- **Atomic Canvas-Writes** — `graph.canvas` wird in eine Temp-Datei geschrieben und anschliessend `rename()`-ed, um teilweise geschriebene Dateien bei Crashes zu vermeiden.
- **Symlink-Skip** — Beide Vaults ueberspringen Symlinks beim Indexieren, um Directory-Traversal ausserhalb des Projekt-Roots zu verhindern.
- **Fresh Parser per Call** — Tree-sitter Parser werden pro Extraktionslauf neu instanziiert; keine geteilten, korruptionsanfaelligen Parser-States.
- **Request-Body-DoS-Cap** — `/api/vaults/:id/query` hat einen harten Body-Size-Cap.
- **Orphaned-Edge-GC** — Kanten, deren Quell- oder Zielsymbol geloescht wurde, werden beim Sync aus `vault_edges` entfernt.
- **Normalized PPR Damping** — PPR-Damping ist normalisiert, um Bias durch stark variierende Out-Degrees zu vermeiden.
- **2 MB Symbol-Extraction-Cap** — Dateien groesser als 2 MB werden uebersprungen, um Tree-sitter-Pathologien zu vermeiden.
- **Edge-Cache-Invalidation** — Der PPR-Edge-Cache wird beim Neuaufbau des Graphen korrekt invalidiert.
- **Bounded `findCallers`** — die Callers-Suche terminiert spaetestens nach einer festen Tiefe/Anzahl, um pathologische Graphen zu begrenzen.

Kombiniert mit der bestehenden Sicherheitshaltung (`127.0.0.1`-Bind, JWT-geschuetzte Admin-APIs, Pfad-Sanitizing) ist der Vault auch in autonomen Daemon-Szenarien sicher einsetzbar.

---

## 10. Roadmap — Phase 3

Die kommende Phase 3 plant:

- **Haiku-basierte Rolling Summaries** — pro-Datei-Zusammenfassungen, die sich mit jeder Aenderung inkrementell aktualisieren, um Long-Tail-Retrieval zu verbessern.
- **FrameworkVault-Upgrade** — semantische Suche ueber Framework-Doku + Docstring-Extraktion, sodass Strada.Core-Wissen als eigenstaendiger Vault verfuegbar wird.
- **Bidirektionale Learning-Kopplung** — Vault-Hits fliessen in die Lernpipeline, Instinkte reichern Chunks um "confidence"-Signale an.

---

## 11. Links

- Englische Originalversion: [docs/vault.md](vault.md)
- Quellcode: `src/vault/` (Interface, Unity-Vault, SelfVault, Registry, PPR, Symbol-Extractors)
- Schema: `src/vault/schema.sql`
- Portal-UI: `web-portal/src/pages/VaultsPage.tsx`
- Config: `src/config/config.ts` (Abschnitt `vault`)
- Related: [Speichersystem](../README.de.md#speichersystem), [Lernsystem](../README.de.md#lernsystem), [Architektur](../README.de.md#architektur)
