<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>AI駆動のUnity開発エージェント</strong><br/>
  インテリジェントなコード生成、分析、マルチチャネルコラボレーションでStrata.Coreワークフローを自動化します。
</p>

<p align="center">
  <a href="https://github.com/yourusername/strata-brain/releases"><img src="https://img.shields.io/github/v/release/yourusername/strata-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/yourusername/strata-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/strata-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/テスト-600%2B-green?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/カバレッジ-85%25-brightgreen?style=flat-square" alt="Coverage">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="README.zh.md">中文</a> •
  <a href="README.ko.md">한국어</a> •
  <a href="README.tr.md">Türkçe</a> •
  <a href="README.de.md">Deutsch</a> •
  <a href="README.es.md">Español</a> •
  <a href="README.fr.md">Français</a>
</p>

---

## ✨ 主な機能

### 🤖 AI駆動の開発
- **スマートコード生成** - モジュール、システム、コンポーネント、メディエーターを自動生成
- **セマンティックコード検索** - HNSWベクトル検索で150倍高速（ブルートフォース比）
- **エクスペリエンスリプレイ学習** - 過去のインタラクションから学習し、継続的に改善
- **マルチプロバイダーAI** - Claude、OpenAI、DeepSeek、Groq、その他10以上の互換プロバイダー

### 💬 マルチチャネルサポート
お気に入りのプラットフォームでStrata.Brainと通信：
- **Telegram** - 外出先でのモバイルファースト開発
- **Discord** - リッチ埋め込みを使用したチームコラボレーション
- **Slack** - エンタープライズワークフロー統合
- **WhatsApp** - 迅速な修正とステータスチェック
- **CLI** - 直接ターミナルアクセス

### 🎮 Unity/Strata.Core統合
- **プロジェクト分析** - コードベース全体の構造をマッピング
- **ビルド自動化** - コンパイルエラーを自動修正
- **コード品質** - Strata.Coreパターンとベストプラクティスを強制
- **アーキテクチャ可視化** - 複雑なシステムを即座に理解

### 🔒 エンタープライズセキュリティ
- **RBAC** - ロールベースのアクセス制御（5ロール、14リソースタイプ）
- **シークレットサニタイゼーション** - 18パターンチャネルの自動マスキング
- **監査ログ** - 完全なアクティビティ追跡
- **読み取り専用モード** - 変更なしで安全に探索

### 📊 監視と運用
- **リアルタイムダッシュボード** - WebSocket駆動のライブメトリクス
- **Prometheus統合** - メトリクスをスタックにエクスポート
- **スマートアラート** - Discord、Slack、Email、Telegram、PagerDuty
- **自動バックアップ** - スケジュール + オンデマンドバックアップ

---

## 🚀 クイックスタート

### 前提条件
- Node.js >= 20.0.0
- Strata.Coreを使用するUnityプロジェクト
- ANTHROPIC_API_KEY（または他のAIプロバイダー）

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# 依存関係をインストール
npm install

# 環境を設定
cp .env.example .env
# .envを編集して設定

# 開発を開始
npm run dev
```

### Docker（本番環境に推奨）

```bash
# ワンコマンドデプロイ
./scripts/deploy.sh

# または手動で
docker-compose up -d
```

---

## 📖 使用例

### 新しいモジュールを生成

**Telegram:**
```
@StrataBrain アイテム、スロット、重量システムを含むインベントリモジュールを作成
```

**Discord:**
```
!create-module PlayerStats Health、Mana、Stamina属性を含む
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI patrol、attack、flee動作を含む
```

### プロジェクトを分析

```
@StrataBrain 私のプロジェクトを分析し、戦闘システムについて教えて
```

応答：
```
📊 プロジェクト分析

戦闘システムの位置：
├── 📁 Modules/Combat/
│   ├── CombatModule.cs（エントリポイント）
│   ├── Systems/
│   │   ├── DamageSystem.cs（ダメージ適用）
│   │   └── CombatStateSystem.cs（状態管理）
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 主要な洞察：
• Healthは3箇所で変更される
• ダメージ値に検証がない
• CombatStateSystemにnullチェックが欠落
```

### セマンティック検索

```
@StrataBrain 検索 "ダメージを受けたときにプレイヤーの体力が変更される場所"
```

関連するコードスニペットとファイルの場所を含む結果を数秒で返します。

---

## 🏗️ アーキテクチャ

```
┌─────────────────────────────────────────┐
│  プレゼンテーションレイヤー（5チャネル） │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  オーケストレーションレイヤー           │
│  セッションマネージャー • レートリミッタ│
│  自律性：PLAN-ACT-VERIFY-RESPOND       │
├─────────────────────────────────────────┤
│  サービスレイヤー                       │
│  AIプロバイダーチェーン • 25+ツール     │
│  HNSWベクトル検索 • 学習システム        │
├─────────────────────────────────────────┤
│  インフラストラクチャレイヤー           │
│  DIコンテナ • セキュリティ（RBAC）      │
│  認証 • 設定 • ロギング                 │
└─────────────────────────────────────────┘
```

---

## 🧪 テスト

```bash
# すべてのテストを実行
npm test

# カバレッジ付きで実行
npm run test:coverage

# 統合テストを実行
npm run test:integration
```

**テストカバレッジ：**
- 600+ ユニットテスト
- 51 統合テスト（E2E）
- 85%+ コードカバレッジ

---

## 📚 ドキュメント

- [📖 入門ガイド](docs/getting-started.ja.md)
- [🏗️ アーキテクチャ概要](docs/architecture.ja.md)
- [🔧 設定リファレンス](docs/configuration.ja.md)
- [🔒 セキュリティガイド](docs/security/security-overview.ja.md)
- [🛠️ ツール開発](docs/tools.ja.md)
- [📊 APIリファレンス](docs/api.ja.md)

---

## 🛡️ セキュリティ

Strata.Brainは包括的なセキュリティ対策を実装しています：

- ✅ **OWASP Top 10** 準拠
- ✅ **RBAC** 5ロール（スーパーアドミンから閲覧者まで）
- ✅ **18シークレットパターン** の検出とマスキング
- ✅ **パストラバーサル** 保護
- ✅ **レートリミット** 予算追跡付き
- ✅ **監査ログ** すべてのアクションを記録
- ✅ **ペネトレーションテストスクリプト** 含む

詳細は[セキュリティドキュメント](docs/security/security-overview.ja.md)を参照してください。

---

## 🌍 多言語サポート

Strata.Brainはあなたの言語を話します：

| 言語 | ファイル | ステータス |
|------|----------|-----------|
| 🇺🇸 English | [README.md](README.md) | ✅ 完了 |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ 完了 |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ 完了 |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ 完了 |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ 完了 |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ 完了 |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ 完了 |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ 完了 |

---

## 🤝 貢献

貢献を歓迎します！詳細は[貢献ガイド](CONTRIBUTING.ja.md)を参照してください。

```bash
# Forkとクローン
git clone https://github.com/yourusername/strata-brain.git

# ブランチを作成
git checkout -b feature/amazing-feature

# 変更をコミット
git commit -m "素晴らしい機能を追加"

# プッシュしてPRを作成
git push origin feature/amazing-feature
```

---

## 📜 ライセンス

MITライセンス - 詳細は[LICENSE](LICENSE)ファイルを参照してください。

---

## 💖 謝辞

- [Strata.Core](https://github.com/strata/core) - すべてを動かすECSフレームワーク
- [Grammy](https://grammy.dev) - Telegramボットフレームワーク
- [Discord.js](https://discord.js.org) - Discord統合
- [HNSWLib](https://github.com/nmslib/hnswlib) - 高性能ベクトル検索

---

<p align="center">
  <strong>🚀 Unity開発をスーパーチャージする準備はできましたか？</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ GitHubでスターを付ける</a> •
  <a href="https://twitter.com/stratabrain">🐦 Twitterでフォロー</a> •
  <a href="https://discord.gg/stratabrain">💬 Discordに参加</a>
</p>

<p align="center">
  Strataチームが❤️を込めて構築
</p>
