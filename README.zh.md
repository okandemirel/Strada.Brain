<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>AI驱动的Unity开发助手</strong><br/>
  通过智能代码生成、分析和多渠道协作自动化您的Strata.Core工作流程。
</p>

<p align="center">
  <a href="https://github.com/yourusername/strata-brain/releases"><img src="https://img.shields.io/github/v/release/yourusername/strata-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/yourusername/strata-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/strata-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/测试-600%2B-green?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/覆盖率-85%25-brightgreen?style=flat-square" alt="Coverage">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="README.ja.md">日本語</a> •
  <a href="README.ko.md">한국어</a> •
  <a href="README.tr.md">Türkçe</a> •
  <a href="README.de.md">Deutsch</a> •
  <a href="README.es.md">Español</a> •
  <a href="README.fr.md">Français</a>
</p>

---

## ✨ 核心功能

### 🤖 AI驱动的开发
- **智能代码生成** - 自动生成模块、系统、组件和中介器
- **语义代码搜索** - HNSW向量搜索，速度提升150倍
- **经验回放学习** - 从过往交互中学习，持续改进
- **多供应商AI** - Claude、OpenAI、DeepSeek、Groq等10+兼容供应商

### 💬 多渠道支持
通过您喜爱的平台与Strata.Brain交流：
- **Telegram** - 移动端优先，随时随地开发
- **Discord** - 团队协作，丰富的嵌入消息
- **Slack** - 企业工作流程集成
- **WhatsApp** - 快速修复和状态检查
- **CLI** - 直接终端访问

### 🎮 Unity/Strata.Core集成
- **项目分析** - 映射整个代码库结构
- **构建自动化** - 自动修复编译错误
- **代码质量** - 强制执行Strata.Core模式和最佳实践
- **架构可视化** - 即时理解复杂系统

### 🔒 企业级安全
- **RBAC** - 基于角色的访问控制（5种角色，14种资源类型）
- **机密信息脱敏** - 18种模式类型自动遮罩
- **审计日志** - 完整的活动追踪
- **只读模式** - 安全探索，无需更改

### 📊 监控与运维
- **实时仪表板** - WebSocket驱动的实时指标
- **Prometheus集成** - 将指标导出到您的技术栈
- **智能告警** - Discord、Slack、邮件、Telegram、PagerDuty
- **自动备份** - 定时备份和按需备份

---

## 🚀 快速开始

### 环境要求
- Node.js >= 20.0.0
- 使用Strata.Core的Unity项目
- ANTHROPIC_API_KEY（或其他AI供应商密钥）

### 安装

```bash
# 克隆仓库
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# 安装依赖
npm install

# 配置环境
cp .env.example .env
# 编辑.env文件，填入您的设置

# 启动开发服务器
npm run dev
```

### Docker（生产环境推荐）

```bash
# 一键部署
./scripts/deploy.sh

# 或手动部署
docker-compose up -d
```

---

## 📖 使用示例

### 生成新模块

**Telegram:**
```
@StrataBrain 创建一个库存模块，包含物品、槽位和重量系统
```

**Discord:**
```
!create-module PlayerStats 包含生命、法力、耐力属性
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI 包含巡逻、攻击和逃跑行为
```

### 分析项目

```
@StrataBrain 分析我的项目，告诉我战斗系统的情况
```

回复示例：
```
📊 项目分析

战斗系统位置：
├── 📁 Modules/Combat/
│   ├── CombatModule.cs（入口点）
│   ├── Systems/
│   │   ├── DamageSystem.cs（应用伤害）
│   │   └── CombatStateSystem.cs（管理状态）
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 关键洞察：
• 生命值在3个位置被修改
• 伤害值没有验证
• CombatStateSystem缺少空值检查
```

### 语义搜索

```
@StrataBrain 搜索"玩家受到伤害时生命值在哪里被修改"
```

数秒内返回结果，包含相关代码片段和文件位置。

---

## 🏗️ 架构

```
┌─────────────────────────────────────────┐
│  表现层（5个渠道）                      │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  编排层                                 │
│  会话管理器 • 速率限制器                │
│  自主性：计划-执行-验证-响应            │
├─────────────────────────────────────────┤
│  服务层                                 │
│  AI供应商链 • 25+工具                   │
│  HNSW向量搜索 • 学习系统                │
├─────────────────────────────────────────┤
│  基础设施层                             │
│  DI容器 • 安全（RBAC）                  │
│  认证 • 配置 • 日志                     │
└─────────────────────────────────────────┘
```

---

## 🧪 测试

```bash
# 运行所有测试
npm test

# 运行覆盖率测试
npm run test:coverage

# 运行集成测试
npm run test:integration
```

**测试覆盖率：**
- 600+ 单元测试
- 51 集成测试（端到端）
- 85%+ 代码覆盖率

---

## 📚 文档

- [📖 入门指南](docs/getting-started.zh.md)
- [🏗️ 架构概览](docs/architecture.zh.md)
- [🔧 配置参考](docs/configuration.zh.md)
- [🔒 安全指南](docs/security/security-overview.zh.md)
- [🛠️ 工具开发](docs/tools.zh.md)
- [📊 API参考](docs/api.zh.md)

---

## 🛡️ 安全

Strata.Brain实施全面的安全措施：

- ✅ **OWASP Top 10** 合规
- ✅ **RBAC** 包含5种角色（从超级管理员到查看者）
- ✅ **18种机密模式** 检测和遮罩
- ✅ **路径遍历** 防护
- ✅ **速率限制** 配合预算追踪
- ✅ **审计日志** 记录所有操作
- ✅ **渗透测试脚本** 已包含

详情参见[安全文档](docs/security/security-overview.zh.md)。

---

## 🌍 多语言支持

Strata.Brain支持您的语言：

| 语言 | 文件 | 状态 |
|------|------|------|
| 🇺🇸 English | [README.md](README.md) | ✅ 完整 |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ 完整 |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ 完整 |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ 完整 |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ 完整 |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ 完整 |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ 完整 |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ 完整 |

---

## 🤝 贡献

我们欢迎贡献！详情请参阅我们的[贡献指南](CONTRIBUTING.zh.md)。

```bash
# Fork并克隆
git clone https://github.com/yourusername/strata-brain.git

# 创建分支
git checkout -b feature/amazing-feature

# 提交更改
git commit -m "添加惊艳功能"

# 推送并创建PR
git push origin feature/amazing-feature
```

---

## 📜 许可证

MIT许可证 - 详见[LICENSE](LICENSE)文件。

---

## 💖 致谢

- [Strata.Core](https://github.com/strata/core) - 提供动力的ECS框架
- [Grammy](https://grammy.dev) - Telegram机器人框架
- [Discord.js](https://discord.js.org) - Discord集成
- [HNSWLib](https://github.com/nmslib/hnswlib) - 高性能向量搜索

---

<p align="center">
  <strong>🚀 准备好加速您的Unity开发了吗？</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ GitHub上给我们加星</a> •
  <a href="https://twitter.com/stratabrain">🐦 Twitter关注我们</a> •
  <a href="https://discord.gg/stratabrain">💬 加入Discord</a>
</p>

<p align="center">
  用❤️由Strata团队构建
</p>
