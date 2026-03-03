<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>面向 Unity / Strada.Core 项目的 AI 驱动开发代理</strong><br/>
  一个连接 Telegram、Discord、Slack、WhatsApp 或终端的自主编码代理 &mdash; 读取您的代码库、编写代码、运行构建，并从错误中学习。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">Türkçe</a> |
  <strong>中文</strong> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

---

## 这是什么？

Strada.Brain 是一个通过聊天频道与您对话的 AI 代理。您描述您想要的内容——"为玩家移动创建一个新的 ECS 系统"或"查找所有使用 health 的组件"——代理就会读取您的 C# 项目、编写代码、运行 `dotnet build`、自动修复错误，并将结果发送给您。它拥有持久记忆，能从过去的错误中学习，并可以使用多个 AI 提供商和自动故障转移。

**这不是一个库或 API。** 它是一个独立运行的应用程序。它连接到您的聊天平台，读取磁盘上的 Unity 项目，并在您配置的范围内自主运行。

---

## 快速开始

### 前提条件

- **Node.js 20+** 和 npm
- 一个 **Anthropic API 密钥**（Claude）——其他提供商为可选
- 一个包含 **Strada.Core 框架的 Unity 项目**（您提供给代理的路径）

### 1. 安装

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. 配置

```bash
cp .env.example .env
```

打开 `.env` 文件，至少设置以下内容：

```env
ANTHROPIC_API_KEY=sk-ant-...      # 您的 Claude API 密钥
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # 必须包含 Assets/
JWT_SECRET=<使用以下命令生成: openssl rand -hex 64>
```

### 3. 运行

```bash
# 交互式 CLI 模式（最快的测试方式）
npm run dev -- cli

# 或通过聊天频道
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. 与它对话

运行后，通过您配置的频道发送消息：

```
> 分析项目结构
> 创建一个名为 "Combat" 的新模块，包含 DamageSystem 和 HealthComponent
> 查找所有查询 PositionComponent 的系统
> 运行构建并修复所有错误
```

---

## 架构

```
+-----------------------------------------------------------------+
|  聊天频道                                                        |
|  Telegram | Discord | Slack | WhatsApp | CLI                    |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter 接口
                               |
+------------------------------v----------------------------------+
|  编排器（代理循环）                                               |
|  系统提示 + 记忆 + RAG 上下文 -> LLM -> 工具调用                  |
|  每条消息最多 50 次工具迭代                                       |
|  自主性：错误恢复、停滞检测、构建验证                              |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| AI 提供商      |  | 30+ 工具       |  | 上下文来源         |
| Claude（主要） |  | 文件 I/O       |  | 记忆（TF-IDF）     |
| OpenAI, Kimi   |  | Git 操作       |  | RAG（HNSW 向量）   |
| DeepSeek, Qwen |  | Shell 执行     |  | 项目分析           |
| MiniMax, Groq  |  | .NET 构建/测试 |  | 学习模式           |
| Ollama（本地） |  | 浏览器         |  +--------------------+
| + 4 个更多     |  | Strata 代码生成|
+----------------+  +----------------+
```

### 代理循环如何工作

1. **消息到达** -- 来自聊天频道
2. **记忆检索** -- 查找最相关的 3 段历史对话（TF-IDF）
3. **RAG 检索** -- 对 C# 代码库进行语义搜索（HNSW 向量，前 6 个结果）
4. **缓存分析** -- 如果之前已分析，则注入项目结构
5. **LLM 调用** -- 携带系统提示 + 上下文 + 工具定义
6. **工具执行** -- 如果 LLM 调用了工具，则执行并将结果反馈给 LLM
7. **自主性检查** -- 错误恢复分析失败原因，停滞检测器在卡住时发出警告，自我验证在修改了 `.cs` 文件时强制在响应前运行 `dotnet build`
8. **重复** -- 最多 50 次迭代，直到 LLM 产生最终文本响应
9. **发送响应** -- 通过频道发送给用户（如支持则以流式传输）

---

## 配置参考

所有配置通过环境变量完成。完整列表请参阅 `.env.example`。

### 必需项

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API 密钥（主要 LLM 提供商） |
| `UNITY_PROJECT_PATH` | Unity 项目根目录的绝对路径（必须包含 `Assets/`） |
| `JWT_SECRET` | 用于 JWT 签名的密钥。生成方式：`openssl rand -hex 64` |

### AI 提供商

任何 OpenAI 兼容的提供商均可使用。以下所有提供商已实现，只需 API 密钥即可激活。

| 变量 | 提供商 | 默认模型 |
|------|--------|----------|
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
| `OLLAMA_BASE_URL` | Ollama（本地） | `llama3` |
| `PROVIDER_CHAIN` | 故障转移顺序 | 例如 `claude,kimi,deepseek,ollama` |

**提供商链：** 将 `PROVIDER_CHAIN` 设置为以逗号分隔的提供商名称列表。系统按顺序尝试每个提供商，失败时自动切换到下一个。示例：`PROVIDER_CHAIN=kimi,deepseek,claude` 首先使用 Kimi，Kimi 失败则使用 DeepSeek，然后是 Claude。

### 聊天频道

**Telegram：**
| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | 从 @BotFather 获取的令牌 |
| `ALLOWED_TELEGRAM_USER_IDS` | 以逗号分隔的 Telegram 用户 ID（必需，为空则拒绝所有） |

**Discord：**
| 变量 | 说明 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord 机器人令牌 |
| `DISCORD_CLIENT_ID` | Discord 应用程序客户端 ID |
| `ALLOWED_DISCORD_USER_IDS` | 以逗号分隔的用户 ID（为空则拒绝所有） |
| `ALLOWED_DISCORD_ROLE_IDS` | 以逗号分隔的角色 ID，用于基于角色的访问控制 |

**Slack：**
| 变量 | 说明 |
|------|------|
| `SLACK_BOT_TOKEN` | `xoxb-...` 机器人令牌 |
| `SLACK_APP_TOKEN` | `xapp-...` 应用级令牌（用于 Socket 模式） |
| `SLACK_SIGNING_SECRET` | Slack 应用的签名密钥 |
| `ALLOWED_SLACK_USER_IDS` | 以逗号分隔的用户 ID（**为空则对所有人开放**） |
| `ALLOWED_SLACK_WORKSPACES` | 以逗号分隔的工作区 ID（**为空则对所有人开放**） |

**WhatsApp：**
| 变量 | 说明 |
|------|------|
| `WHATSAPP_SESSION_PATH` | 会话文件目录（默认：`.whatsapp-session`） |
| `WHATSAPP_ALLOWED_NUMBERS` | 以逗号分隔的电话号码 |

### 功能特性

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RAG_ENABLED` | `true` | 启用对 C# 项目的语义代码搜索 |
| `EMBEDDING_PROVIDER` | `openai` | 嵌入提供商：`openai` 或 `ollama` |
| `MEMORY_ENABLED` | `true` | 启用持久对话记忆 |
| `MEMORY_DB_PATH` | `.strata-memory` | 记忆数据库文件目录 |
| `DASHBOARD_ENABLED` | `false` | 启用 HTTP 监控仪表板 |
| `DASHBOARD_PORT` | `3001` | 仪表板服务器端口 |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | 启用 WebSocket 实时仪表板 |
| `ENABLE_PROMETHEUS` | `false` | 启用 Prometheus 指标端点（端口 9090） |
| `READ_ONLY_MODE` | `false` | 阻止所有写入操作 |
| `LOG_LEVEL` | `info` | `error`、`warn`、`info` 或 `debug` |

### 速率限制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RATE_LIMIT_ENABLED` | `false` | 启用速率限制 |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | 每用户每分钟消息限制（0 = 无限制） |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | 每用户每小时限制 |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | 全局每日令牌配额 |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | 每日支出上限（美元） |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | 每月支出上限（美元） |

### 安全

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REQUIRE_MFA` | `false` | 要求多因素认证 |
| `BROWSER_HEADLESS` | `true` | 以无头模式运行浏览器自动化 |
| `BROWSER_MAX_CONCURRENT` | `5` | 最大并发浏览器会话数 |

---

## 工具

代理拥有 30 多个按类别组织的内置工具：

### 文件操作
| 工具 | 说明 |
|------|------|
| `file_read` | 读取文件，支持行号、偏移/限制分页（512KB 限制） |
| `file_write` | 创建或覆盖文件（256KB 限制，自动创建目录） |
| `file_edit` | 带唯一性强制的搜索替换编辑 |
| `file_delete` | 删除单个文件 |
| `file_rename` | 在项目内重命名或移动文件 |
| `file_delete_directory` | 递归删除目录（50 个文件安全上限） |

### 搜索
| 工具 | 说明 |
|------|------|
| `glob_search` | 按 glob 模式查找文件（最多 50 个结果） |
| `grep_search` | 跨文件的正则表达式内容搜索（最多 20 个匹配） |
| `list_directory` | 带文件大小的目录列表 |
| `code_search` | 通过 RAG 进行语义/向量搜索——自然语言查询 |
| `memory_search` | 搜索持久对话记忆 |

### Strada 代码生成
| 工具 | 说明 |
|------|------|
| `strata_analyze_project` | 完整 C# 项目扫描——模块、系统、组件、服务 |
| `strata_create_module` | 生成完整模块脚手架（`.asmdef`、配置、目录） |
| `strata_create_component` | 生成带字段定义的 ECS 组件结构体 |
| `strata_create_mediator` | 生成带组件绑定的 `EntityMediator<TView>` |
| `strata_create_system` | 生成 `SystemBase`/`JobSystemBase`/`SystemGroup` |

### Git
| 工具 | 说明 |
|------|------|
| `git_status` | 工作树状态 |
| `git_diff` | 显示变更 |
| `git_log` | 提交历史 |
| `git_commit` | 暂存并提交 |
| `git_push` | 推送到远程 |
| `git_branch` | 列出、创建或切换分支 |
| `git_stash` | 推入、弹出、列出或丢弃暂存 |

### .NET / Unity
| 工具 | 说明 |
|------|------|
| `dotnet_build` | 运行 `dotnet build`，将 MSBuild 错误解析为结构化输出 |
| `dotnet_test` | 运行 `dotnet test`，解析通过/失败/跳过结果 |

### 其他
| 工具 | 说明 |
|------|------|
| `shell_exec` | 执行 Shell 命令（30 秒超时，危险命令黑名单） |
| `code_quality` | 按文件或按项目的代码质量分析 |
| `rag_index` | 触发增量或完整的项目重新索引 |

---

## 频道功能

| 功能 | Telegram | Discord | Slack | WhatsApp | CLI |
|------|----------|---------|-------|----------|-----|
| 文本消息 | 是 | 是 | 是 | 是 | 是 |
| 流式传输（就地编辑） | 是 | 是 | 是 | 是 | 是 |
| 输入指示器 | 是 | 是 | 无操作 | 是 | 否 |
| 确认对话框 | 是（内联键盘） | 是（按钮） | 是（Block Kit） | 是（编号回复） | 是（readline） |
| 文件上传 | 否 | 否 | 是 | 是 | 否 |
| 主题支持 | 否 | 是 | 是 | 否 | 否 |
| 速率限制（出站） | 否 | 是（令牌桶） | 是（4 层滑动窗口） | 内联节流 | 否 |

### 流式传输

所有频道都实现了就地编辑流式传输。代理的响应随 LLM 生成而逐步显示。更新按平台限流以避免速率限制（WhatsApp/Discord：1次/秒，Slack：2次/秒）。

### 身份验证

- **Telegram**：默认拒绝所有。必须设置 `ALLOWED_TELEGRAM_USER_IDS`。
- **Discord**：默认拒绝所有。必须设置 `ALLOWED_DISCORD_USER_IDS` 或 `ALLOWED_DISCORD_ROLE_IDS`。
- **Slack**：**默认对所有人开放。** 如果 `ALLOWED_SLACK_USER_IDS` 为空，任何 Slack 用户都可以访问机器人。请为生产环境设置允许列表。
- **WhatsApp**：使用在适配器中本地检查的 `WHATSAPP_ALLOWED_NUMBERS` 允许列表。

---

## 记忆系统

生产环境的记忆后端是 `FileMemoryManager`——使用 TF-IDF 文本索引进行搜索的 JSON 文件。

**工作原理：**
- 当会话历史超过 40 条消息时，旧消息被摘要并存储为对话条目
- 代理在每次 LLM 调用前自动检索最相关的 3 段记忆
- `strata_analyze_project` 工具缓存项目结构分析，用于即时上下文注入
- 记忆在 `MEMORY_DB_PATH` 目录（默认：`.strata-memory/`）中跨重启持久化

**高级后端（已实现，尚未连接）：** 基于 SQLite + HNSW 向量搜索的 `AgentDBMemory`，三层记忆（工作/临时/持久），混合检索（70% 语义 + 30% TF-IDF）。此功能已完全编码但未在启动流程中连接——`FileMemoryManager` 是当前活跃的后端。

---

## RAG 管道

RAG（检索增强生成）管道对您的 C# 源代码进行索引以支持语义搜索。

**索引流程：**
1. 扫描 Unity 项目中的 `**/*.cs` 文件
2. 对代码进行结构化分块——文件头、类、方法、构造函数
3. 通过 OpenAI（`text-embedding-3-small`）或 Ollama（`nomic-embed-text`）生成嵌入向量
4. 将向量存储在 HNSW 索引中以实现快速近似最近邻搜索
5. 启动时自动运行（后台，非阻塞）

**搜索流程：**
1. 使用相同的提供商对查询进行嵌入
2. HNSW 搜索返回 `topK * 3` 个候选项
3. 重排序器评分：向量相似度（60%）+ 关键词重叠（25%）+ 结构奖励（15%）
4. 得分超过 0.2 的前 6 个结果被注入 LLM 上下文

**注意：** RAG 管道目前仅支持 C# 文件。分块器是 C# 特定的。

---

## 学习系统

学习系统观察代理行为并从错误中学习：

- **错误模式** 通过全文搜索索引被捕获
- **解决方案** 与错误模式关联以便未来检索
- **本能** 是具有贝叶斯置信度分数的原子化已学习行为
- **轨迹** 记录工具调用序列及其结果
- 置信度分数使用 **Elo 评分** 和 **Wilson 分数区间** 确保统计有效性
- 置信度低于 0.3 的本能被弃用；高于 0.9 的被提议晋升

学习管道按定时器运行：每 5 分钟进行模式检测，每小时进行演化提议。数据存储在单独的 SQLite 数据库（`learning.db`）中。

---

## 安全

### 第 1 层：频道身份验证
在消息到达时（任何处理之前）检查的平台特定允许列表。

### 第 2 层：速率限制
每用户滑动窗口（分钟/小时）+ 全局每日/每月令牌和美元预算上限。

### 第 3 层：路径守卫
每个文件操作都解析符号链接并验证路径保持在项目根目录内。30 多个敏感模式被阻止（`.env`、`.git/credentials`、SSH 密钥、证书、`node_modules/`）。

### 第 4 层：密钥清洗器
24 个正则表达式模式在所有工具输出到达 LLM 之前检测并遮罩凭据。涵盖：OpenAI 密钥、GitHub 令牌、Slack/Discord/Telegram 令牌、AWS 密钥、JWT、Bearer 认证、PEM 密钥、数据库 URL 和通用密钥模式。

### 第 5 层：只读模式
当 `READ_ONLY_MODE=true` 时，23 个写入工具从代理的工具列表中完全移除——LLM 甚至无法尝试调用它们。

### 第 6 层：操作确认
写入操作（文件写入、git 提交、Shell 执行）可以通过频道的交互式 UI（按钮、内联键盘、文本提示）要求用户确认。

### 第 7 层：工具输出清洗
所有工具结果被限制在 8192 个字符以内，并在反馈给 LLM 之前清除 API 密钥模式。

### 第 8 层：RBAC（内部）
5 个角色（superadmin、admin、developer、viewer、service），权限矩阵涵盖 9 种资源类型。策略引擎支持基于时间、基于 IP 和自定义条件。

---

## 仪表板与监控

### HTTP 仪表板（`DASHBOARD_ENABLED=true`）
通过 `http://localhost:3001` 访问（仅限本地）。显示：运行时间、消息计数、令牌使用量、活跃会话、工具使用表、安全统计。每 3 秒自动刷新。

### 健康端点
- `GET /health` —— 存活探针（`{"status":"ok"}`）
- `GET /ready` —— 深度就绪检查：检查记忆和频道健康状况。返回 200（就绪）、207（降级）或 503（未就绪）

### Prometheus（`ENABLE_PROMETHEUS=true`）
指标位于 `http://localhost:9090/metrics`。消息、工具调用、令牌的计数器。请求持续时间、工具持续时间、LLM 延迟的直方图。默认 Node.js 指标（CPU、堆内存、GC、事件循环）。

### WebSocket 仪表板（`ENABLE_WEBSOCKET_DASHBOARD=true`）
每秒推送的实时指标。支持认证连接和远程命令（插件重载、缓存清除、日志检索）。

---

## 部署

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml` 包含应用程序、监控栈和 nginx 反向代理。

### 守护进程模式

```bash
# 崩溃时自动重启，指数退避（1秒到60秒，最多10次重启）
node dist/index.js daemon --channel telegram
```

### 生产环境清单

- [ ] 设置 `NODE_ENV=production`
- [ ] 设置 `LOG_LEVEL=warn` 或 `error`
- [ ] 配置 `RATE_LIMIT_ENABLED=true` 并设置预算上限
- [ ] 设置频道允许列表（特别是 Slack——默认开放）
- [ ] 如果只需安全浏览，设置 `READ_ONLY_MODE=true`
- [ ] 启用 `DASHBOARD_ENABLED=true` 用于监控
- [ ] 启用 `ENABLE_PROMETHEUS=true` 用于指标收集
- [ ] 生成一个强 `JWT_SECRET`

---

## 测试

```bash
npm test                         # 运行全部 1560+ 测试
npm run test:watch               # 监视模式
npm test -- --coverage           # 带覆盖率
npm test -- src/agents/tools/file-read.test.ts  # 单个文件
npm run typecheck                # TypeScript 类型检查
npm run lint                     # ESLint
```

94 个测试文件覆盖：代理、频道、安全、RAG、记忆、学习、仪表板、集成流程。

---

## 项目结构

```
src/
  index.ts              # CLI 入口点（Commander.js）
  core/
    bootstrap.ts        # 完整初始化序列——所有连接在此完成
    di-container.ts     # DI 容器（可用但手动连接为主）
    tool-registry.ts    # 工具实例化和注册
  agents/
    orchestrator.ts     # 核心代理循环、会话管理、流式传输
    autonomy/           # 错误恢复、任务规划、自我验证
    context/            # 系统提示（Strada.Core 知识库）
    providers/          # Claude、OpenAI、Ollama、DeepSeek、Kimi、Qwen、MiniMax、Groq 等
    tools/              # 30+ 工具实现
    plugins/            # 外部插件加载器
  channels/
    telegram/           # 基于 Grammy 的机器人
    discord/            # discord.js 机器人，支持斜杠命令
    slack/              # Slack Bolt（Socket 模式），支持 Block Kit
    whatsapp/           # 基于 Baileys 的客户端，带会话管理
    cli/                # Readline REPL
  memory/
    file-memory-manager.ts   # 活跃后端：JSON + TF-IDF
    unified/                 # AgentDB 后端：SQLite + HNSW（尚未连接）
  rag/
    rag-pipeline.ts     # 索引 + 搜索 + 格式化编排
    chunker.ts          # C# 特定的结构化分块
    hnsw/               # HNSW 向量存储（hnswlib-node）
    embeddings/         # OpenAI 和 Ollama 嵌入提供商
    reranker.ts         # 加权重排序（向量 + 关键词 + 结构）
  security/             # 认证、RBAC、路径守卫、速率限制、密钥清洗
  learning/             # 模式匹配、置信度评分、本能生命周期
  intelligence/         # C# 解析、项目分析、代码质量
  dashboard/            # HTTP、WebSocket、Prometheus 仪表板
  config/               # Zod 验证的环境配置
  validation/           # 输入验证模式
```

---

## 贡献

开发环境设置、代码规范和 PR 指南请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可证

MIT 许可证 - 详情请参阅 [LICENSE](LICENSE)。
