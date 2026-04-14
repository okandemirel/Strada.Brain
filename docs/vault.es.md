# Codebase Memory Vault (Fase 1 + Fase 2)

> Nota de traduccion: La fuente canonica de comportamiento en runtime es [docs/vault.md](vault.md). Este archivo es una traduccion conceptual al espanol.

Memoria de codebase persistente y por proyecto que reemplaza la relectura de archivos en cada solicitud con busqueda hibrida (BM25 + vectorial) y simbolica (Personalized PageRank sobre el grafo de llamadas/imports). Entiende proyectos Unity y el propio codigo fuente de Strada.Brain a traves de SelfVault. Grandes ahorros de tokens por cada consulta.

---

## 1. Descripcion general

Cada vez que el agente necesita contexto de codigo, el flujo ingenuo es releer archivos bajo demanda, lo cual es lento, inconsistente y caro en tokens. El **Codebase Memory Vault** indexa tu proyecto una sola vez, lo mantiene sincronizado de forma incremental y sirve resultados relevantes y ajustados a presupuesto de tokens en cuestion de milisegundos.

Caracteristicas clave:

- **Memoria por proyecto persistida en SQLite** (`<proyecto>/.strada/vault/index.db`) con BM25 (FTS5) + vectores HNSW fusionados por Reciprocal Rank Fusion (RRF).
- **Grafo de simbolos deterministico** construido con extractores Tree-sitter WASM para TypeScript y C#, mas extractores regex de wikilinks para Markdown.
- **Personalized PageRank (PPR)** para re-rankeo cuando la consulta tiene archivos de foco.
- **SelfVault**: el agente tambien se indexa a si mismo (`src/`, `web-portal/src/`, `tests/`, `docs/`, `AGENTS.md`, `CLAUDE.md`), habilitando introspeccion y auto-mejora.
- **Tres caminos de actualizacion**: watcher chokidar (debounce 800 ms), write-hook (presupuesto 200 ms para las escrituras del propio agente) y `/vault sync` manual.
- **UI del portal** con pestanas Files, Search y Graph — esta ultima renderiza el grafo via `@xyflow/react` + `@dagrejs/dagre`.

Por que importa: eliminamos la lectura redundante de archivos en cada turno, ahorrando tokens de manera dramatica y dando al agente una vision mucho mas consistente del codebase.

---

## 2. Inicio rapido

```bash
# 1. Activa el subsistema (desactivado por defecto)
export STRADA_VAULT_ENABLED=true

# 2. Arranca Strada.Brain normalmente
npm start

# 3. En el chat, inicializa el vault del proyecto Unity
/vault init /ruta/a/tu/proyecto/unity

# 4. Fuerza una sincronizacion completa si ya hay cambios pendientes
/vault sync

# 5. Consulta el estado del vault
/vault status
```

Tras el `init`, el watcher chokidar empieza a monitorizar cambios en disco y el write-hook intercepta las escrituras del propio agente. La mayoria de las actualizaciones son incrementales y casi inmediatas.

SelfVault se habilita automaticamente si `config.vault.self.enabled = true` y Strada.Brain se ejecuta desde un source checkout.

---

## 3. Vision general de la arquitectura

La memoria del vault se organiza en tres niveles complementarios:

| Nivel | Contenido | Implementacion |
|---|---|---|
| **L1** | Metadatos de archivo (ruta, hash xxhash64, mtime, tamano, lenguaje, tipo) | Tabla `vault_files` |
| **L2** | Grafo de simbolos: simbolos, aristas de llamada/import, wikilinks | Tablas `vault_symbols`, `vault_edges`, `vault_wikilinks` + `graph.canvas` |
| **L3** | Chunks hibridos: texto + embeddings + BM25 | Tablas `vault_chunks`, `vault_chunks_fts`, `vault_embeddings` |

Flujo de consulta (`VaultRegistry.query({ text })`):

1. **Recuperacion por vault**: BM25 (FTS5) + vectores (HNSW)
2. **Reciprocal Rank Fusion** (k = 60) fusiona ambos ranking
3. **PPR opcional** re-rankea si `VaultQuery.focusFiles` esta presente
4. Filtros opcionales `langFilter` / `pathGlob`
5. `packByBudget` empaqueta chunks hasta el presupuesto de tokens solicitado
6. **Cross-vault**: ordena por RRF, limita a `topK`

El contrato `IVault` (`src/vault/vault.interface.ts`) define la interfaz, implementada por `UnityProjectVault` y `SelfVault`. `VaultRegistry` expone un unico punto de consulta fan-out.

---

## 4. Fase 1 — Recuperacion hibrida

La Fase 1 sento las bases L3 y la infraestructura de persistencia/indexado.

### Almacenamiento

SQLite por vault (better-sqlite3, WAL + foreign_keys):

- `vault_files` — ruta, xxhash64 blob hash, mtime, tamano, lang, kind
- `vault_chunks` — chunkId (sha256 truncado), FK a path, rango de lineas, contenido, conteo de tokens
- `vault_chunks_fts` — tabla virtual FTS5, puntuada con BM25
- `vault_embeddings` — puntero al almacen HNSW externo
- `vault_meta` — key/value para migraciones

### Recuperacion

- **BM25** via FTS5 nativo de SQLite
- **Vectorial** via HNSW externo
- **Fusion**: Reciprocal Rank Fusion con `k = 60`
- **Packing**: `packByBudget` hace packing greedy hasta llenar el presupuesto de tokens

### Actualizaciones (hibridas)

- **chokidar watcher** con debounce de 800 ms para cambios en disco del usuario
- **Write-hook** (`installWriteHook`, presupuesto 200 ms) para escrituras propias de las herramientas de Strada.Brain
- **`/vault sync`** para reindexado completo manual

Los tres caminos respetan el short-circuit por hash xxhash64 de `reindexFile` — los archivos sin cambios nunca se re-embeden.

### Herramientas expuestas al agente

- `vault_init` — registra un proyecto como vault
- `vault_sync` — fuerza reindex completo
- `vault_status` — stats y salud del vault

---

## 5. Fase 2 — Grafo de simbolos + PPR + SelfVault + Graph UI

La Fase 2 anade una capa L2 deterministica de simbolos sobre la busqueda hibrida L3.

### Novedades de esquema

- Nuevas tablas: `vault_symbols`, `vault_edges`, `vault_wikilinks`
- `vault_meta.indexer_version = 'phase2.v1'`

### Extractores Tree-sitter WASM

Bajo `src/vault/symbol-extractor/`:

- **TypeScript** — funciones, clases, metodos, imports
- **C#** — clases, metodos, MonoBehaviours, namespaces
- **Markdown** — wikilinks `[[Simbolo]]` via regex

### Formato de Symbol ID

`<lang>::<relPath>::<qualifiedName>`

Ejemplos:

- `csharp::Assets/Scripts/Player.cs::Game.Player.Move`
- `typescript::src/foo.ts::Foo.bar`

Simbolos externos no resueltos: `<lang>::unresolved::<label>`.

### `graph.canvas`

Formato JSON Canvas 1.0 (`<proyecto>/.strada/vault/graph.canvas`). Se regenera en:

- Cold start
- `/vault sync`
- Drain del watcher

### Personalized PageRank

`src/vault/ppr.ts`. Cuando `VaultQuery.focusFiles` esta presente, el PPR sobre el grafo de aristas re-rankea los candidatos sobre los RRF scores. Si `focusFiles` se omite, el camino solo-RRF se preserva tal cual.

El damping del PPR esta normalizado, con cota superior, y las aristas huerfanas se recolectan por GC.

### SelfVault

`src/vault/self-vault.ts` indexa el propio codigo fuente de Strada.Brain. Incluye:

- `src/`, `web-portal/src/`, `tests/`, `docs/`
- `AGENTS.md`, `CLAUDE.md`

Los symlinks se omiten por seguridad (evita loops infinitos y escapes fuera del proyecto).

### Portal — pestana Graph

`/admin/vaults` gana una pestana **Graph** que renderiza `graph.canvas` via `@xyflow/react` + `@dagrejs/dagre`. Sin nuevas dependencias npm adicionales mas alla de esas dos.

---

## 6. Referencia de configuracion

Definida en `src/config/config.ts` bajo la clave `vault`:

| Opcion | Por defecto | Descripcion |
|---|---|---|
| `enabled` | `false` | Activa el subsistema de vault. Tambien via env `STRADA_VAULT_ENABLED=true`. |
| `writeHookBudgetMs` | `200` | Presupuesto (ms) para que el write-hook sincronice antes de ceder. |
| `debounceMs` | `800` | Debounce del watcher chokidar. |
| `embeddingFallback` | `'local'` | `'none' \| 'local'`. Fallback si el proveedor de embeddings externo no esta disponible. |
| `self.enabled` | `true` | Activa SelfVault (solo aplica si el vault general tambien esta activo). |

Variables de entorno correspondientes:

- `STRADA_VAULT_ENABLED`
- `STRADA_VAULT_WRITE_HOOK_BUDGET_MS`
- `STRADA_VAULT_DEBOUNCE_MS`

---

## 7. Referencia de API HTTP

Todos los endpoints estan bajo `/api/vaults/`.

### Fase 1

| Metodo | Ruta | Proposito |
|---|---|---|
| GET | `/api/vaults` | Lista vaults registrados |
| GET | `/api/vaults/:id` | Metadatos + stats de un vault |
| GET | `/api/vaults/:id/files` | Listado de archivos indexados (arbol) |
| GET | `/api/vaults/:id/file?path=...` | Contenido raw + markdown derivado |
| POST | `/api/vaults/:id/search` | Busqueda hibrida BM25 + vectorial |
| POST | `/api/vaults/:id/sync` | Fuerza reindex completo |

### Fase 2

| Metodo | Ruta | Proposito |
|---|---|---|
| GET | `/api/vaults/:id/canvas` | Sirve `graph.canvas` (JSON Canvas 1.0) |
| GET | `/api/vaults/:id/symbols/by-name?q=X` | Busca simbolos por nombre corto |
| GET | `/api/vaults/:id/symbols/:symbolId/callers` | Lista aristas de llamada entrantes |

### Eventos WebSocket

- `vault:update` — broadcast de batches dirty-set cuando el watcher drena cambios

---

## 8. Guia de UI del portal

La pagina `/admin/vaults` (`web-portal/src/pages/VaultsPage.tsx`) tiene tres pestanas.

### Pestana Files

- Arbol del proyecto navegable
- Preview en dos modos: markdown derivado (bajo `<proyecto>/.strada/vault/codebase/`) y raw
- Indicadores de frescura (ultimo sync, hash actual)

### Pestana Search

- Query box con soporte de busqueda hibrida
- Filtros opcionales: `langFilter`, `pathGlob`
- Campo opcional `focusFiles` para activar re-ranking PPR
- Slider de presupuesto de tokens — el packing se aplica client-side para preview

### Pestana Graph (Fase 2)

- Visualizacion interactiva de `graph.canvas`
- Layout con `dagre` (LR por defecto, togglable)
- Click en un nodo para expandir callers/callees
- Filtrado por lenguaje y por profundidad de aristas

Todos los datos fluyen por `/api/vaults/*` y el canal `vault:update` mantiene la UI en sincronia.

---

## 9. Seguridad

El endurecimiento de seguridad de Fase 2 (commit `5563d48`) cubre multiples vectores de ataque:

- **Escrituras atomicas del canvas** — `graph.canvas` se escribe a un archivo temporal y despues se renombra, evitando lecturas de estado corrupto.
- **Skip de symlinks** — SelfVault y UnityProjectVault omiten symlinks para evitar loops infinitos y escapes del proyecto.
- **Parser Tree-sitter fresco por llamada** — evita compartir estado entre extracciones, eliminando una clase de memory leaks y race conditions.
- **Cap del body de request HTTP** — protege contra DoS via payloads gigantes.
- **GC de aristas huerfanas** — el grafo se mantiene consistente tras borrados de archivos.
- **Damping del PPR normalizado** — evita overflow/underflow numerico y estabiliza el ranking.
- **Cap de 2 MB en extraccion de simbolos** — archivos gigantes no bloquean el indexer.
- **Invalidacion de cache de aristas** — asegura que cambios en el grafo se propaguen a la UI en el proximo tick.
- **`findCallers` con cota superior** — evita traversals que nunca terminan sobre ciclos patologicos.

Buenas practicas operativas:

- El vault vive dentro de `<proyecto>/.strada/vault/` — anadelo a `.gitignore` del proyecto si no quieres versionarlo.
- `STRADA_VAULT_ENABLED=false` desactiva todo el subsistema sin rastro.
- SelfVault se puede desactivar especificamente via `config.vault.self.enabled = false`.

---

## 10. Hoja de ruta — Fase 3

Planeado para la Fase 3:

- **Resumenes rolling con Haiku** — compresion continua de chunks cold con Claude Haiku para reducir todavia mas el consumo de tokens
- **Upgrade de FrameworkVault** — busqueda semantica y extraccion de docstrings sobre la documentacion del framework Strada.Core
- **Acoplamiento bidireccional con el Learning pipeline** — los instintos aprendidos alimentan el ranking del vault, y las lecturas del vault alimentan la deteccion de patrones del sistema de aprendizaje

---

## 11. Enlaces

- Codigo fuente: [`src/vault/`](../src/vault/)
- Version canonica en ingles: [`docs/vault.md`](vault.md)
- PR original: [#11](https://github.com/okandemirel/Strada.Brain/pull/11) (v4.2.69, 2026-04-14)
- Esquema SQL: [`src/vault/schema.sql`](../src/vault/schema.sql)
- UI del portal: [`web-portal/src/pages/VaultsPage.tsx`](../web-portal/src/pages/VaultsPage.tsx)
