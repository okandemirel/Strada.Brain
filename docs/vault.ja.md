# Codebase Memory Vault（Phase 1 + Phase 2）

> 翻訳注記: 実装の正本は [docs/vault.md](vault.md)（英語版）です。本ドキュメントはその日本語訳であり、ランタイム挙動・環境変数の既定値・セキュリティ意味論の参照は常に英語版と [`src/vault/`](../src/vault/) を正としてください。

---

## 1. 概要

**Codebase Memory Vault** は、プロジェクト単位の永続的なコードベースメモリです。Strada.Brain は従来、タスクごとに必要なファイルを毎回読み直し、再チャンク・再 embedding していました。Vault はこの「毎回読み直す」モデルを **一度だけインデックスして、以降は hybrid + symbolic 検索で問い合わせる** モデルへ置き換えます。

### 解決する問題

- 毎リクエストでファイルを再読込するのはトークンコストが高く、レイテンシも大きい
- 単純な BM25 や vector 検索だけでは、呼び出し関係（「この関数を呼んでいるのは誰か」）や import グラフ上の近接性を捉えられない
- Unity プロジェクトと Strada.Brain 自身のソースコードを同じ抽象の下で扱いたい

### ソリューション

Vault は **3 層構造の codebase memory** として動作します。

- **L1 — File metadata**: パス、xxhash64 ハッシュ、mtime、言語、kind
- **L2 — Symbol graph**: シンボル定義、call/import/wikilink エッジ、Personalized PageRank による re-rank
- **L3 — Hybrid chunks**: BM25 (FTS5) + 密ベクトル (HNSW) を **Reciprocal Rank Fusion** で融合した chunk レベル検索

各 vault は `<project>/.strada/vault/index.db`（better-sqlite3、WAL + FK 有効）という SQLite に永続化され、**chokidar watcher + write-hook + 手動 `/vault sync`** の 3 経路で最新状態に保たれます。xxhash64 のコンテンツハッシュにより、変更のないファイルは short-circuit で再 embedding をスキップします。

### 何ができるか

- **UnityProjectVault**: 任意の Unity プロジェクトを index し、Strada.Brain に「このコードベースを知っている」状態を与える
- **SelfVault**: Strada.Brain 自身のソース（`src/`、`web-portal/src/`、`tests/`、`docs/`、`AGENTS.md`、`CLAUDE.md`）を自動 index し、agent が自己反省・自己修正する際の文脈を提供
- **Graph canvas**: JSON Canvas 1.0 形式の call/import グラフをポータル上で可視化
- **大幅なトークン節約**: 毎ターンのファイル再読込を置き換え、関連度の高い chunk だけをトークン予算に応じて pack

---

## 2. クイックスタート

```bash
# Vault サブシステムを有効化
export STRADA_VAULT_ENABLED=true

# Strada.Brain を起動
npm start
```

起動後、チャット経由で以下のスラッシュコマンドが使えます。

```
/vault init /path/to/unity/project
/vault sync
/vault status
```

- `/vault init` — 指定パスを新しい Unity vault として登録し、初回 index を実行
- `/vault sync` — 現在登録済みの全 vault を手動で再 index（watcher が止まっていても安全に最新化）
- `/vault status` — 各 vault のファイル数、chunk 数、embedding 状態、indexer version を表示

**SelfVault は `vault.enabled=true` のとき自動で bootstrap されます。** 明示的な init は不要で、Strada.Brain 自身のリポジトリを起動時にバックグラウンドで index 開始します。

---

## 3. アーキテクチャ概要

Vault は 3 つの layer を積み重ねた構造になっています。下の layer ほど粗粒度、上の layer ほど意味密度が高くなります。

```
+-------------------------------------------------------------+
| L3: Hybrid chunk search (BM25 + vector, RRF fused)          |
|     - vault_chunks, vault_chunks_fts, vault_embeddings       |
|     - packByBudget によるトークン予算配慮                     |
+-------------------------------------------------------------+
| L2: Symbol graph (Phase 2)                                   |
|     - vault_symbols, vault_edges, vault_wikilinks            |
|     - tree-sitter WASM 抽出 (TypeScript / C# / Markdown)     |
|     - Personalized PageRank による focus-aware re-rank       |
|     - graph.canvas (JSON Canvas 1.0) として永続化            |
+-------------------------------------------------------------+
| L1: File metadata                                            |
|     - vault_files: path, xxhash64 blob hash, mtime, lang    |
|     - 変更検知の short-circuit に使われる                     |
+-------------------------------------------------------------+
```

### クエリパイプライン

`VaultRegistry.query({ text, focusFiles?, langFilter?, pathGlob?, budget? })` は以下の手順で候補 chunk を返します。

1. **Per-vault recall** — BM25 (FTS5) と vector (HNSW) を並列で実行
2. **RRF 融合** — Reciprocal Rank Fusion（k = 60）で 2 つの ranked list をマージ
3. **PPR 再ランキング**（Phase 2 / `focusFiles` が指定されたときのみ） — edge graph 上で Personalized PageRank を計算し、focus files に近い chunk を優先
4. **フィルタ** — `langFilter`、`pathGlob` で候補を絞り込み
5. **予算 pack** — `packByBudget` が greedy にトークン予算内に収まるよう chunk を packing
6. **Cross-vault 集約** — 複数 vault の結果を RRF スコアでソートし、`topK` に cap

### 更新経路（hybrid update）

| 経路 | デバウンス | 用途 |
|------|------------|------|
| **chokidar watcher** | 800 ms | ユーザーによるファイルシステム変更（IDE 編集など） |
| **write-hook (`installWriteHook`)** | 同期予算 200 ms | Strada.Brain 自身の tool 書き込み（`file_write` 等） |
| **`/vault sync` tool** | なし（即時） | 手動のフル再 index |

3 つの経路はすべて `reindexFile` の **xxhash64 short-circuit** を共有します。ハッシュが変わっていないファイルは再 embedding されず、大規模プロジェクトでも実用的な更新コストに収まります。

---

## 4. Phase 1: ハイブリッド検索

Phase 1 は L1 + L3（file metadata と hybrid chunk search）を担当します。

### ストレージ

各 vault ごとに 1 つの SQLite ファイル（better-sqlite3、WAL モード、`foreign_keys = ON`）。

| テーブル | 役割 |
|---------|------|
| `vault_files` | path、xxhash64 blob hash、mtime、size、lang、kind |
| `vault_chunks` | chunkId（sha256 truncate）、path FK、line range、content、token count |
| `vault_chunks_fts` | FTS5 virtual table、BM25 スコアリング |
| `vault_embeddings` | 外部 HNSW store へのポインタ |
| `vault_meta` | key/value、将来の migration 用 |

### 検索融合

BM25 と vector 検索は独立に top-N 候補を返し、**Reciprocal Rank Fusion** で融合されます。

```
RRF_score(d) = Σ 1 / (k + rank_i(d))     // k = 60
```

この RRF 融合スコアが chunk の最終ランクとなり、`packByBudget` が LLM のコンテキスト予算に収まる範囲で貪欲に chunk を詰め込みます。

### Tools（agent tool registry 登録）

- `vault_init` — 新しい vault を登録し、初回 index を実行
- `vault_sync` — 既存 vault を再 index
- `vault_status` — 統計情報（files、chunks、embeddings、indexer version）を返す

bootstrap 統合は `stage-knowledge.ts` の `initVaultsFromBootstrap` ヘルパー経由で行われます。

### ポータル

`/admin/vaults` ページ（`web-portal/src/pages/VaultsPage.tsx`）に以下のタブが追加されています。

- **Files タブ** — vault に index 済みのファイルツリー、markdown / raw プレビュー
- **Search タブ** — hybrid クエリを UI から実行、ランク付き chunk を確認

HTTP surface は `/api/vaults/*`、WebSocket イベント `vault:update` は dirty-set のバッチを portal に push します。

---

## 5. Phase 2: シンボルグラフ + PPR + SelfVault + Graph UI

Phase 2 は Phase 1 の L3 hybrid search の上に、**決定論的な L2 symbol layer** を追加します。

### 新しいテーブル

- `vault_symbols` — シンボル定義（symbol id、name、kind、path、line range）
- `vault_edges` — 有向エッジ（call / import / wikilink、fromSymbol / toSymbol）
- `vault_wikilinks` — Markdown `[[wikilink]]` の未解決 / 解決済みペア
- `vault_meta.indexer_version` = `'phase2.v1'`

### Tree-sitter WASM 抽出器

`src/vault/symbol-extractor/` に配置されています。

- **TypeScript** — クラス、関数、メソッド、interface、type、export
- **C#** — namespace、class、struct、method、property
- **Markdown** — 正規表現ベースの wikilink 抽出

各 extractor は**呼び出しごとに fresh な Parser インスタンスを作成**する設計です（Phase 2 セキュリティレビュー対応、詳細は §9 セキュリティ）。

### Symbol ID 形式

```
<lang>::<relPath>::<qualifiedName>
```

例:

- `csharp::Assets/Scripts/Player.cs::Game.Player.Move`
- `typescript::src/foo.ts::Foo.bar`

解決できない extern 参照は `<lang>::unresolved::<label>` 形式で格納されます（後段の解決パスで upgrade される可能性あり）。

### graph.canvas（JSON Canvas 1.0）

`.strada/vault/graph.canvas` に **JSON Canvas 1.0** 形式のグラフファイルが永続化されます。再生成されるタイミング:

- cold start（起動時）
- `/vault sync` 完了時
- watcher の drain 時（デバウンス窓を閉じるタイミング）

ファイル書き込みは atomic（tmpfile → rename）で、途中終了しても canvas が破損しません。

### Personalized PageRank（`src/vault/ppr.ts`）

`VaultQuery.focusFiles` が指定されると、edge graph 上で Personalized PageRank を計算し、focus files に近いシンボル / chunk を優先的に上位に持ち上げます。damping factor は正規化されており、small graph で確率質量が漏れないようになっています。`focusFiles` が空の場合は RRF-only のパスが維持され、PPR のコストはゼロです。

### SelfVault（`src/vault/self-vault.ts`）

Strada.Brain 自身のソースコードを index する特別な vault です。index 対象:

- `src/` — TypeScript の全ソース
- `web-portal/src/` — React portal のフロントエンド
- `tests/` — テスト群
- `docs/` — ドキュメント
- `AGENTS.md`、`CLAUDE.md` — agent 指示ファイル

**Symlink はスキップ** されます（セキュリティレビュー対応）。これにより、agent 自身が自分のコードベースを理解し、自己修正・リファクタリング・ドキュメント生成のための正確な文脈を得られるようになります。

### 新しい HTTP エンドポイント

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/vaults/:id/canvas` | `graph.canvas` をそのまま返す |
| GET | `/api/vaults/:id/symbols/by-name?q=X` | 短い名前からシンボルを検索 |
| GET | `/api/vaults/:id/symbols/:symbolId/callers` | 指定シンボルへの incoming call edges を返す |

### ポータル Graph タブ

`/admin/vaults` に **Graph タブ** が追加され、`graph.canvas` を [`@xyflow/react`](https://reactflow.dev/) + [`@dagrejs/dagre`](https://github.com/dagrejs/dagre) でレンダリングします。フロントエンドの新規依存はゼロで、既存の portal バンドルに追加で同梱されています。

---

## 6. 設定リファレンス

設定は `src/config/config.ts` の `config.vault` にまとまっています。

| キー | デフォルト | 環境変数 | 説明 |
|------|-----------|----------|------|
| `enabled` | `false` | `STRADA_VAULT_ENABLED` | Vault サブシステム全体のオン/オフ |
| `writeHookBudgetMs` | `200` | `STRADA_VAULT_WRITE_HOOK_BUDGET_MS` | Strada.Brain 自身の tool 書き込みに対する同期予算（ms） |
| `debounceMs` | `800` | `STRADA_VAULT_DEBOUNCE_MS` | chokidar watcher のデバウンス窓（ms） |
| `embeddingFallback` | `'local'` | — | embedding 生成失敗時のフォールバック: `'none'` または `'local'` |
| `self.enabled` | `true` | — | SelfVault の bootstrap。`false` にすると Strada.Brain 自身を index しない |

`.env` 例:

```env
STRADA_VAULT_ENABLED=true
STRADA_VAULT_DEBOUNCE_MS=800
STRADA_VAULT_WRITE_HOOK_BUDGET_MS=200
```

---

## 7. HTTP API リファレンス

すべて localhost のみで公開されます（Web チャネルと同じセキュリティ境界）。リクエストボディは **maxBytes cap** で保護されており、巨大ペイロードによる DoS を防ぎます。

### Phase 1

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/vaults` | 登録済み vault の一覧 |
| GET | `/api/vaults/:id` | 特定 vault の統計情報 |
| GET | `/api/vaults/:id/files` | index 済みファイルツリー |
| GET | `/api/vaults/:id/files/*?raw=1` | ファイルプレビュー（markdown / raw） |
| POST | `/api/vaults/:id/query` | `{ text, topK?, budget?, langFilter?, pathGlob? }` で hybrid 検索 |
| POST | `/api/vaults/:id/sync` | 手動再 index |

### Phase 2

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/vaults/:id/canvas` | `graph.canvas`（JSON Canvas 1.0）を返す |
| GET | `/api/vaults/:id/symbols/by-name?q=X` | 短名検索（`Player.Move` 等） |
| GET | `/api/vaults/:id/symbols/:symbolId/callers` | incoming call edges の一覧 |

### WebSocket イベント

- `vault:update` — dirty-set バッチ（変更ファイル path のリスト）を portal に push

---

## 8. ポータル UI ガイド

`http://localhost:3000/admin/vaults` で開きます。

### Vault リスト

登録済み全 vault（UnityProjectVault、SelfVault など）が左ペインに並びます。`/vault init` で新しく追加すると自動で表示され、WebSocket で reactively 更新されます。

### Files タブ

- vault 内のファイルツリーを表示
- ファイルを選択すると **Markdown プレビュー**（対応フォーマット）と **Raw プレビュー** を切り替え可能
- 変更検知で reindex されたファイルは WebSocket 経由でハイライト更新

### Search タブ

- クエリ入力 → hybrid 検索を即時実行
- `topK`、token budget、言語フィルタ、path glob を UI から指定
- 結果は RRF スコア順、スコアと chunk のプレビュー、元ファイルへの jump が可能

### Graph タブ（Phase 2）

- `graph.canvas` を `@xyflow/react` + `@dagrejs/dagre` でレンダリング
- ノード: シンボル（class / method / function / markdown note）
- エッジ: call / import / wikilink
- クリックで `callers` エンドポイントを叩いて incoming 参照を探索可能
- 大規模グラフは dagre で自動レイアウト、ズーム/パンに対応

---

## 9. セキュリティ

Phase 2 のセキュリティレビュー（commit `5563d48`）で以下のハードニングが施されています。

- **Atomic canvas writes** — `.strada/vault/graph.canvas` は tmpfile → rename で書き込み、部分書き込みによる破損を回避
- **Symlink skip in SelfVault** — symlink を辿らないことで、プロジェクト外部への意図しないアクセスを防止
- **Fresh Parser per call** — tree-sitter WASM Parser をリクエストごとに新規作成し、共有状態からの副作用を排除
- **Request body maxBytes cap** — `/api/vaults/*` のリクエストボディサイズ上限で DoS を防止
- **Orphaned edge GC** — シンボル削除時に残った edge を定期的に GC
- **Normalized PPR damping** — Personalized PageRank の damping を正規化し、small graph での確率質量漏れを防止
- **2MB symbol extraction cap** — 1 ファイルあたりの symbol extraction を 2MB で打ち切り、巨大ファイルによる CPU 暴走を防止
- **Edge cache invalidation** — edge cache を適切に invalidate し、stale data による誤ったグラフ再構築を防止
- **Bounded `findCallers`** — caller 探索に上限を設け、pathological な graph での無限探索を防止

これらはすべて **Vault が localhost-only の Web チャネルと同じ境界** の内側で動作することを前提としています。Vault API を外部ネットワークに公開することは設計上想定されていません。

---

## 10. ロードマップ（Phase 3）

Phase 3 では以下を予定しています。

- **Haiku rolling summaries** — Claude Haiku による会話 / 作業履歴の rolling summary を vault に統合し、semantic memory として検索可能に
- **FrameworkVault upgrade** — Strada.Core および Unity API ナレッジを semantic 検索 + docstring 抽出で強化
- **Bidirectional Learning pipeline coupling** — Learning pipeline が発見した pattern / intuition を vault に書き戻し、vault の recall 結果が learning trajectory に供給される双方向連携

---

## 11. リンク

- ソースコード: [`src/vault/`](../src/vault/)
  - [`vault.interface.ts`](../src/vault/vault.interface.ts) — 全 vault が満たす contract
  - [`unity-project-vault.ts`](../src/vault/unity-project-vault.ts) — Unity プロジェクト用 vault
  - [`self-vault.ts`](../src/vault/self-vault.ts) — Strada.Brain 自身を index する SelfVault
  - [`vault-registry.ts`](../src/vault/vault-registry.ts) — singleton lookup と cross-vault RRF fan-out
  - [`ppr.ts`](../src/vault/ppr.ts) — Personalized PageRank 実装
  - [`symbol-extractor/`](../src/vault/symbol-extractor/) — tree-sitter WASM 抽出器
  - [`schema.sql`](../src/vault/schema.sql) — SQLite スキーマ
- 英語正本: [`docs/vault.md`](vault.md)
- 関連 README セクション: [`README.ja.md` → Codebase Memory Vault](../README.ja.md)
