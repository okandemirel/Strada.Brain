<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain ロゴ" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Unity / Strada.Core プロジェクト向け AI 開発エージェント</strong><br/>
  Web ダッシュボード、Telegram、Discord、Slack、WhatsApp、またはターミナルに接続する自律型コーディングエージェント &mdash; コードベースを読み取り、コードを書き、ビルドを実行し、エラーから学習し、24 時間 365 日のデーモンループで自律的に動作します。マルチエージェントオーケストレーション、タスク委任、メモリ統合、承認ゲート付きデプロイメントサブシステム、LLM ビジョンサポート付きメディア共有、SOUL.md による設定可能な性格システム、インタラクティブ確認ツール、タスク認識型動的切り替えによるインテリジェントマルチプロバイダールーティング、信頼度ベースのコンセンサス検証、OODA 推論ループを備えた自律型 Agent Core、そして Strada.MCP 統合を搭載。
</p>

> 翻訳注記: 現在のランタイム挙動、環境変数の既定値、セキュリティ意味論の正本は [README.md](README.md) です。このファイルはその翻訳です。

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3450%2B-brightgreen?style=flat-square" alt="テスト">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="ライセンス">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <strong>&#26085;&#26412;&#35486;</strong> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## これは何ですか？

Strada.Brain はチャットチャネルを通じて対話する AI エージェントです。やりたいことを記述するだけで -- 「プレイヤー移動用の新しい ECS システムを作成して」や「health を使用しているすべてのコンポーネントを探して」-- エージェントが C# プロジェクトを読み取り、コードを書き、`dotnet build` を実行し、エラーを自動修正し、結果を返します。

ハイブリッド加重信頼度スコアリングによる過去のエラーからの学習、SQLite + HNSW ベクトルに基づく永続メモリ、複雑なゴールの並列 DAG 実行への分解、Saga ロールバック付きマルチツールチェーンの自動合成、そしてプロアクティブトリガー付きの 24 時間 365 日デーモンとしての運用が可能です。チャネル別セッション分離によるマルチエージェントオーケストレーション、エージェント階層間の階層的タスク委任、自動メモリ統合、ヒューマンインザループ承認ゲートとサーキットブレーカー保護を備えたデプロイメントサブシステムをサポートしています。

本リリースの新機能：Strada.Brain に **Agent Core** が搭載されました -- 環境（ファイル変更、git 状態、ビルド結果）を観察し、学習済みパターンを使用して優先度を推論し、プロアクティブにアクションを実行する自律型 OODA 推論エンジンです。**マルチプロバイダールーティング** システムは、各タスクタイプ（計画、コード生成、デバッグ、レビュー）に最適な AI プロバイダーを動的に選択し、設定可能なプリセット（budget/balanced/performance）をサポートします。**信頼度ベースのコンセンサス** システムは、エージェントの信頼度が低い場合に自動的に別のプロバイダーに意見を求め、クリティカルな操作でのエラーを防止します。すべての機能はグレースフルにデグレードします -- 単一プロバイダーの場合、システムは以前と全く同じように動作し、オーバーヘッドはゼロです。

**これはライブラリでも API でもありません。** スタンドアロンのアプリケーションとして実行します。チャットプラットフォームに接続し、ディスク上の Unity プロジェクトを読み取り、設定した範囲内で自律的に動作します。

---

## クイックスタート

### 前提条件

- **Node.js 20+** および npm
- 少なくとも 1 つの対応 AI プロバイダー認証情報（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` など）、OpenAI ChatGPT/Codex subscription セッション（`OPENAI_AUTH_MODE=chatgpt-subscription`）、または `ollama` のみの `PROVIDER_CHAIN`
- **Unity プロジェクト**（エージェントに渡すパス）。Strada.Core があると Strada 固有の支援がより完全になります。

### 1. インストール

```bash
# ソースからクローン（現時点の正規インストール手順）
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
npm run bootstrap

# Source checkout 向けローカルヘルパー（global link なしでも使えます）
npm run setup:web
npm run setup:terminal

# `strada` コマンドで一括起動したい場合は推奨
npm link
```

`strada-brain` はまだ public npm registry に公開されていないため、`npm install -g strada-brain` は現在 `E404` になります。npm 公開が行われるまでは、上の source checkout 手順を使ってください。

### 2. 設定

```bash
# インタラクティブセットアップウィザード（ターミナルまたは Web ブラウザ）
strada setup

# 選択画面を飛ばして目的のセットアップ画面を直接開く
strada setup --web
strada setup --terminal
```

ウィザードでは、Unity プロジェクトパス、AI プロバイダー API キー、デフォルトチャネル、言語が尋ねられます。**ターミナル** を選択すれば迅速なセットアップが、**Web ブラウザ** を選択すれば完全な設定 UI が表示されます。
最初のセットアップ完了後は、サブコマンドなしの `strada` がスマートランチャーになります。
- 初回は config がなければ自動で setup を開く
- 以後は web / CLI / daemon / setup / doctor を選べるターミナルパネルを表示する
セットアップ後は、エージェントを起動する前に readiness check を実行してください。

```bash
# source checkout から
npm run doctor

# もしくは global link 済みなら
strada doctor
```

または、`.env` を手動で作成します：

```env
ANTHROPIC_API_KEY=sk-ant-...      # Claude API キー
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Assets/ を含む必要あり
JWT_SECRET=<生成方法: openssl rand -hex 64>
```

### 3. 実行

```bash
# スマートランチャー: 必要なら setup を開き、そうでなければ起動パネルを表示
strada

# 保存済みの既定チャネルを直接デーモンモードで起動
strada --daemon

# デフォルト Web チャネルで起動
strada start

# インタラクティブ CLI モード（最も手軽なテスト方法）
strada start --channel cli

# デーモンモード（プロアクティブトリガー付き 24 時間 365 日自律動作）
strada start --channel web --daemon

# その他のチャットチャネル
strada start --channel telegram
strada start --channel discord
strada start --channel slack
strada start --channel whatsapp

# 自動再起動スーパーバイザー付きで常時実行
strada supervise --channel web
```

### 4. CLI コマンド

```bash
strada                    # スマートランチャー（初回は setup、その後は起動パネル）
strada --daemon           # 保存済みの既定チャネルをデーモンモードで起動
strada setup              # インタラクティブセットアップウィザード
strada setup --web        # Web ウィザードを直接起動
strada setup --terminal   # Terminal ウィザードを直接使用
strada doctor             # インストール / build / config の準備状態を確認
strada start              # エージェントを起動
strada supervise          # 自動再起動スーパーバイザー付きで実行
strada update             # 更新を確認して適用
strada update --check     # 適用せずに更新を確認
strada version-info       # バージョン、インストール方法、更新ステータスを表示
```

### 5. 対話する

実行後、設定したチャネルからメッセージを送信します：

```
> プロジェクト構造を分析して
> DamageSystem と HealthComponent を含む "Combat" という新しいモジュールを作成して
> PositionComponent をクエリするすべてのシステムを探して
> ビルドを実行してエラーを修正して
```

**Web チャネル：** ターミナルは不要です -- `localhost:3000` の Web ダッシュボードを通じて操作します。

### 6. 自動更新

Strada.Brain は毎日自動的に更新をチェックし、アイドル時に適用します。source checkout と `npm link` インストールは git 経由で更新されます。npm ベースの更新コマンドは public npm release が存在する場合にのみ有効です。

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `AUTO_UPDATE_ENABLED` | `true` | 自動更新を有効化/無効化 |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | チェック頻度（時間） |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | 更新を適用するまでのアイドル時間（分） |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm dist-tag：`stable` または `latest` |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | アイドル時に更新後自動再起動 |

---

## アーキテクチャ

```
+-----------------------------------------------------------------+
|  チャットチャネル                                                 |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter インターフェース
                               |
+------------------------------v----------------------------------+
|  オーケストレーター（PAOR エージェントループ）                     |
|  計画 -> 実行 -> 観察 -> 振り返り ステートマシン                  |
|  直感検索、障害分類、自動再計画                                    |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| AI プロバイダー| | 30+ ツール | | コンテキスト| | 学習システム      |
| Claude（主要）| | ファイルI/O| | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git 操作   | | (SQLite +  | | ハイブリッド加重  |
| DeepSeek,Qwen| | シェル実行 | |  HNSW)     | | 直感ライフ       |
| MiniMax, Groq| | .NETビルド | | RAGベクトル | |  サイクル         |
| Ollama +他   | | Strada生成 | | アイデンティティ| | ツールチェーン  |
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

### エージェントループの仕組み

1. **メッセージ受信** -- チャットチャネルから（テキスト、画像、動画、音声、またはドキュメント）
2. **メモリ検索** -- AgentDB ハイブリッド検索（70% セマンティック HNSW + 30% TF-IDF）で最も関連性の高い過去の会話を取得
3. **RAG 検索** -- C# コードベースのセマンティック検索（HNSW ベクトル、上位 6 件）
4. **直感検索** -- タスクに関連する学習済みパターンをプロアクティブに検索（セマンティック + キーワードマッチング）
5. **アイデンティティコンテキスト** -- 永続的なエージェントアイデンティティを注入（UUID、起動回数、稼働時間、クラッシュリカバリ状態）
6. **計画フェーズ** -- LLM が学習済みインサイトと過去の失敗に基づいて番号付き計画を作成
7. **実行フェーズ** -- LLM が計画に従ってツール呼び出しを実行
8. **観察** -- 結果を記録、エラーリカバリが失敗を分析、障害分類器がエラーを分類
9. **振り返り** -- 3 ステップごと（またはエラー時）、LLM が判断：**続行**、**再計画**、または**完了**
10. **自動再計画** -- 同種の連続 3 回以上の失敗で、失敗した戦略を避ける新しいアプローチを強制
11. **繰り返し** -- 完了まで最大 50 回の反復
12. **学習** -- ツール結果が TypedEventBus を通じて学習パイプラインに流れ、即座にパターンが保存される
13. **レスポンス送信** -- チャネル経由でユーザーに送信（対応時はストリーミング）

---

## メモリシステム

アクティブなメモリバックエンドは `AgentDBMemory` です -- SQLite と HNSW ベクトルインデックスによる 3 層オートティアリングアーキテクチャを採用しています。

**3 層メモリ：**
- **ワーキングメモリ** -- アクティブなセッションコンテキスト、継続的な使用後に自動昇格
- **一時メモリ** -- 短期ストレージ、容量しきい値に達すると自動削除
- **永続メモリ** -- 長期ストレージ、アクセス頻度と重要度に基づいて一時メモリから昇格

**仕組み：**
- セッション履歴が 40 メッセージを超えると、古いメッセージが要約されて会話エントリとして保存
- ハイブリッド検索が 70% のセマンティック類似性（HNSW ベクトル）と 30% の TF-IDF キーワードマッチングを組み合わせ
- `strada_analyze_project` ツールがプロジェクト構造分析をキャッシュし、即座にコンテキスト注入
- メモリは `MEMORY_DB_PATH` ディレクトリ（デフォルト：`.strada-memory/`）に永続化され、再起動後も保持
- レガシーの FileMemoryManager からの自動マイグレーションが初回起動時に実行

**フォールバック：** AgentDB の初期化に失敗した場合、システムは自動的に `FileMemoryManager`（JSON + TF-IDF）にフォールバックします。

---

## 学習システム

学習システムはエージェントの動作を観察し、イベント駆動パイプラインを通じてエラーから学習します。

**イベント駆動パイプライン：**
- ツール結果が `TypedEventBus` を通じてシリアルな `LearningQueue` に流れ、即座に処理
- タイマーベースのバッチ処理なし -- パターンは発生時に検出・保存
- `LearningQueue` はバウンド付き FIFO とエラー分離を使用（学習の失敗がエージェントをクラッシュさせることはない）

**ハイブリッド加重信頼度スコアリング：**
- 信頼度 = 5要素の加重合計：成功率 (0.35)、パターン強度 (0.25)、近接性 (0.20)、コンテキスト一致 (0.15)、検証 (0.05)
- 評定スコア（0.0-1.0）が信頼区間のためのアルファ/ベータ証拠カウンタを更新
- アルファ/ベータパラメータは不確実性推定のために維持されるが、主要な信頼度計算には使用されない

**直感ライフサイクル：**
- **提案済み**（新規）-- 信頼度 0.7 未満
- **アクティブ** -- 信頼度 0.7 から 0.9
- **進化済み** -- 0.9 以上、永続化への昇格候補
- **非推奨** -- 0.3 未満、削除対象としてマーク
- **クーリング期間** -- ステータス変更前に最低限の観察要件を伴う 7 日間のウィンドウ
- **永続** -- 凍結、以後の信頼度更新なし

**アクティブ検索：** 各タスクの開始時に `InstinctRetriever` を使用して直感をプロアクティブに検索します。キーワード類似性と HNSW ベクトル埋め込みで関連する学習済みパターンを検索し、計画フェーズのプロンプトに注入します。

**クロスセッション学習：** 直感はクロスセッションの知識移転のために出所メタデータ（ソースセッション、セッション数）を保持します。

---

## ゴール分解

複雑なマルチステップリクエストは自動的にサブゴールの有向非巡回グラフ（DAG）に分解されます。

**GoalDecomposer：**
- ヒューリスティック事前チェックにより単純なタスクでは LLM 呼び出しを回避（複雑さの指標に対するパターンマッチング）
- LLM が依存関係エッジとオプションの再帰深度（最大 3 レベル）を持つ DAG 構造を生成
- カーンのアルゴリズムで循環のない DAG 構造を検証
- リアクティブな再分解：ノードが失敗した場合、より小さなリカバリステップに分割可能

**GoalExecutor：**
- ウェーブベースの並列実行が依存関係の順序を尊重
- セマフォベースの並行性制限（`GOAL_MAX_PARALLEL`）
- 失敗バジェット（`GOAL_MAX_FAILURES`）とユーザー向け継続プロンプト
- LLM の重要度評価が失敗したノードが依存先をブロックすべきか判断
- ノードごとのリトライロジック（`GOAL_MAX_RETRIES`）とリトライ回数超過時のリカバリ分解
- キャンセル用の AbortSignal サポート
- `GoalStorage`（SQLite）による永続的なゴールツリー状態で再起動後の再開が可能

---

## ツールチェーン合成

エージェントはマルチツールチェーンパターンを自動的に検出・合成し、再利用可能なコンポジットツールに変換します。V2 では DAG ベースの並列実行と複雑なチェーン向けの Saga ロールバックが追加されました。

**パイプライン：**
1. **ChainDetector** -- トラジェクトリデータを分析して繰り返し出現するツールシーケンスを検出（例：`file_read` -> `file_edit` -> `dotnet_build`）
2. **ChainSynthesizer** -- LLM を使用して適切な入出力マッピングと説明を持つ `CompositeTool` を生成
3. **ChainValidator** -- 合成後の検証とランタイムフィードバック、加重信頼度スコアリングによるチェーン実行成功の追跡
4. **ChainManager** -- ライフサイクルオーケストレーター：起動時に既存チェーンを読み込み、定期的に検出を実行し、コンポーネントツールが削除された場合にチェーンを自動無効化

**V2 の強化点：**
- **DAG実行** -- 独立したステップは並列実行
- **Sagaロールバック** -- ステップ失敗時に前のステップを逆順で元に戻す
- **チェーンバージョニング** -- 旧バージョンはアーカイブされる

**セキュリティ：** コンポジットツールはコンポーネントツールの中で最も制限的なセキュリティフラグを継承します。

**信頼度カスケード：** チェーン直感は通常の直感と同じ信頼度ライフサイクルに従います。非推奨しきい値を下回ったチェーンは自動的に登録解除されます。

---

## マルチエージェントオーケストレーション

複数のエージェントインスタンスがチャネル/セッション別の分離で同時に動作できます。

**AgentManager：**
- チャネル/セッションごとにエージェントインスタンスを作成・管理
- セッション分離により異なるチャネルのエージェント同士が干渉しない
- `MULTI_AGENT_ENABLED` はデフォルトで有効です。従来のシングルエージェント動作に戻すには `false` を設定します

**AgentBudgetTracker：**
- エージェント別のトークンおよびコスト追跡（設定可能な予算制限付き）
- 全エージェント間で共有される日次/月次予算上限
- 予算超過時はハード障害ではなくグレースフルデグラデーション（読み取り専用モード）をトリガー

**AgentRegistry：**
- 全アクティブエージェントインスタンスの中央レジストリ
- ヘルスチェックとグレースフルシャットダウンをサポート
- マルチエージェントは完全オプトイン：無効時は v2.0 と同一の動作

---

## タスク委任

エージェントは階層型ルーティングシステムを使用してサブタスクを他のエージェントに委任できます。

**TierRouter（4段階）：**
- **Tier 1** -- 現在のエージェントが処理する単純なタスク（委任なし）
- **Tier 2** -- 中程度の複雑さ、セカンダリエージェントに委任
- **Tier 3** -- 高複雑度、拡張予算付きで委任
- **Tier 4** -- 専門エージェント能力を必要とするクリティカルタスク

**DelegationManager：**
- 委任ライフサイクルを管理：作成、追跡、完了、キャンセル
- 最大委任深度（デフォルト：2）を強制し、無限委任ループを防止
- 予算認識型：委任されたタスクは親の残余予算の一部を継承

**DelegationTool：**
- エージェントが作業を委任するために呼び出せるツールとして公開
- 委任されたサブタスクからの結果集約を含む

---

## メモリ減衰と統合

メモリエントリは指数関数的減衰モデルを使用して時間の経過とともに自然に減衰し、アイドル時の統合により冗長性を削減します。

**指数関数的減衰：**
- 各メモリエントリには時間とともに減少する減衰スコアがある
- アクセス頻度と重要度が減衰耐性を高める
- 直感は減衰の対象外（期限切れにならない）

**アイドル時統合：**
- 低活動期間中に統合エンジンが HNSW クラスタリングを使用してセマンティック的に類似したメモリを特定
- 関連するメモリが統合サマリーにマージされ、ストレージを削減し検索品質を向上
- ソフトデリートと元に戻す機能：統合されたソースメモリは統合済みとしてマーク（物理的に削除されない）、復元可能

**統合エンジン：**
- クラスタ検出用の設定可能な類似度しきい値
- 設定可能なチャンクサイズによるバッチ処理
- 統合操作の完全な監査証跡

---

## デプロイメントサブシステム

ヒューマンインザループ承認ゲートとサーキットブレーカー保護を備えたオプトインデプロイメントシステムです。

**ReadinessChecker：**
- デプロイメント前にシステムの準備状態を検証（ビルド状態、テスト結果、リソース可用性）
- 設定可能な準備基準

**DeployTrigger：**
- デーモンのトリガーシステムに新しいトリガータイプとして統合
- デプロイメント条件が満たされた時に発火（例：全テスト合格、承認取得）
- 承認キュー付き：デプロイメントは実行前に明示的な人間の承認が必要

**DeploymentExecutor：**
- ロールバック機能付きでデプロイメントステップを順次実行
- 環境変数のサニタイズによりデプロイメントログでの認証情報漏洩を防止
- サーキットブレーカー：連続デプロイメント失敗時に自動クールダウンをトリガーし、カスケード障害を防止

**セキュリティ：** デプロイメントはデフォルトで無効であり、設定による明示的なオプトインが必要です。すべてのデプロイメントアクションはログに記録され監査可能です。

---

### Agent Core（自律型 OODA ループ）

デーモンモードがアクティブな場合、Agent Core は連続的な観察-方向付け-決定-行動ループを実行します：

- **観察**：6 つのオブザーバーから環境状態を収集（ファイル変更、git 状態、ビルド結果、トリガーイベント、ユーザーアクティビティ、テスト結果）
- **方向付け**：学習情報に基づく優先度（PriorityScorer と直感の統合）を使用して観察をスコアリング
- **決定**：予算認識型スロットリング付き LLM 推論（30 秒の最小間隔、優先度しきい値、予算フロア）
- **行動**：ゴールの送信、ユーザーへの通知、または待機（エージェントは「何もしない」と判断可能）

安全性：tickInFlight ガード、レート制限、予算フロア（10%）、および DaemonSecurityPolicy の適用。

### マルチプロバイダーインテリジェントルーティング

2 つ以上のプロバイダーが設定されている場合、Strada.Brain はタスクを最適なプロバイダーに自動ルーティングします：

| タスクタイプ | ルーティング戦略 |
|------------|----------------|
| 計画 | 最大コンテキストウィンドウ（Claude > GPT > Gemini） |
| コード生成 | 強力なツール呼び出し（Claude > Kimi > OpenAI） |
| コードレビュー | 実行者とは異なるモデル（多様性バイアス） |
| 簡単な質問 | 最速/最安（Groq > Kimi > Ollama） |
| デバッグ | 強力なエラー分析 |

**プリセット**：`budget`（コスト最適化）、`balanced`（デフォルト）、`performance`（品質優先）
**PAOR フェーズ切り替え**：計画フェーズと実行フェーズ、振り返りフェーズで異なるプロバイダーを使用。
**コンセンサス**：低信頼度 → 別のプロバイダーから自動的にセカンドオピニオンを取得。

### Strada.MCP 統合

Strada.Brain は [Strada.MCP](https://github.com/okandemirel/Strada.MCP)（Unity MCP サーバー）を検出し、ランタイム制御、ファイル操作、git、.NET ビルド、コード分析、シーン/プレハブ管理を含む利用可能な MCP 機能についてエージェントに通知します。

---

## デーモンモード

デーモンはハートビート駆動のトリガーシステムによる 24 時間 365 日の自律動作を提供します。デーモンモードがアクティブな場合、**Agent Core OODA ループ** がデーモンのティック内で実行され、ユーザーインタラクションの合間に環境を観察してプロアクティブにアクションを実行します。`/autonomous on` コマンドは DaemonSecurityPolicy に伝播し、アクションごとの承認プロンプトなしで完全な自律運用を可能にします。

```bash
npm run dev -- daemon --channel web
```

**HeartbeatLoop：**
- 設定可能なティック間隔で各サイクルに登録されたトリガーを評価
- 順次トリガー評価により予算のレースコンディションを防止
- クラッシュリカバリのために実行状態を永続化

**トリガータイプ：**
- **Cron** -- cron 式によるスケジュールタスク
- **ファイル監視** -- 設定されたパスでのファイルシステム変更を監視
- **チェックリスト** -- チェックリスト項目の期限到来時に発火
- **Webhook** -- HTTP POST エンドポイントで受信リクエストに応じてタスクをトリガー
- **Deploy** -- デプロイ条件が満たされた時に発火（承認ゲート必須）

**耐障害性：**
- **サーキットブレーカー** -- トリガーごとに指数バックオフクールダウン、再起動間で永続化
- **予算追跡** -- 日次 USD 支出上限と警告しきい値イベント
- **トリガー重複排除** -- コンテンツベースおよびクールダウンベースの抑制で重複発火を防止
- **オーバーラップ抑制** -- 既にアクティブなタスクが実行中のトリガーをスキップ

**セキュリティ：**
- `DaemonSecurityPolicy` がデーモントリガーで呼び出される際にユーザー承認が必要なツールを制御
- 書き込み操作用の有効期限付き `ApprovalQueue`

**レポーティング：**
- `NotificationRouter` が緊急度レベル（サイレント/低/中/高/クリティカル）に基づいてイベントを設定されたチャネルにルーティング
- 緊急度ごとのレート制限とクワイエットアワーサポート（非クリティカル通知はバッファリング）
- `DigestReporter` が定期的なサマリーレポートを生成
- すべての通知は SQLite 履歴に記録

---

## アイデンティティシステム

エージェントはセッションおよび再起動をまたいで永続的なアイデンティティを維持します。

**IdentityStateManager**（SQLite バックエンド）：
- 初回起動時に一意のエージェント UUID を生成
- 起動回数、累積稼働時間、最終アクティビティのタイムスタンプ
- メッセージ総数とタスク総数のカウンター
- クラッシュリカバリのためのクリーンシャットダウン検出
- SQLite 書き込みを最小化するためのインメモリカウンターキャッシュと定期的なフラッシュ

**クラッシュリカバリ：**
- 起動時に前回のセッションがクリーンにシャットダウンされていない場合、`CrashRecoveryContext` を構築
- ダウンタイムの長さ、中断されたゴールツリー、起動回数を含む
- システムプロンプトに注入され、LLM が自然にクラッシュを認識し、中断された作業を再開可能

---

## 設定リファレンス

すべての設定は環境変数で行います。完全なリストは `.env.example` を参照してください。

### 必須

| 変数 | 説明 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API キー（主要 LLM プロバイダー） |
| `UNITY_PROJECT_PATH` | Unity プロジェクトルートへの絶対パス（`Assets/` を含む必要あり） |
| `JWT_SECRET` | JWT 署名用シークレット。生成方法：`openssl rand -hex 64` |

### AI プロバイダー

OpenAI 互換の任意のプロバイダーが動作します。以下のプロバイダーはすべて実装済みで、ほとんどは API キーで有効化されます。OpenAI については、このマシン上の ChatGPT/Codex サブスクリプションを会話用に再利用することもできます。

| 変数 | プロバイダー | デフォルトモデル |
|------|-------------|----------------|
| `ANTHROPIC_API_KEY` | Claude（主要） | `claude-sonnet-4-20250514` |
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
| `OLLAMA_BASE_URL` | Ollama（ローカル） | `llama3` |
| `PROVIDER_CHAIN` | フォールバック順序 | 例：`claude,kimi,deepseek,ollama` |
| `OPENAI_AUTH_MODE` | OpenAI 認証モード | `api-key`（既定）または `chatgpt-subscription` |
| `OPENAI_CHATGPT_AUTH_FILE` | 任意の Codex 認証ファイル | `OPENAI_AUTH_MODE=chatgpt-subscription` のとき既定で `~/.codex/auth.json` |

**プロバイダーチェーン：** `PROVIDER_CHAIN` にプロバイダー名のカンマ区切りリストを設定します。Strada はコントロールプレーンのままで、このチェーンを主実行ワーカー、スーパーバイザのルーティング、フォールバックに使う既定のオーケストレーションプールとして扱います。例：`PROVIDER_CHAIN=kimi,deepseek,claude` は Kimi を最初に使用し、Kimi が失敗すれば DeepSeek、次に Claude を使用します。

**重要：** `OPENAI_AUTH_MODE=chatgpt-subscription` は Strada 内の OpenAI 会話ターンにのみ適用されます。OpenAI API や embeddings のクォータは付与されません。`EMBEDDING_PROVIDER=openai` を使う場合は、引き続き `OPENAI_API_KEY` が必要です。

### チャットチャネル

**Web：**
| 変数 | 説明 |
|------|------|
| `WEB_CHANNEL_PORT` | Web ダッシュボードのポート（デフォルト：`3000`） |

**Telegram：**
| 変数 | 説明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | @BotFather から取得したトークン |
| `ALLOWED_TELEGRAM_USER_IDS` | カンマ区切りの Telegram ユーザー ID（必須、空の場合は全拒否） |

**Discord：**
| 変数 | 説明 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord ボットトークン |
| `DISCORD_GUILD_ID` | Discord ギルド ID |
| `ALLOWED_DISCORD_USER_IDS` | カンマ区切りのユーザー ID（空の場合は全拒否） |
| `ALLOWED_DISCORD_ROLE_IDS` | ロールベースアクセス用のカンマ区切りロール ID |

**Slack：**
| 変数 | 説明 |
|------|------|
| `SLACK_BOT_TOKEN` | `xoxb-...` ボットトークン |
| `SLACK_APP_TOKEN` | `xapp-...` アプリレベルトークン（ソケットモード用） |
| `SLACK_SIGNING_SECRET` | Slack アプリの署名シークレット |
| `ALLOWED_SLACK_USER_IDS` | カンマ区切りのユーザー ID（**空の場合は全ユーザーに開放**） |
| `ALLOWED_SLACK_WORKSPACES` | カンマ区切りのワークスペース ID（**空の場合は全ワークスペースに開放**） |

**WhatsApp：**
| 変数 | 説明 |
|------|------|
| `WHATSAPP_SESSION_PATH` | セッションファイルのディレクトリ（デフォルト：`.whatsapp-session`） |
| `WHATSAPP_ALLOWED_NUMBERS` | カンマ区切りの電話番号（任意。空の場合は全員に公開） |

### 機能

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `RAG_ENABLED` | `true` | C# プロジェクトに対するセマンティックコード検索を有効化 |
| `EMBEDDING_PROVIDER` | `auto` | エンベディングプロバイダー：`auto`、`openai`、`gemini`、`mistral`、`together`、`fireworks`、`qwen`、`ollama` |
| `EMBEDDING_DIMENSIONS` | (プロバイダーデフォルト) | 出力ベクトル次元数（Matryoshka：Gemini/OpenAI は 128-3072） |
| `MEMORY_ENABLED` | `true` | 永続的な会話メモリを有効化 |
| `MEMORY_DB_PATH` | `.strada-memory` | メモリデータベースファイルのディレクトリ |
| `WEB_CHANNEL_PORT` | `3000` | Web ダッシュボードのポート |
| `DASHBOARD_ENABLED` | `false` | HTTP モニタリングダッシュボードを有効化 |
| `DASHBOARD_PORT` | `3100` | ダッシュボードサーバーポート |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket リアルタイムダッシュボードを有効化 |
| `ENABLE_PROMETHEUS` | `false` | Prometheus メトリクスエンドポイントを有効化（ポート 9090） |
| `MULTI_AGENT_ENABLED` | `true` | マルチエージェントオーケストレーションを有効化 |
| `TASK_DELEGATION_ENABLED` | `false` | エージェント間タスク委任を有効化 |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | 最大委任チェーン深度 |
| `DEPLOY_ENABLED` | `false` | デプロイメントサブシステムを有効化 |
| `SOUL_FILE` | `soul.md` | エージェント性格ファイルのパス（変更時にホットリロード） |
| `SOUL_FILE_WEB` | (未設定) | Web チャネル向けのチャネル別性格オーバーライド |
| `SOUL_FILE_TELEGRAM` | (未設定) | Telegram 向けのチャネル別性格オーバーライド |
| `SOUL_FILE_DISCORD` | (未設定) | Discord 向けのチャネル別性格オーバーライド |
| `SOUL_FILE_SLACK` | (未設定) | Slack 向けのチャネル別性格オーバーライド |
| `SOUL_FILE_WHATSAPP` | (未設定) | WhatsApp 向けのチャネル別性格オーバーライド |
| `READ_ONLY_MODE` | `false` | すべての書き込み操作をブロック |
| `LOG_LEVEL` | `info` | `error`、`warn`、`info`、または `debug` |

### ルーティングとコンセンサス

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `ROUTING_PRESET` | `balanced` | ルーティングプリセット：`budget`、`balanced`、または `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | プロバイダー間の PAOR フェーズ切り替えを有効化 |
| `CONSENSUS_MODE` | `auto` | コンセンサスモード：`auto`、`critical-only`、`always`、または `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | コンセンサスをトリガーする信頼度しきい値 |
| `CONSENSUS_MAX_PROVIDERS` | `3` | コンセンサスで参照する最大プロバイダー数 |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | デーモンモードの日次予算（USD） |

### レート制限

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `RATE_LIMIT_ENABLED` | `false` | レート制限を有効化 |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | ユーザーあたりのメッセージ制限（0 = 無制限） |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | ユーザーあたりの時間制限 |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | グローバル日次トークンクォータ |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | 日次支出上限（USD） |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | 月次支出上限（USD） |

### セキュリティ

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `REQUIRE_MFA` | `false` | 多要素認証を要求 |
| `BROWSER_HEADLESS` | `true` | ブラウザ自動化をヘッドレスで実行 |
| `BROWSER_MAX_CONCURRENT` | `5` | 同時ブラウザセッションの最大数 |

---

## ツール

エージェントにはカテゴリ別に整理された 40 以上の組み込みツールがあります：

### ファイル操作
| ツール | 説明 |
|--------|------|
| `file_read` | 行番号付きファイル読み取り、オフセット/リミットページネーション（512KB 制限） |
| `file_write` | ファイルの作成または上書き（256KB 制限、ディレクトリ自動作成） |
| `file_edit` | 一意性チェック付きの検索置換編集 |
| `file_delete` | 単一ファイルの削除 |
| `file_rename` | プロジェクト内でのファイルのリネームまたは移動 |
| `file_delete_directory` | 再帰的ディレクトリ削除（安全上限 50 ファイル） |

### 検索
| ツール | 説明 |
|--------|------|
| `glob_search` | glob パターンによるファイル検索（最大 50 件） |
| `grep_search` | ファイル横断の正規表現コンテンツ検索（最大 20 件） |
| `list_directory` | ファイルサイズ付きディレクトリ一覧 |
| `code_search` | RAG によるセマンティック/ベクトル検索 -- 自然言語クエリ |
| `memory_search` | 永続的な会話メモリの検索 |

### Strada コード生成
| ツール | 説明 |
|--------|------|
| `strada_analyze_project` | C# プロジェクト全体のスキャン -- モジュール、システム、コンポーネント、サービス |
| `strada_create_module` | 完全なモジュールスキャフォールド生成（`.asmdef`、設定、ディレクトリ） |
| `strada_create_component` | フィールド定義付き ECS コンポーネント構造体の生成 |
| `strada_create_mediator` | コンポーネントバインディング付き `EntityMediator<TView>` の生成 |
| `strada_create_system` | `SystemBase`/`JobSystemBase`/`BurstSystem` スキャフォールドの生成 |

### Git
| ツール | 説明 |
|--------|------|
| `git_status` | ワーキングツリーのステータス |
| `git_diff` | 変更内容の表示 |
| `git_log` | コミット履歴 |
| `git_commit` | ステージしてコミット |
| `git_push` | リモートにプッシュ |
| `git_branch` | ブランチの一覧表示、作成、チェックアウト |
| `git_stash` | スタッシュの push、pop、list、drop |

### .NET / Unity
| ツール | 説明 |
|--------|------|
| `dotnet_build` | `dotnet build` を実行し、MSBuild エラーを構造化出力にパース |
| `dotnet_test` | `dotnet test` を実行し、合格/不合格/スキップ結果をパース |

### エージェントインタラクション
| ツール | 説明 |
|--------|------|
| `ask_user` | 複数選択肢と推奨回答付きの確認質問をユーザーに送信 |
| `show_plan` | 実行計画を表示してユーザー承認を待機（承認/変更/拒否） |
| `switch_personality` | 実行時にエージェントの性格を切り替え（casual/formal/minimal/default） |

### その他
| ツール | 説明 |
|--------|------|
| `shell_exec` | シェルコマンドの実行（30 秒タイムアウト、危険なコマンドのブロックリスト） |
| `code_quality` | ファイル単位またはプロジェクト単位のコード品質分析 |
| `rag_index` | インクリメンタルまたはフルプロジェクトの再インデックスをトリガー |

---

## チャットコマンド

すべてのチャットチャネルで利用可能なスラッシュコマンド：

| コマンド | 説明 |
|---------|------|
| `/daemon` | デーモンステータスを表示 |
| `/daemon start` | デーモンハートビートループを開始 |
| `/daemon stop` | デーモンハートビートループを停止 |
| `/daemon triggers` | アクティブなトリガーを表示 |
| `/agent` | Agent Core のステータスを表示 |
| `/routing` | ルーティングステータスとプリセットを表示 |
| `/routing preset <name>` | ルーティングプリセットを切り替え（budget/balanced/performance） |
| `/routing info` | 最近のルーティング決定を表示 |

---

## RAG パイプライン

RAG（検索拡張生成）パイプラインは、C# ソースコードをインデックス化してセマンティック検索を可能にします。

**インデックスフロー：**
1. Unity プロジェクト内の `**/*.cs` ファイルをスキャン
2. コードを構造的にチャンク分割 -- ファイルヘッダー、クラス、メソッド、コンストラクター
3. 設定されたプロバイダーでエンベディングを生成 -- OpenAI（`text-embedding-3-small`）、Gemini（`gemini-embedding-2-preview`、Matryoshka 次元 128-3072）、Mistral、Ollama 等。`EMBEDDING_DIMENSIONS` で出力サイズを制御
4. 高速な近似最近傍検索のため HNSW インデックスにベクトルを格納
5. 起動時にバックグラウンドで自動実行（ノンブロッキング）

**検索フロー：**
1. クエリを同じプロバイダーでエンベディング
2. HNSW 検索が `topK * 3` 候補を返却
3. リランカーがスコアリング：ベクトル類似度（60%）+ キーワードオーバーラップ（25%）+ 構造ボーナス（15%）
4. スコア 0.2 以上の上位 6 件が LLM コンテキストに注入

**注意：** RAG パイプラインは現在 C# ファイルのみをサポートしています。チャンカーは C# 専用です。

---

## チャネル機能

| 機能 | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|------|-----|----------|---------|-------|----------|-----|
| テキストメッセージ | 対応 | 対応 | 対応 | 対応 | 対応 | 対応 |
| メディア添付 | 対応（base64） | 対応（写真/ドキュメント/動画/音声） | 対応（任意の添付） | 対応（ファイルダウンロード） | 対応（画像/動画/音声/ドキュメント） | 非対応 |
| ビジョン（画像→LLM） | 対応 | 対応 | 対応 | 対応 | 対応 | 非対応 |
| ストリーミング（インプレース編集） | 対応 | 対応 | 対応 | 対応 | 対応 | 対応 |
| 入力中インジケーター | 対応 | 対応 | 対応 | 非対応 | 対応 | 非対応 |
| 確認ダイアログ | 対応（モーダル） | 対応（インラインキーボード） | 対応（ボタン） | 対応（Block Kit） | 対応（番号付き返信） | 対応（readline） |
| スレッドサポート | 非対応 | 非対応 | 対応 | 対応 | 非対応 | 非対応 |
| レートリミッター（送信側） | 対応（セッション単位） | 非対応 | 対応（トークンバケット） | 対応（4 段階スライディングウィンドウ） | インラインスロットル | 非対応 |

### ストリーミング

すべてのチャネルでインプレース編集によるストリーミングを実装しています。LLM が生成するにつれて、エージェントの応答がプログレッシブに表示されます。レート制限を回避するため、プラットフォームごとに更新頻度が制御されています（WhatsApp/Discord：1 回/秒、Slack：2 回/秒）。

### 認証

- **Telegram**：デフォルトで全拒否。`ALLOWED_TELEGRAM_USER_IDS` の設定が必要。
- **Discord**：デフォルトで全拒否。`ALLOWED_DISCORD_USER_IDS` または `ALLOWED_DISCORD_ROLE_IDS` の設定が必要。
- **Slack**：**デフォルトで全開放。** `ALLOWED_SLACK_USER_IDS` が空の場合、すべての Slack ユーザーがボットにアクセス可能。本番環境では許可リストを設定してください。
- **WhatsApp**：デフォルトで公開です。`WHATSAPP_ALLOWED_NUMBERS` を設定した場合のみ、アダプターは受信メッセージをその許可リストに制限します。

---

## セキュリティ

### レイヤー 1：チャネル認証
プラットフォーム固有の許可リストがメッセージ到着時（あらゆる処理の前）にチェックされます。

### レイヤー 2：レート制限
ユーザーごとのスライディングウィンドウ（分/時間）+ グローバルな日次/月次トークンおよび USD 予算上限。

### レイヤー 3：パスガード
すべてのファイル操作でシンボリックリンクを解決し、パスがプロジェクトルート内に収まることを検証。30 以上の機密パターンをブロック（`.env`、`.git/credentials`、SSH キー、証明書、`node_modules/`）。

### レイヤー 4：メディアセキュリティ
すべてのメディア添付ファイルは処理前に検証されます：MIME 許可リスト、タイプ別サイズ制限（画像 20MB、動画 50MB、音声 25MB、ドキュメント 10MB）、マジックバイト検証、およびダウンロード URL に対する SSRF 保護。

### レイヤー 5：シークレットサニタイザー
24 種類の正規表現パターンが、すべてのツール出力において LLM に到達する前に認証情報を検出しマスクします。対象：OpenAI キー、GitHub トークン、Slack/Discord/Telegram トークン、AWS キー、JWT、Bearer 認証、PEM キー、データベース URL、汎用シークレットパターン。

### レイヤー 6：読み取り専用モード
`READ_ONLY_MODE=true` の場合、23 個の書き込みツールがエージェントのツールリストから完全に除外されます -- LLM はそれらを呼び出すことすらできません。

### レイヤー 7：操作確認
書き込み操作（ファイル書き込み、Git コミット、シェル実行）は、チャネルのインタラクティブ UI（ボタン、インラインキーボード、テキストプロンプト）を通じてユーザー確認を要求できます。

### レイヤー 8：ツール出力のサニタイズ
すべてのツール結果は 8192 文字に制限され、LLM にフィードバックする前に API キーパターンがスクラブされます。

### レイヤー 9：RBAC（内部）
5 つのロール（superadmin、admin、developer、viewer、service）と 9 種類のリソースタイプをカバーする権限マトリクス。ポリシーエンジンは時間ベース、IP ベース、カスタム条件をサポートします。

### レイヤー 10：デーモンセキュリティ
`DaemonSecurityPolicy` がデーモンにより起動された操作に対してツールレベルの承認要件を適用します。書き込みツールは実行前に `ApprovalQueue` を通じた明示的なユーザー承認が必要です。

---

## ダッシュボードとモニタリング

### HTTP ダッシュボード（`DASHBOARD_ENABLED=true`）
`http://localhost:3100` でアクセス可能（localhost のみ）。表示内容：稼働時間、メッセージ数、トークン使用量、アクティブセッション、ツール使用状況テーブル、セキュリティ統計。3 秒ごとに自動更新。

### ヘルスエンドポイント
- `GET /health` -- 生存確認プローブ（`{"status":"ok"}`）
- `GET /ready` -- 詳細な準備状態：メモリとチャネルの健全性をチェック。200（準備完了）、207（劣化状態）、または 503（未準備）を返却

### Prometheus（`ENABLE_PROMETHEUS=true`）
`http://localhost:9090/metrics` でメトリクスを提供。メッセージ、ツール呼び出し、トークンのカウンター。リクエスト時間、ツール実行時間、LLM レイテンシーのヒストグラム。デフォルトの Node.js メトリクス（CPU、ヒープ、GC、イベントループ）。

### WebSocket ダッシュボード（`ENABLE_WEBSOCKET_DASHBOARD=true`）
リアルタイムメトリクスを毎秒プッシュします。認証付き接続、heartbeat 監視、アプリ登録済みのコマンド/通知ハンドラをサポートします。`WEBSOCKET_DASHBOARD_AUTH_TOKEN` が設定されている場合はその bearer token を使い、未設定の場合は same-origin ダッシュボードがプロセス単位のトークンを自動的に bootstrap します。

### メトリクスシステム
`MetricsStorage`（SQLite）がタスク完了率、反復回数、ツール使用状況、パターン再利用を記録。`MetricsRecorder` がセッションごとのメトリクスをキャプチャ。`metrics` CLI コマンドで履歴メトリクスを表示。

---

## デプロイ

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml` にはアプリケーション、モニタリングスタック、nginx リバースプロキシが含まれています。

### デーモンモード

```bash
# プロアクティブトリガー付きハートビートループによる 24 時間 365 日自律動作
node dist/index.js daemon --channel web

# クラッシュ時に指数バックオフで自動再起動（1 秒〜60 秒、最大 10 回）
node dist/index.js daemon --channel telegram
```

### 本番チェックリスト

- [ ] `NODE_ENV=production` を設定
- [ ] `LOG_LEVEL=warn` または `error` を設定
- [ ] `RATE_LIMIT_ENABLED=true` を予算上限付きで設定
- [ ] チャネル許可リストを設定（特に Slack -- デフォルトで開放）
- [ ] 安全な探索のみの場合は `READ_ONLY_MODE=true` を設定
- [ ] モニタリング用に `DASHBOARD_ENABLED=true` を有効化
- [ ] メトリクス収集用に `ENABLE_PROMETHEUS=true` を有効化
- [ ] 強力な `JWT_SECRET` を生成
- [ ] デーモン予算制限を設定（`RATE_LIMIT_DAILY_BUDGET_USD`）

---

## テスト

```bash
npm test                         # 既定のフルスイート（安定性のためバッチ実行）
npm run test:watch               # ウォッチモード
npm test -- --coverage           # カバレッジ付き
npm test -- src/agents/tools/file-read.test.ts  # 単一ファイル / 対象実行
npm test -- src/dashboard/prometheus.test.ts    # 既定ランナーでの対象スイート
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Strada.Core API ドリフト検証
npm run test:file-build-flow     # opt-in のローカル .NET 統合フロー
npm run test:unity-fixture       # opt-in のローカル Unity fixture compile/test フロー
npm run test:hnsw-perf           # opt-in の HNSW ベンチマーク / 再現率スイート
npm run typecheck                # TypeScript 型チェック
npm run lint                     # ESLint
```

メモ:
- `npm test` は、以前のフルスイート OOM 経路を避けるために、バッチ化した Vitest ランナーと `fork` ワーカーを使います。
- 実ソケット bind に依存する dashboard テストは既定で skip されます。実ローカル検証には `LOCAL_SERVER_TESTS=1` を使ってください。
- `sync:check` は Strada.Brain の Strada.Core 知識を実際の checkout と突き合わせます。CI では `--max-drift-score 0` でこれを強制します。
- `test:file-build-flow`、`test:unity-fixture`、`test:hnsw-perf` は、ローカル build ツール、ライセンス済み Unity エディタ、または重い benchmark 負荷が必要なため、意図的に opt-in です。
- `test:unity-fixture` は、生成コードが正しくても、ローカルの Unity batchmode / ライセンス環境が不安定だと失敗する場合があります。

---

## プロジェクト構造

```
src/
  index.ts              # CLI エントリポイント（Commander.js）
  core/
    bootstrap.ts        # 完全な初期化シーケンス -- すべての接続がここで行われる
    event-bus.ts        # 疎結合なイベント駆動通信のための TypedEventBus
    tool-registry.ts    # ツールのインスタンス化と登録
  agents/
    orchestrator.ts     # PAOR エージェントループ、セッション管理、ストリーミング
    agent-state.ts      # フェーズステートマシン（計画/実行/観察/振り返り）
    paor-prompts.ts     # フェーズ対応プロンプトビルダー
    instinct-retriever.ts # プロアクティブ学習パターン検索
    failure-classifier.ts # エラー分類と自動再計画トリガー
    autonomy/           # エラーリカバリ、タスク計画、自己検証
    context/            # システムプロンプト（Strada.Core ナレッジベース）
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + その他
    tools/              # 30+ ツール実装（ask_user, show_plan, switch_personality 等）
    soul/               # SOUL.md 性格ローダー（ホットリロードとチャネル別オーバーライド付き）
    plugins/            # 外部プラグインローダー
  profiles/             # 性格プロファイルファイル：casual.md, formal.md, minimal.md
  channels/
    telegram/           # Grammy ベースのボット
    discord/            # discord.js ボット（スラッシュコマンド付き）
    slack/              # Slack Bolt（ソケットモード）+ Block Kit
    whatsapp/           # Baileys ベースのクライアント（セッション管理付き）
    web/                # Express + WebSocket Web チャネル
    cli/                # Readline REPL
  web-portal/           # React + Vite チャット UI（ダーク/ライトテーマ、ファイルアップロード、ストリーミング、ダッシュボードタブ、サイドパネル）
  memory/
    file-memory-manager.ts   # レガシーバックエンド：JSON + TF-IDF（フォールバック）
    unified/
      agentdb-memory.ts      # アクティブバックエンド：SQLite + HNSW、3 層オートティアリング
      agentdb-adapter.ts     # AgentDBMemory 用 IMemoryManager アダプター
      migration.ts           # レガシー FileMemoryManager -> AgentDB マイグレーション
      consolidation-engine.ts # アイドル時メモリ統合（HNSW クラスタリング）
      consolidation-types.ts  # 統合の型定義とインターフェース
    decay/                    # 指数関数的メモリ減衰システム
  rag/
    rag-pipeline.ts     # インデックス + 検索 + フォーマットのオーケストレーション
    chunker.ts          # C# 固有の構造的チャンキング
    hnsw/               # HNSW ベクトルストア（hnswlib-node）
    embeddings/         # OpenAI および Ollama エンベディングプロバイダー
    reranker.ts         # 重み付きリランキング（ベクトル + キーワード + 構造）
  learning/
    pipeline/
      learning-pipeline.ts  # パターン検出、直感の作成、進化提案
      learning-queue.ts     # イベント駆動学習用シリアル非同期プロセッサー
      embedding-queue.ts    # バウンド付き非同期エンベディング生成
    scoring/
      confidence-scorer.ts  # ハイブリッド加重信頼度（5要素）、Elo、Wilson 区間
    matching/
      pattern-matcher.ts    # キーワード + セマンティックパターンマッチング
    hooks/
      error-learning-hooks.ts  # エラー/解決キャプチャフック
    storage/
      learning-storage.ts  # 直感、トラジェクトリ、パターンの SQLite ストレージ
      migrations/          # スキーママイグレーション（クロスセッション出所）
    chains/
      chain-detector.ts    # 繰り返しツールシーケンスの検出
      chain-synthesizer.ts # LLM ベースのコンポジットツール生成
      composite-tool.ts    # 実行可能なコンポジットツール
      chain-validator.ts   # 合成後の検証、ランタイムフィードバック
      chain-manager.ts     # フルライフサイクルオーケストレーター
  multi-agent/
    agent-manager.ts    # マルチエージェントライフサイクルとセッション分離
    agent-budget-tracker.ts  # エージェント別予算追跡
    agent-registry.ts   # アクティブエージェントの中央レジストリ
  delegation/
    delegation-manager.ts    # 委任ライフサイクル管理
    delegation-tool.ts       # エージェント向け委任ツール
    tier-router.ts           # 4 段階タスクルーティング
  goals/
    goal-decomposer.ts  # DAG ベースのゴール分解（プロアクティブ + リアクティブ）
    goal-executor.ts    # 失敗バジェット付きウェーブベース並列実行
    goal-validator.ts   # カーンのアルゴリズムによる DAG 循環検出
    goal-storage.ts     # ゴールツリーの SQLite 永続化
    goal-progress.ts    # 進捗追跡とレポーティング
    goal-resume.ts      # 再起動後の中断されたゴールツリーの再開
    goal-renderer.ts    # ゴールツリーの可視化
  daemon/
    heartbeat-loop.ts   # コアのティック-評価-発火ループ
    trigger-registry.ts # トリガーの登録とライフサイクル
    daemon-storage.ts   # デーモン状態の SQLite 永続化
    daemon-events.ts    # デーモンサブシステムの型付きイベント定義
    daemon-cli.ts       # デーモン管理用 CLI コマンド
    budget/
      budget-tracker.ts # 日次 USD 予算追跡
    resilience/
      circuit-breaker.ts # トリガーごとのサーキットブレーカー（指数バックオフ付き）
    security/
      daemon-security-policy.ts  # デーモン用ツール承認要件
      approval-queue.ts          # 有効期限付き承認リクエストキュー
    dedup/
      trigger-deduplicator.ts    # コンテンツ + クールダウン重複排除
    triggers/
      cron-trigger.ts        # Cron 式スケジューリング
      file-watch-trigger.ts  # ファイルシステム変更監視
      checklist-trigger.ts   # 期限付きチェックリスト項目
      webhook-trigger.ts     # HTTP POST Webhook エンドポイント
      deploy-trigger.ts      # 承認ゲート付きデプロイメント条件トリガー
    deployment/
      deployment-executor.ts # ロールバック付きデプロイメント実行
      readiness-checker.ts   # デプロイメント前準備状態検証
    reporting/
      notification-router.ts # 緊急度ベースの通知ルーティング
      digest-reporter.ts     # 定期サマリーダイジェスト生成
      digest-formatter.ts    # チャネル向けダイジェストレポートのフォーマット
      quiet-hours.ts         # 非クリティカル通知のバッファリング
  identity/
    identity-state.ts   # 永続エージェントアイデンティティ（UUID、起動回数、稼働時間）
    crash-recovery.ts   # クラッシュ検出とリカバリコンテキスト
  tasks/
    task-manager.ts     # タスクライフサイクル管理
    task-storage.ts     # タスクの SQLite 永続化
    background-executor.ts # ゴール統合付きバックグラウンドタスク実行
    message-router.ts   # オーケストレーターへのメッセージルーティング
    command-detector.ts # スラッシュコマンド検出
    command-handler.ts  # コマンド実行
  metrics/
    metrics-storage.ts  # メトリクスの SQLite ストレージ
    metrics-recorder.ts # セッションごとのメトリクスキャプチャ
    metrics-cli.ts      # CLI メトリクス表示コマンド
  utils/
    media-processor.ts  # メディアダウンロード、検証（MIME/サイズ/マジックバイト）、SSRF 保護
  security/             # 認証、RBAC、パスガード、レートリミッター、シークレットサニタイザー
  intelligence/         # C# パース、プロジェクト分析、コード品質
  dashboard/            # HTTP、WebSocket、Prometheus ダッシュボード
  config/               # Zod バリデーション付き環境設定
  validation/           # 入力バリデーションスキーマ
```

---

## 貢献

開発環境のセットアップ、コード規約、PR ガイドラインについては [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

---

## ライセンス

MIT ライセンス - 詳細は [LICENSE](LICENSE) を参照してください。
