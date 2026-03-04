<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Unity / Strada.Core プロジェクト向け AI 開発エージェント</strong><br/>
  Telegram、Discord、Slack、WhatsApp、またはターミナルに接続する自律型コーディングエージェント &mdash; コードベースを読み取り、コードを書き、ビルドを実行し、エラーから学習します。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.zh.md">中文</a> |
  <strong>日本語</strong> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

---

## これは何ですか？

Strada.Brain は、チャットチャネルを通じて対話する AI エージェントです。やりたいことを記述するだけで &mdash; 「プレイヤー移動用の新しい ECS システムを作成」や「health を使用しているすべてのコンポーネントを探して」&mdash; エージェントが C# プロジェクトを読み取り、コードを書き、`dotnet build` を実行し、エラーを自動修正し、結果を返します。永続的なメモリを持ち、過去のエラーから学習し、自動フェイルオーバー付きの複数 AI プロバイダーを使用できます。

**これはライブラリでも API でもありません。** スタンドアロンのアプリケーションとして実行します。チャットプラットフォームに接続し、ディスク上の Unity プロジェクトを読み取り、設定した範囲内で自律的に動作します。

---

## クイックスタート

### 前提条件

- **Node.js 20+** および npm
- **Anthropic API キー**（Claude）&mdash; 他のプロバイダーはオプション
- **Unity プロジェクト**（Strada.Core フレームワーク使用。エージェントに渡すパス）

### 1. インストール

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. 設定

```bash
cp .env.example .env
```

`.env` を開き、最低限以下を設定してください：

```env
ANTHROPIC_API_KEY=sk-ant-...      # Claude API キー
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Assets/ を含む必要あり
JWT_SECRET=<生成方法: openssl rand -hex 64>
```

### 3. 実行

```bash
# Web チャネル（デフォルト） - セットアップウィザードが localhost:3000 で開く
# .env が存在しない場合、ウィザードが初期セットアップをガイド
npm start

# または明示的に Web チャネルで実行
npm run dev -- start --channel web

# インタラクティブ CLI モード（最も手軽なテスト方法）
npm run dev -- cli

# またはチャットチャネル経由で
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. 対話する

実行後、設定したチャネルからメッセージを送信します：

```
> プロジェクト構造を分析して
> DamageSystem と HealthComponent を含む "Combat" という新しいモジュールを作成して
> PositionComponent をクエリするすべてのシステムを探して
> ビルドを実行してエラーを修正して
```

**Web チャネル：** ターミナルは不要です &mdash; `localhost:3000` の Web ダッシュボードを通じて操作します。

---

## アーキテクチャ

```
+-----------------------------------------------------------------+
|  チャットチャネル                                                 |
|  Telegram | Discord | Slack | WhatsApp | CLI                    |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter インターフェース
                               |
+------------------------------v----------------------------------+
|  オーケストレーター（エージェントループ）                         |
|  システムプロンプト + メモリ + RAG コンテキスト -> LLM -> ツール呼び出し |
|  メッセージあたり最大 50 回のツール反復                           |
|  自律性：エラー回復、停滞検出、ビルド検証                        |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| AI プロバイダー |  | 30+ ツール     |  | コンテキストソース  |
| Claude（主要） |  | ファイル I/O   |  | メモリ（TF-IDF）   |
| OpenAI, Kimi   |  | Git 操作       |  | RAG（HNSW ベクトル）|
| DeepSeek, Qwen |  | シェル実行     |  | プロジェクト分析    |
| MiniMax, Groq  |  | .NET ビルド/テスト|  | 学習パターン      |
| Ollama（ローカル）|  | ブラウザ      |  +--------------------+
| + 他 4 つ      |  | Strata コード生成|
+----------------+  +----------------+
```

### エージェントループの仕組み

1. **メッセージ受信** — チャットチャネルからメッセージが到着
2. **メモリ検索** — TF-IDF で最も関連性の高い過去の会話 3 件を取得
3. **RAG 検索** — C# コードベースに対するセマンティック検索（HNSW ベクトル、上位 6 件）
4. **キャッシュ済み分析** — 以前に分析済みのプロジェクト構造を注入
5. **LLM 呼び出し** — システムプロンプト + コンテキスト + ツール定義を送信
6. **ツール実行** — LLM がツールを呼び出した場合、実行して結果を LLM にフィードバック
7. **自律チェック** — エラー回復が失敗を分析、停滞検出器がスタック時に警告、`.cs` ファイルが変更された場合は応答前に `dotnet build` を強制実行
8. **繰り返し** — LLM が最終テキスト応答を生成するまで最大 50 回反復
9. **応答送信** — チャネルを通じてユーザーに応答（ストリーミング対応の場合はストリーミング）

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

OpenAI 互換の任意のプロバイダーが動作します。以下のプロバイダーはすべて実装済みで、API キーを設定するだけで有効になります。

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

**プロバイダーチェーン：** `PROVIDER_CHAIN` にプロバイダー名のカンマ区切りリストを設定します。システムは順番に試行し、失敗した場合は次にフォールバックします。例：`PROVIDER_CHAIN=kimi,deepseek,claude` は Kimi を最初に使用し、Kimi が失敗すれば DeepSeek、次に Claude を使用します。

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
| `DISCORD_CLIENT_ID` | Discord アプリケーションクライアント ID |
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
| `WHATSAPP_ALLOWED_NUMBERS` | カンマ区切りの電話番号 |

### 機能

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `RAG_ENABLED` | `true` | C# プロジェクトに対するセマンティックコード検索を有効化 |
| `EMBEDDING_PROVIDER` | `openai` | エンベディングプロバイダー：`openai` または `ollama` |
| `MEMORY_ENABLED` | `true` | 永続的な会話メモリを有効化 |
| `MEMORY_DB_PATH` | `.strata-memory` | メモリデータベースファイルのディレクトリ |
| `WEB_CHANNEL_PORT` | `3000` | Web ダッシュボードのポート |
| `DASHBOARD_ENABLED` | `false` | HTTP モニタリングダッシュボードを有効化 |
| `DASHBOARD_PORT` | `3001` | ダッシュボードサーバーポート |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket リアルタイムダッシュボードを有効化 |
| `ENABLE_PROMETHEUS` | `false` | Prometheus メトリクスエンドポイントを有効化（ポート 9090） |
| `READ_ONLY_MODE` | `false` | すべての書き込み操作をブロック |
| `LOG_LEVEL` | `info` | `error`、`warn`、`info`、または `debug` |

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

エージェントにはカテゴリ別に整理された 30 以上の組み込みツールがあります：

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
| `code_search` | RAG によるセマンティック/ベクトル検索 &mdash; 自然言語クエリ |
| `memory_search` | 永続的な会話メモリの検索 |

### Strada コード生成
| ツール | 説明 |
|--------|------|
| `strata_analyze_project` | C# プロジェクト全体のスキャン &mdash; モジュール、システム、コンポーネント、サービス |
| `strata_create_module` | 完全なモジュールスキャフォールド生成（`.asmdef`、設定、ディレクトリ） |
| `strata_create_component` | フィールド定義付き ECS コンポーネント構造体の生成 |
| `strata_create_mediator` | コンポーネントバインディング付き `EntityMediator<TView>` の生成 |
| `strata_create_system` | `SystemBase`/`JobSystemBase`/`SystemGroup` の生成 |

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

### その他
| ツール | 説明 |
|--------|------|
| `shell_exec` | シェルコマンドの実行（30 秒タイムアウト、危険なコマンドのブロックリスト） |
| `code_quality` | ファイル単位またはプロジェクト単位のコード品質分析 |
| `rag_index` | インクリメンタルまたはフルプロジェクトの再インデックスをトリガー |

---

## チャネル機能

| 機能 | Telegram | Discord | Slack | WhatsApp | CLI |
|------|----------|---------|-------|----------|-----|
| テキストメッセージ | 対応 | 対応 | 対応 | 対応 | 対応 |
| ストリーミング（インプレース編集） | 対応 | 対応 | 対応 | 対応 | 対応 |
| 入力中インジケーター | 対応 | 対応 | 非対応 | 対応 | 非対応 |
| 確認ダイアログ | 対応（インラインキーボード） | 対応（ボタン） | 対応（Block Kit） | 対応（番号付き返信） | 対応（readline） |
| ファイルアップロード | 非対応 | 非対応 | 対応 | 対応 | 非対応 |
| スレッドサポート | 非対応 | 対応 | 対応 | 非対応 | 非対応 |
| レートリミッター（送信側） | 非対応 | 対応（トークンバケット） | 対応（4 段階スライディングウィンドウ） | インラインスロットル | 非対応 |

### ストリーミング

すべてのチャネルでインプレース編集によるストリーミングを実装しています。LLM が生成するにつれて、エージェントの応答がプログレッシブに表示されます。レート制限を回避するため、プラットフォームごとに更新頻度が制御されています（WhatsApp/Discord：1回/秒、Slack：2回/秒）。

### 認証

- **Telegram**：デフォルトで全拒否。`ALLOWED_TELEGRAM_USER_IDS` の設定が必要。
- **Discord**：デフォルトで全拒否。`ALLOWED_DISCORD_USER_IDS` または `ALLOWED_DISCORD_ROLE_IDS` の設定が必要。
- **Slack**：**デフォルトで全開放。** `ALLOWED_SLACK_USER_IDS` が空の場合、すべての Slack ユーザーがボットにアクセス可能。本番環境では許可リストを設定してください。
- **WhatsApp**：アダプター内でローカルにチェックされる `WHATSAPP_ALLOWED_NUMBERS` 許可リストを使用。

---

## メモリシステム

本番用メモリバックエンドは `FileMemoryManager` です &mdash; JSON ファイルと TF-IDF テキストインデックスによる検索。

**仕組み：**
- セッション履歴が 40 メッセージを超えると、古いメッセージが要約されて会話エントリとして保存
- 各 LLM 呼び出し前に、エージェントが最も関連性の高いメモリ 3 件を自動的に取得
- `strata_analyze_project` ツールがプロジェクト構造分析をキャッシュし、即座にコンテキスト注入
- メモリは `MEMORY_DB_PATH` ディレクトリ（デフォルト：`.strata-memory/`）に永続化され、再起動後も保持

**高度なバックエンド（実装済み、未接続）：** `AgentDBMemory` &mdash; SQLite + HNSW ベクトル検索、3 層メモリ（ワーキング/一時/永続）、ハイブリッド検索（70% セマンティック + 30% TF-IDF）。完全にコーディング済みですが、ブートストラップでは接続されていません。`FileMemoryManager` がアクティブなバックエンドです。

---

## RAG パイプライン

RAG（検索拡張生成）パイプラインは、C# ソースコードをインデックス化してセマンティック検索を可能にします。

**インデックスフロー：**
1. Unity プロジェクト内の `**/*.cs` ファイルをスキャン
2. コードを構造的にチャンク分割 &mdash; ファイルヘッダー、クラス、メソッド、コンストラクター
3. OpenAI（`text-embedding-3-small`）または Ollama（`nomic-embed-text`）でエンベディングを生成
4. 高速な近似最近傍検索のため HNSW インデックスにベクトルを格納
5. 起動時にバックグラウンドで自動実行（ノンブロッキング）

**検索フロー：**
1. クエリを同じプロバイダーでエンベディング
2. HNSW 検索が `topK * 3` 候補を返却
3. リランカーがスコアリング：ベクトル類似度（60%）+ キーワードオーバーラップ（25%）+ 構造ボーナス（15%）
4. スコア 0.2 以上の上位 6 件が LLM コンテキストに注入

**注意：** RAG パイプラインは現在 C# ファイルのみをサポートしています。チャンカーは C# 専用です。

---

## 学習システム

学習システムはエージェントの動作を観察し、エラーから学習します：

- **エラーパターン** が全文検索インデックス付きでキャプチャされる
- **解決策** がエラーパターンに紐付けられ、将来の検索に利用
- **インスティンクト** はベイズ信頼度スコア付きの原子的な学習済み動作
- **トラジェクトリ** はツール呼び出しのシーケンスと結果を記録
- 信頼度スコアは統計的妥当性のため **Elo レーティング** と **Wilson スコアインターバル** を使用
- 信頼度 0.3 未満のインスティンクトは非推奨、0.9 以上は昇格候補

学習パイプラインはタイマーで実行：パターン検出は 5 分ごと、進化提案は 1 時間ごと。データは専用の SQLite データベース（`learning.db`）に格納されます。

---

## セキュリティ

### レイヤー 1：チャネル認証
プラットフォーム固有の許可リストがメッセージ到着時（あらゆる処理の前）にチェックされます。

### レイヤー 2：レート制限
ユーザーごとのスライディングウィンドウ（分/時間）+ グローバルな日次/月次トークンおよび USD 予算上限。

### レイヤー 3：パスガード
すべてのファイル操作でシンボリックリンクを解決し、パスがプロジェクトルート内に収まることを検証。30 以上の機密パターンをブロック（`.env`、`.git/credentials`、SSH キー、証明書、`node_modules/`）。

### レイヤー 4：シークレットサニタイザー
24 種類の正規表現パターンが、すべてのツール出力において LLM に到達する前に認証情報を検出しマスクします。対象：OpenAI キー、GitHub トークン、Slack/Discord/Telegram トークン、AWS キー、JWT、Bearer 認証、PEM キー、データベース URL、汎用シークレットパターン。

### レイヤー 5：読み取り専用モード
`READ_ONLY_MODE=true` の場合、23 個の書き込みツールがエージェントのツールリストから完全に除外されます &mdash; LLM はそれらを呼び出すことすらできません。

### レイヤー 6：操作確認
書き込み操作（ファイル書き込み、Git コミット、シェル実行）は、チャネルのインタラクティブ UI（ボタン、インラインキーボード、テキストプロンプト）を通じてユーザー確認を要求できます。

### レイヤー 7：ツール出力のサニタイズ
すべてのツール結果は 8192 文字に制限され、LLM にフィードバックする前に API キーパターンがスクラブされます。

### レイヤー 8：RBAC（内部）
5 つのロール（superadmin、admin、developer、viewer、service）と 9 種類のリソースタイプをカバーする権限マトリクス。ポリシーエンジンは時間ベース、IP ベース、カスタム条件をサポートします。

---

## ダッシュボードとモニタリング

### HTTP ダッシュボード（`DASHBOARD_ENABLED=true`）
`http://localhost:3001` でアクセス可能（localhost のみ）。表示内容：稼働時間、メッセージ数、トークン使用量、アクティブセッション、ツール使用状況テーブル、セキュリティ統計。3 秒ごとに自動更新。

### ヘルスエンドポイント
- `GET /health` &mdash; 生存確認プローブ（`{"status":"ok"}`）
- `GET /ready` &mdash; 詳細な準備状態：メモリとチャネルの健全性をチェック。200（準備完了）、207（劣化状態）、または 503（未準備）を返却

### Prometheus（`ENABLE_PROMETHEUS=true`）
`http://localhost:9090/metrics` でメトリクスを提供。メッセージ、ツール呼び出し、トークンのカウンター。リクエスト時間、ツール実行時間、LLM レイテンシーのヒストグラム。デフォルトの Node.js メトリクス（CPU、ヒープ、GC、イベントループ）。

### WebSocket ダッシュボード（`ENABLE_WEBSOCKET_DASHBOARD=true`）
リアルタイムメトリクスを毎秒プッシュ。認証付き接続とリモートコマンド（プラグインリロード、キャッシュクリア、ログ取得）をサポート。

---

## デプロイ

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml` にはアプリケーション、モニタリングスタック、nginx リバースプロキシが含まれています。

### デーモンモード

```bash
# クラッシュ時に指数バックオフで自動再起動（1秒〜60秒、最大10回）
node dist/index.js daemon --channel telegram
```

### 本番チェックリスト

- [ ] `NODE_ENV=production` を設定
- [ ] `LOG_LEVEL=warn` または `error` を設定
- [ ] `RATE_LIMIT_ENABLED=true` を予算上限付きで設定
- [ ] チャネル許可リストを設定（特に Slack &mdash; デフォルトで開放）
- [ ] 安全な探索のみの場合は `READ_ONLY_MODE=true` を設定
- [ ] モニタリング用に `DASHBOARD_ENABLED=true` を有効化
- [ ] メトリクス収集用に `ENABLE_PROMETHEUS=true` を有効化
- [ ] 強力な `JWT_SECRET` を生成

---

## テスト

```bash
npm test                         # 全 1560+ テストを実行
npm run test:watch               # ウォッチモード
npm test -- --coverage           # カバレッジ付き
npm test -- src/agents/tools/file-read.test.ts  # 単一ファイル
npm run typecheck                # TypeScript 型チェック
npm run lint                     # ESLint
```

94 のテストファイルがカバー：エージェント、チャネル、セキュリティ、RAG、メモリ、学習、ダッシュボード、統合フロー。

---

## プロジェクト構造

```
src/
  index.ts              # CLI エントリポイント（Commander.js）
  core/
    bootstrap.ts        # 完全な初期化シーケンス — すべての接続がここで行われる
    di-container.ts     # DI コンテナ（利用可能だが手動接続が主流）
    tool-registry.ts    # ツールのインスタンス化と登録
  agents/
    orchestrator.ts     # コアエージェントループ、セッション管理、ストリーミング
    autonomy/           # エラー回復、タスク計画、自己検証
    context/            # システムプロンプト（Strada.Core ナレッジベース）
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + その他
    tools/              # 30+ ツール実装
    plugins/            # 外部プラグインローダー
  channels/
    telegram/           # Grammy ベースのボット
    discord/            # discord.js ボット（スラッシュコマンド付き）
    slack/              # Slack Bolt（ソケットモード）+ Block Kit
    whatsapp/           # Baileys ベースのクライアント（セッション管理付き）
    cli/                # Readline REPL
  memory/
    file-memory-manager.ts   # アクティブバックエンド：JSON + TF-IDF
    unified/                 # AgentDB バックエンド：SQLite + HNSW（未接続）
  rag/
    rag-pipeline.ts     # インデックス + 検索 + フォーマットのオーケストレーション
    chunker.ts          # C# 固有の構造的チャンキング
    hnsw/               # HNSW ベクトルストア（hnswlib-node）
    embeddings/         # OpenAI および Ollama エンベディングプロバイダー
    reranker.ts         # 重み付きリランキング（ベクトル + キーワード + 構造）
  security/             # 認証、RBAC、パスガード、レートリミッター、シークレットサニタイザー
  learning/             # パターンマッチング、信頼度スコアリング、インスティンクトライフサイクル
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
