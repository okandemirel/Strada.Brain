<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain 标志" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>面向 Unity / Strada.Core 项目的 AI 驱动开发代理</strong><br/>
  一个连接到 Web 仪表板、Telegram、Discord、Slack、WhatsApp 或终端的自主编码代理 &mdash; 读取您的代码库、编写代码、运行构建、从错误中学习，并通过 24/7 守护进程循环实现自主运行。现已支持多代理编排、任务委派、记忆整合、带审批门控的部署子系统、支持 LLM 视觉识别的媒体共享、通过 SOUL.md 实现的可配置个性系统，以及交互式澄清工具、支持任务感知动态切换的智能多提供商路由、基于置信度的共识验证、带 OODA 推理循环的自主 Agent Core，以及 Strada.MCP 集成。
</p>

> 翻译说明：当前运行时行为、环境变量默认值和安全语义的正本是 [README.md](README.md)。本文件是其翻译版本。

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3450%2B-brightgreen?style=flat-square" alt="测试">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="许可证">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <strong>&#20013;&#25991;</strong> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## 这是什么？

Strada.Brain 是一个通过聊天频道与您对话的 AI 代理。您描述您想要的内容——"为玩家移动创建一个新的 ECS 系统"或"查找所有使用 health 的组件"——代理就会读取您的 C# 项目、编写代码、运行 `dotnet build`、自动修复错误，并将结果发送给您。

它拥有基于 SQLite + HNSW 向量的持久记忆，通过混合加权置信度评分从过去的错误中学习，将复杂目标分解为并行 DAG 执行，自动合成多工具链并支持 saga 回滚，并可作为 24/7 守护进程运行，支持主动触发器。它支持多代理编排（按通道/会话隔离）、跨代理层级的任务委派、自动记忆整合，以及带人工审批门控和断路器保护的部署子系统。

本版本新增：Strada.Brain 现在具备 **Agent Core** —— 一个自主 OODA 推理引擎，它观察环境（文件变更、git 状态、构建结果），使用已学习的模式对优先级进行推理，并主动采取行动。**多提供商路由** 系统根据每种任务类型（规划、代码生成、调试、审查）动态选择最佳 AI 提供商，支持可配置的预设（budget/balanced/performance）。**基于置信度的共识** 系统在代理置信度较低时自动咨询第二个提供商，防止在关键操作中出错。所有功能都支持优雅降级——仅使用单个提供商时，系统与之前的行为完全一致，零额外开销。

**这不是一个库或 API。** 它是一个独立运行的应用程序。它连接到您的聊天平台，读取磁盘上的 Unity 项目，并在您配置的范围内自主运行。

---

## 快速开始

### 前提条件

- **Node.js 20.19+**（或 **22.12+**）和 npm
- 至少一个受支持的 AI 提供商凭据（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等），一个 OpenAI ChatGPT/Codex subscription 会话（`OPENAI_AUTH_MODE=chatgpt-subscription`），或者仅使用 `ollama` 的 `PROVIDER_CHAIN`
- 一个 **Unity 项目**（您提供给代理的路径）。如果希望获得完整的 Strada 框架感知帮助，建议配合 Strada.Core。

### 1. 安装

```bash
# 从源码克隆（当前的规范安装方式）
git clone https://github.com/okandemirel/Strada.Brain.git Strada.Brain

# 不需要 `cd`：可以直接从父目录使用这个 checkout
./Strada.Brain/strada install-command
./Strada.Brain/strada setup

# 如果你更喜欢更短的命令，也可以再进入仓库
cd Strada.Brain
```

所有 `npm` 命令都必须在包含 `package.json` 的仓库根目录中执行。如果看到类似 `ENOENT ... /Strada/package.json` 的错误，说明你当前在上一级目录；请先执行 `cd Strada.Brain`，或者把命令写成 `cd Strada.Brain && ...`。

`./strada` 是源码 checkout 的规范 launcher。首次运行时它会自动准备本地 checkout，所以常规 setup 已经不再需要手动 `npm link`。

如果你跳过 `./strada install-command`，仍然可以在父目录中继续使用 `./Strada.Brain/strada ...`，或者在仓库根目录中使用 `./strada ...`。安装完成后，裸命令 `strada ...` 可以在任何位置使用。

`./strada install-command` 还会自动更新你的 shell profile，这样以后新开的终端无需手动编辑 PATH 就能直接使用 `strada`。

`strada-brain` 目前还没有发布到 public npm registry，所以 `npm install -g strada-brain` 现在会返回 `E404`。在 npm 公共发布出现之前，请使用上面的源码 checkout 流程。

当 Strada 通过打包后的 npm/tarball 版本安装时，它会默认把运行时配置保存在 `~/.strada`，而不是依赖当前工作目录。如果你需要不同的 app home，可以使用 `STRADA_HOME=/custom/path` 覆盖它。

### 2. 设置

```bash
# 交互式设置向导（终端或 Web 浏览器）
./strada setup

# 跳过选择步骤，直接进入你想要的 setup 界面
./strada setup --web
./strada setup --terminal
```

如果 `./strada setup --web` 检测到过旧的 Node 版本而无法构建完整 Web 门户，Strada 仍然会把 Web 作为第一优先路径：如果系统里有 `nvm`，Strada 会在你确认后安装兼容的 Node 版本并直接回到 Web setup；该引导升级会在临时的干净 HOME 中运行，因此不兼容的 npm `prefix` / `globalconfig` 设置不会阻塞 `nvm`。否则它会引导你完成下载/升级流程，而不会悄悄降级到终端 setup。

向导会询问您的 Unity 项目路径、AI 提供商 API 密钥、默认频道和语言。`./strada setup` 现在默认优先 **Web 浏览器**；只有在你明确想走更快的纯文本流程时，才选择 **终端**。
第一次 setup 完成后，不带子命令的 `./strada` 会变成你的智能启动器：
- 第一次使用时如果没有 config，会自动进入 setup
- 之后会显示一个终端面板，让你选择 web、CLI、daemon、setup 或 doctor
设置完成后，在启动代理之前先做一次 readiness 检查：

```bash
# 在源码 checkout 内
./strada doctor

# 或者在 `./strada install-command` 之后
strada doctor
```

或者，手动创建 `.env`：

```env
ANTHROPIC_API_KEY=sk-ant-...      # 您的 Claude API 密钥
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # 必须包含 Assets/
JWT_SECRET=<使用以下命令生成: openssl rand -hex 64>
```

### 3. 运行

```bash
# 智能启动器：需要时先开 setup，否则显示入口面板
strada

# 直接以 daemon 模式启动已保存的默认通道
strada --daemon

# 使用默认 Web 频道启动
strada start

# 交互式 CLI 模式（最快的测试方式）
strada start --channel cli

# 守护进程模式（24/7 自主运行，支持主动触发器）
strada start --channel web --daemon

# 其他聊天频道
strada start --channel telegram
strada start --channel discord
strada start --channel slack
strada start --channel whatsapp

# 带自动重启的始终监督
strada supervise --channel web
```

### 4. CLI 命令

```bash
./strada                  # 源码 checkout 的规范 launcher
./strada install-command  # 为用户安装 bare `strada` 命令
strada                    # install-command 之后的智能启动器
strada --daemon           # 以 daemon 模式启动已保存的默认通道
./strada setup --web      # 直接打开 Web 向导
./strada setup --terminal # 直接使用终端向导
./strada doctor           # 检查安装 / build / config 准备情况
./strada start            # 启动代理
./strada supervise        # 带自动重启的监督
./strada update           # 检查并应用更新
./strada update --check   # 检查更新而不应用
./strada version-info     # 显示版本、安装方法、更新状态
```

### 5. 与它对话

运行后，通过您配置的频道发送消息：

```
> 分析项目结构
> 创建一个名为 "Combat" 的新模块，包含 DamageSystem 和 HealthComponent
> 查找所有查询 PositionComponent 的系统
> 运行构建并修复所有错误
```

**Web 频道：** 无需终端——通过 `localhost:3000` 的 Web 仪表板进行交互。

### 6. 自动更新

Strada.Brain 每天自动检查更新，在空闲时应用更新。源码 checkout 和 `./strada install-command` 安装会通过 git 更新。基于 npm 的更新命令只有在 public npm release 存在时才适用。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTO_UPDATE_ENABLED` | `true` | 启用/禁用自动更新 |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | 检查频率（小时） |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | 应用更新前的空闲分钟数 |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm 分发标签：`stable` 或 `latest` |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | 空闲时更新后自动重启 |

---

## 架构

```
+-----------------------------------------------------------------+
|  聊天频道                                                        |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter 接口
                               |
+------------------------------v----------------------------------+
|  编排器（PAOR 代理循环）                                          |
|  计划 -> 行动 -> 观察 -> 反思 状态机                              |
|  本能检索、故障分类、自动重新规划                                  |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| AI 提供商    | | 30+ 工具   | | 上下文来源 | | 学习系统         |
| Claude（主要）| | 文件 I/O   | | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git 操作   | | （SQLite + | | 混合加权         |
| DeepSeek,Qwen| | Shell 执行 | |  HNSW）    | | 本能生命周期     |
| MiniMax, Groq| | .NET 构建  | | RAG 向量   | | 工具链           |
| Ollama 等    | | Strada 生成| | 身份       | |                  |
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

### 代理循环如何工作

1. **消息到达** -- 来自聊天频道（文本、图片、视频、音频或文档）
2. **记忆检索** -- AgentDB 混合搜索（70% 语义 HNSW + 30% TF-IDF）查找最相关的历史对话
3. **RAG 检索** -- 对 C# 代码库进行语义搜索（HNSW 向量，前 6 个结果）
4. **本能检索** -- 主动查询与任务相关的已学习模式（语义 + 关键词匹配）
5. **身份上下文** -- 注入持久代理身份（UUID、启动次数、运行时间、崩溃恢复状态）
6. **计划阶段** -- LLM 根据已学习的洞察和过去的失败创建编号计划
7. **行动阶段** -- LLM 按照计划执行工具调用
8. **观察** -- 记录结果；错误恢复分析失败；故障分类器对错误进行分类
9. **反思** -- 每 3 步（或出错时），LLM 决定：**继续**、**重新规划** 或 **完成**
10. **自动重新规划** -- 如果连续 3 次以上相同类型的失败，强制采用避免失败策略的新方法
11. **重复** 最多 50 次迭代直到完成
12. **学习** -- 工具结果通过 TypedEventBus 流入学习管道，实现即时模式存储
13. **发送响应** -- 通过频道发送给用户（如支持则以流式传输）

---

## 记忆系统

活跃的记忆后端是 `AgentDBMemory` -- 基于 SQLite 的 HNSW 向量索引和三层自动分层架构。

**三层记忆：**
- **工作记忆** -- 活跃会话上下文，持续使用后自动提升
- **临时记忆** -- 短期存储，达到容量阈值时自动清除
- **持久记忆** -- 长期存储，根据访问频率和重要性从临时记忆提升

**工作原理：**
- 当会话历史超过 40 条消息时，旧消息被摘要并存储为对话条目
- 混合检索结合 70% 语义相似度（HNSW 向量）和 30% TF-IDF 关键词匹配
- `strada_analyze_project` 工具缓存项目结构分析，用于即时上下文注入
- 记忆在 `MEMORY_DB_PATH` 目录（默认：`.strada-memory/`）中跨重启持久化
- 首次启动时自动从旧版 FileMemoryManager 执行迁移

**回退机制：** 如果 AgentDB 初始化失败，系统自动回退到 `FileMemoryManager`（JSON + TF-IDF）。

---

## 学习系统

学习系统通过事件驱动管道观察代理行为并从错误中学习。

**事件驱动管道：**
- 工具结果通过 `TypedEventBus` 流入串行 `LearningQueue` 进行即时处理
- 无基于定时器的批处理——模式在发生时即被检测和存储
- `LearningQueue` 使用有界 FIFO 并具有错误隔离机制（学习失败不会导致代理崩溃）

**混合加权置信度评分：**
- 置信度 = 5个因素的加权总和：成功率 (0.35)、模式强度 (0.25)、近期性 (0.20)、上下文匹配 (0.15)、验证 (0.05)
- 评定分数（0.0-1.0）更新用于置信区间的 alpha/beta 证据计数器
- Alpha/beta 参数为不确定性估计而维护，但不用于主要置信度计算

**本能生命周期：**
- **提议中**（新建）-- 置信度低于 0.7
- **活跃** -- 置信度在 0.7 和 0.9 之间
- **进化** -- 高于 0.9，被提议晋升为永久
- **已弃用** -- 低于 0.3，标记待移除
- **冷却期** -- 7 天窗口，在状态变更前需满足最低观察次数要求
- **永久** -- 冻结，不再进行置信度更新

**主动检索：** 每个任务开始时，通过 `InstinctRetriever` 主动查询本能。它使用关键词相似性和 HNSW 向量嵌入搜索相关的已学习模式，并将其注入计划阶段的提示中。

**跨会话学习：** 本能携带来源元数据（源会话、会话计数），用于跨会话知识传递。

---

## 目标分解

复杂的多步骤请求会自动分解为有向无环图（DAG）形式的子目标。

**GoalDecomposer：**
- 启发式预检避免对简单任务进行 LLM 调用（通过模式匹配识别复杂度指标）
- LLM 生成带有依赖边和可选递归深度（最多 3 层）的 DAG 结构
- Kahn 算法验证无环 DAG 结构
- 反应式重分解：当节点失败时，可将其分解为更小的恢复步骤

**GoalExecutor：**
- 基于波次的并行执行，遵循依赖排序
- 基于信号量的并发限制（`GOAL_MAX_PARALLEL`）
- 失败预算（`GOAL_MAX_FAILURES`），带面向用户的继续提示
- LLM 关键性评估，判断失败节点是否应阻塞其依赖节点
- 每节点重试逻辑（`GOAL_MAX_RETRIES`），重试耗尽时进行恢复分解
- 支持 AbortSignal 取消操作
- 通过 `GoalStorage`（SQLite）持久化目标树状态，支持重启后恢复

---

## 工具链合成

代理自动检测并合成多工具链模式，生成可复用的组合工具。V2 新增基于 DAG 的并行执行和 saga 回滚，支持复杂链。

**管道：**
1. **ChainDetector** -- 分析轨迹数据，发现重复出现的工具序列（例如 `file_read` -> `file_edit` -> `dotnet_build`）
2. **ChainSynthesizer** -- 使用 LLM 生成带有适当输入/输出映射和描述的 `CompositeTool`
3. **ChainValidator** -- 合成后验证，带运行时反馈；通过加权置信度评分跟踪链执行成功率
4. **ChainManager** -- 生命周期编排器：启动时加载已有链，周期性检测运行，组件工具被移除时自动失效链

**V2 增强：**
- **DAG执行** -- 独立步骤并行运行
- **Saga回滚** -- 步骤失败时按逆序撤销已完成步骤
- **链版本控制** -- 旧版本归档保留

**安全性：** 组合工具继承其组件工具中最严格的安全标志。

**置信度级联：** 链本能遵循与普通本能相同的置信度生命周期。低于弃用阈值的链会被自动注销。

---

## 多代理编排

多个代理实例可以并发运行，按通道/会话进行隔离。

**AgentManager：**
- 按通道/会话创建和管理代理实例
- 会话隔离确保不同通道上的代理不会相互干扰
- `MULTI_AGENT_ENABLED` 默认开启；如需回退到旧的单代理行为，请设为 `false`

**AgentBudgetTracker：**
- 代理级令牌和成本跟踪，支持可配置预算限制
- 所有代理共享每日/每月预算上限
- 预算耗尽时触发优雅降级（只读模式），而非硬性失败

**AgentRegistry：**
- 所有活跃代理实例的中央注册表
- 支持健康检查和优雅关闭
- 多代理完全可选：禁用时系统运行方式与 v2.0 完全一致

---

## 任务委派

代理可以通过分层路由系统将子任务委派给其他代理。

**TierRouter（4级路由）：**
- **Tier 1** -- 简单任务由当前代理处理（不委派）
- **Tier 2** -- 中等复杂度，委派给二级代理
- **Tier 3** -- 高复杂度，以扩展预算进行委派
- **Tier 4** -- 关键任务，需要专门的代理能力

**DelegationManager：**
- 管理委派生命周期：创建、跟踪、完成、取消
- 强制最大委派深度（默认：2），防止无限委派循环
- 预算感知：被委派的任务继承父级剩余预算的一部分

**DelegationTool：**
- 作为代理可调用的工具暴露，用于委派工作
- 包含来自被委派子任务的结果聚合

---

## 记忆衰减与整合

记忆条目通过指数衰减模型随时间自然衰减，同时空闲整合减少冗余。

**指数衰减：**
- 每个记忆条目都有一个随时间递减的衰减分数
- 访问频率和重要性增强衰减抵抗力
- 本能免于衰减（永不过期）

**空闲整合：**
- 在低活动期间，整合引擎使用 HNSW 聚类识别语义相似的记忆
- 相关记忆被合并为整合摘要，减少存储并提高检索质量
- 软删除与撤销支持：被整合的源记忆标记为已整合（非物理删除），可以恢复

**整合引擎：**
- 可配置的聚类检测相似度阈值
- 批处理，支持可配置的批量大小
- 完整的整合操作审计跟踪

---

## 部署子系统

可选的部署系统，具备人工审批门控和断路器保护。

**ReadinessChecker：**
- 在部署前验证系统就绪状态（构建状态、测试结果、资源可用性）
- 可配置的就绪标准

**DeployTrigger：**
- 作为新触发器类型集成到守护进程的触发系统中
- 当部署条件满足时触发（例如所有测试通过、审批已获批）
- 包含审批队列：部署在执行前需要明确的人工审批

**DeploymentExecutor：**
- 按顺序执行部署步骤，支持回滚能力
- 环境变量清洗防止凭据泄漏到部署日志
- 断路器：连续部署失败触发自动冷却，防止级联故障

**安全性：** 部署默认关闭，需要通过配置明确启用。所有部署操作都有日志记录且可审计。

---

### Agent Core（自主 OODA 循环）

当守护进程模式激活时，Agent Core 运行持续的观察-定向-决策-行动循环：

- **观察**：从 6 个观察器收集环境状态（文件变更、git 状态、构建结果、触发器事件、用户活动、测试结果）
- **定向**：使用学习信息驱动的优先级评分（PriorityScorer 集成本能）对观察进行打分
- **决策**：具备预算感知节流的 LLM 推理（30 秒最小间隔、优先级阈值、预算底线）
- **行动**：提交目标、通知用户或等待（代理可以决定"无需操作"）

安全性：tickInFlight 防护、速率限制、预算底线（10%）和 DaemonSecurityPolicy 强制执行。

### 多提供商智能路由

配置 2 个以上提供商时，Strada.Brain 会自动将任务路由到最优提供商：

| 任务类型 | 路由策略 |
|---------|---------|
| 规划 | 最大上下文窗口（Claude > GPT > Gemini） |
| 代码生成 | 强工具调用能力（Claude > Kimi > OpenAI） |
| 代码审查 | 与执行器不同的模型（多样性偏好） |
| 简单问题 | 最快/最便宜（Groq > Kimi > Ollama） |
| 调试 | 强错误分析能力 |

**预设**：`budget`（成本优化）、`balanced`（默认）、`performance`（质量优先）
**PAOR 阶段切换**：规划阶段与执行阶段和反思阶段使用不同的提供商。
**共识**：低置信度 → 自动从不同提供商获取第二意见。

### Strada.MCP 集成

Strada.Brain 检测 [Strada.MCP](https://github.com/okandemirel/Strada.MCP)（Unity MCP 服务器）并告知代理可用的 MCP 功能，包括运行时控制、文件操作、git、.NET 构建、代码分析和场景/预制件管理。

---

## 守护进程模式

守护进程提供 24/7 自主运行，采用心跳驱动的触发系统。当守护进程模式激活时，**Agent Core OODA 循环** 在守护进程的心跳周期内运行，在用户交互之间观察环境并主动采取行动。`/autonomous on` 命令现在会传播到 DaemonSecurityPolicy，启用完全自主运行而无需逐操作审批提示。

```bash
npm run dev -- daemon --channel web
```

**HeartbeatLoop：**
- 可配置的心跳间隔，每个周期评估已注册的触发器
- 顺序触发器评估，防止预算竞态条件
- 持久化运行状态，用于崩溃恢复

**触发器类型：**
- **Cron** -- 使用 cron 表达式的定时任务
- **文件监控** -- 监控配置路径中的文件系统变更
- **检查清单** -- 检查清单项到期时触发
- **Webhook** -- HTTP POST 端点，接收请求时触发任务
- **Deploy** -- 当部署条件满足时触发（需要审批门控）

**弹性保障：**
- **断路器** -- 每触发器独立，带指数退避冷却，跨重启持久化
- **预算跟踪** -- 每日美元支出上限，带预警阈值事件
- **触发器去重** -- 基于内容和冷却时间的抑制，防止重复触发
- **重叠抑制** -- 跳过已有活跃任务运行中的触发器

**安全性：**
- `DaemonSecurityPolicy` 控制守护进程触发器调用时哪些工具需要用户批准
- `ApprovalQueue` 带可配置过期时间，用于写入操作

**报告：**
- `NotificationRouter` 根据紧急级别（静默/低/中/高/严重）将事件路由到已配置的频道
- 每级别速率限制和静默时段支持（非关键通知被缓冲）
- `DigestReporter` 生成定期摘要报告
- 所有通知记录到 SQLite 历史

---

## 身份系统

代理在会话和重启之间维护持久身份。

**IdentityStateManager**（SQLite 支持）：
- 首次启动时生成唯一代理 UUID
- 启动次数、累计运行时间、最后活动时间戳
- 总消息数和任务计数器
- 干净关闭检测，用于崩溃恢复
- 内存计数器缓存，定期刷新到磁盘以减少 SQLite 写入

**崩溃恢复：**
- 启动时，如果上次会话未正常关闭，构建 `CrashRecoveryContext`
- 包含停机时长、中断的目标树和启动次数
- 注入系统提示，使 LLM 自然地确认崩溃并能恢复中断的工作

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

任何 OpenAI 兼容的提供商均可使用。以下所有提供商都已实现；大多数通过 API 密钥激活，而 OpenAI 也可以复用这台机器上的本地 ChatGPT/Codex 订阅会话来处理对话回合。

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
| `OPENAI_AUTH_MODE` | OpenAI 认证模式 | `api-key`（默认）或 `chatgpt-subscription` |
| `OPENAI_CHATGPT_AUTH_FILE` | 可选 Codex 会话文件 | 当 `OPENAI_AUTH_MODE=chatgpt-subscription` 时默认使用 `~/.codex/auth.json` |

**提供商链：** 将 `PROVIDER_CHAIN` 设置为以逗号分隔的提供商名称列表。Strada 仍然是控制平面，并将这条链作为默认编排池，用于主执行 worker、supervisor 路由以及故障回退。示例：`PROVIDER_CHAIN=kimi,deepseek,claude` 首先使用 Kimi，Kimi 失败则使用 DeepSeek，然后是 Claude。

**重要：** `OPENAI_AUTH_MODE=chatgpt-subscription` 只覆盖 Strada 内的 OpenAI 对话回合，不会提供 OpenAI API 或 embeddings 配额。如果你选择 `EMBEDDING_PROVIDER=openai`，仍然需要 `OPENAI_API_KEY`。

### 聊天频道

**Web：**
| 变量 | 说明 |
|------|------|
| `WEB_CHANNEL_PORT` | Web 仪表板端口（默认：`3000`） |

**Telegram：**
| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | 从 @BotFather 获取的令牌 |
| `ALLOWED_TELEGRAM_USER_IDS` | 以逗号分隔的 Telegram 用户 ID（必需，为空则拒绝所有） |

**Discord：**
| 变量 | 说明 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord 机器人令牌 |
| `DISCORD_GUILD_ID` | Discord 服务器（guild）ID |
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
| `WHATSAPP_ALLOWED_NUMBERS` | 以逗号分隔的电话号码（可选；为空时开放访问） |

### 功能特性

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RAG_ENABLED` | `true` | 启用对 C# 项目的语义代码搜索 |
| `EMBEDDING_PROVIDER` | `auto` | 嵌入提供商：`auto`、`openai`、`gemini`、`mistral`、`together`、`fireworks`、`qwen`、`ollama` |
| `EMBEDDING_DIMENSIONS` | （提供商默认） | 输出向量维度（Matryoshka：Gemini/OpenAI 支持 128-3072） |
| `MEMORY_ENABLED` | `true` | 启用持久对话记忆 |
| `MEMORY_DB_PATH` | `.strada-memory` | 记忆数据库文件目录 |
| `WEB_CHANNEL_PORT` | `3000` | Web 仪表板端口 |
| `DASHBOARD_ENABLED` | `false` | 启用 HTTP 监控仪表板 |
| `DASHBOARD_PORT` | `3100` | 仪表板服务器端口 |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | 启用 WebSocket 实时仪表板 |
| `ENABLE_PROMETHEUS` | `false` | 启用 Prometheus 指标端点（端口 9090） |
| `MULTI_AGENT_ENABLED` | `true` | 启用多代理编排 |
| `TASK_DELEGATION_ENABLED` | `false` | 启用代理间任务委派 |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | 最大委派链深度 |
| `DEPLOY_ENABLED` | `false` | 启用部署子系统 |
| `SOUL_FILE` | `soul.md` | 代理个性文件路径（变更时热重载） |
| `SOUL_FILE_WEB` | (未设置) | Web 频道的频道级个性覆盖 |
| `SOUL_FILE_TELEGRAM` | (未设置) | Telegram 的频道级个性覆盖 |
| `SOUL_FILE_DISCORD` | (未设置) | Discord 的频道级个性覆盖 |
| `SOUL_FILE_SLACK` | (未设置) | Slack 的频道级个性覆盖 |
| `SOUL_FILE_WHATSAPP` | (未设置) | WhatsApp 的频道级个性覆盖 |
| `READ_ONLY_MODE` | `false` | 阻止所有写入操作 |
| `LOG_LEVEL` | `info` | `error`、`warn`、`info` 或 `debug` |

### 路由与共识

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ROUTING_PRESET` | `balanced` | 路由预设：`budget`、`balanced` 或 `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | 启用跨提供商的 PAOR 阶段切换 |
| `CONSENSUS_MODE` | `auto` | 共识模式：`auto`、`critical-only`、`always` 或 `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | 触发共识的置信度阈值 |
| `CONSENSUS_MAX_PROVIDERS` | `3` | 共识咨询的最大提供商数量 |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | 守护进程模式的每日预算（美元） |

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

代理拥有 40 多个按类别组织的内置工具：

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
| `strada_analyze_project` | 完整 C# 项目扫描——模块、系统、组件、服务 |
| `strada_create_module` | 生成完整模块脚手架（`.asmdef`、配置、目录） |
| `strada_create_component` | 生成带字段定义的 ECS 组件结构体 |
| `strada_create_mediator` | 生成带组件绑定的 `EntityMediator<TView>` |
| `strada_create_system` | 生成 `SystemBase`/`JobSystemBase`/`BurstSystem` 脚手架 |

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

### 代理交互
| 工具 | 说明 |
|------|------|
| `ask_user` | 向用户发送带有多项选择和推荐答案的澄清问题 |
| `show_plan` | 显示执行计划并等待用户审批（批准/修改/拒绝） |
| `switch_personality` | 在运行时切换代理个性（casual/formal/minimal/default） |

### 其他
| 工具 | 说明 |
|------|------|
| `shell_exec` | 执行 Shell 命令（30 秒超时，危险命令黑名单） |
| `code_quality` | 按文件或按项目的代码质量分析 |
| `rag_index` | 触发增量或完整的项目重新索引 |

---

## 聊天命令

所有聊天频道可用的斜杠命令：

| 命令 | 说明 |
|------|------|
| `/daemon` | 显示守护进程状态 |
| `/daemon start` | 启动守护进程心跳循环 |
| `/daemon stop` | 停止守护进程心跳循环 |
| `/daemon triggers` | 显示活跃触发器 |
| `/agent` | 显示 Agent Core 状态 |
| `/routing` | 显示路由状态和预设 |
| `/routing preset <name>` | 切换路由预设（budget/balanced/performance） |
| `/routing info` | 显示最近的路由决策 |

---

## RAG 管道

RAG（检索增强生成）管道对您的 C# 源代码进行索引以支持语义搜索。

**索引流程：**
1. 扫描 Unity 项目中的 `**/*.cs` 文件
2. 对代码进行结构化分块——文件头、类、方法、构造函数
3. 通过配置的提供商生成嵌入向量 -- OpenAI（`text-embedding-3-small`）、Gemini（`gemini-embedding-2-preview`，Matryoshka 维度 128-3072）、Mistral、Ollama 等。通过 `EMBEDDING_DIMENSIONS` 控制输出大小
4. 将向量存储在 HNSW 索引中以实现快速近似最近邻搜索
5. 启动时自动运行（后台，非阻塞）

**搜索流程：**
1. 使用相同的提供商对查询进行嵌入
2. HNSW 搜索返回 `topK * 3` 个候选项
3. 重排序器评分：向量相似度（60%）+ 关键词重叠（25%）+ 结构奖励（15%）
4. 得分超过 0.2 的前 6 个结果被注入 LLM 上下文

**注意：** RAG 管道目前仅支持 C# 文件。分块器是 C# 特定的。

---

## 频道功能

| 功能 | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|------|-----|----------|---------|-------|----------|-----|
| 文本消息 | 是 | 是 | 是 | 是 | 是 | 是 |
| 媒体附件 | 是（base64） | 是（照片/文档/视频/语音） | 是（任意附件） | 是（文件下载） | 是（图片/视频/音频/文档） | 否 |
| 视觉（图片→LLM） | 是 | 是 | 是 | 是 | 是 | 否 |
| 流式传输（就地编辑） | 是 | 是 | 是 | 是 | 是 | 是 |
| 输入指示器 | 是 | 是 | 是 | 无操作 | 是 | 否 |
| 确认对话框 | 是（模态框） | 是（内联键盘） | 是（按钮） | 是（Block Kit） | 是（编号回复） | 是（readline） |
| 主题支持 | 否 | 否 | 是 | 是 | 否 | 否 |
| 速率限制（出站） | 是（每会话） | 否 | 是（令牌桶） | 是（4 层滑动窗口） | 内联节流 | 否 |

### 流式传输

所有频道都实现了就地编辑流式传输。代理的响应随 LLM 生成而逐步显示。更新按平台限流以避免速率限制（WhatsApp/Discord：1 次/秒，Slack：2 次/秒）。

### 身份验证

- **Telegram**：默认拒绝所有。必须设置 `ALLOWED_TELEGRAM_USER_IDS`。
- **Discord**：默认拒绝所有。必须设置 `ALLOWED_DISCORD_USER_IDS` 或 `ALLOWED_DISCORD_ROLE_IDS`。
- **Slack**：**默认对所有人开放。** 如果 `ALLOWED_SLACK_USER_IDS` 为空，任何 Slack 用户都可以访问机器人。请为生产环境设置允许列表。
- **WhatsApp**：默认开放访问。只有在设置 `WHATSAPP_ALLOWED_NUMBERS` 时，适配器才会将入站消息限制到该允许列表。

---

## 安全

### 第 1 层：频道身份验证
在消息到达时（任何处理之前）检查的平台特定允许列表。

### 第 2 层：速率限制
每用户滑动窗口（分钟/小时）+ 全局每日/每月令牌和美元预算上限。

### 第 3 层：路径守卫
每个文件操作都解析符号链接并验证路径保持在项目根目录内。30 多个敏感模式被阻止（`.env`、`.git/credentials`、SSH 密钥、证书、`node_modules/`）。

### 第 4 层：媒体安全
所有媒体附件在处理前均经过验证：MIME 白名单、按类型的大小限制（图片 20MB、视频 50MB、音频 25MB、文档 10MB）、魔数字节验证，以及针对下载 URL 的 SSRF 保护。

### 第 5 层：密钥清洗器
24 个正则表达式模式在所有工具输出到达 LLM 之前检测并遮罩凭据。涵盖：OpenAI 密钥、GitHub 令牌、Slack/Discord/Telegram 令牌、AWS 密钥、JWT、Bearer 认证、PEM 密钥、数据库 URL 和通用密钥模式。

### 第 6 层：只读模式
当 `READ_ONLY_MODE=true` 时，23 个写入工具从代理的工具列表中完全移除——LLM 甚至无法尝试调用它们。

### 第 7 层：操作确认
写入操作（文件写入、git 提交、Shell 执行）可以通过频道的交互式 UI（按钮、内联键盘、文本提示）要求用户确认。

### 第 8 层：工具输出清洗
所有工具结果被限制在 8192 个字符以内，并在反馈给 LLM 之前清除 API 密钥模式。

### 第 9 层：RBAC（内部）
5 个角色（superadmin、admin、developer、viewer、service），权限矩阵涵盖 9 种资源类型。策略引擎支持基于时间、基于 IP 和自定义条件。

### 第 10 层：守护进程安全
`DaemonSecurityPolicy` 对守护进程触发的操作强制执行工具级别的审批要求。写入工具在执行前需要通过 `ApprovalQueue` 获得用户的明确批准。

---

## 仪表板与监控

### HTTP 仪表板（`DASHBOARD_ENABLED=true`）
通过 `http://localhost:3100` 访问（仅限本地）。显示：运行时间、消息计数、令牌使用量、活跃会话、工具使用表、安全统计。每 3 秒自动刷新。

### 健康端点
- `GET /health` -- 存活探针（`{"status":"ok"}`）
- `GET /ready` -- 深度就绪检查：检查记忆和频道健康状况。返回 200（就绪）、207（降级）或 503（未就绪）

### Prometheus（`ENABLE_PROMETHEUS=true`）
指标位于 `http://localhost:9090/metrics`。消息、工具调用、令牌的计数器。请求持续时间、工具持续时间、LLM 延迟的直方图。默认 Node.js 指标（CPU、堆内存、GC、事件循环）。

### WebSocket 仪表板（`ENABLE_WEBSOCKET_DASHBOARD=true`）
每秒推送实时指标。支持认证连接、heartbeat 监控，以及由应用注册的命令/通知处理器。若设置了 `WEBSOCKET_DASHBOARD_AUTH_TOKEN`，请使用该 bearer token；若未设置，则 same-origin 仪表板会自动 bootstrap 一个进程级 token。

### 指标系统
`MetricsStorage`（SQLite）记录任务完成率、迭代次数、工具使用量和模式复用情况。`MetricsRecorder` 按会话捕获指标。`metrics` CLI 命令显示历史指标。

---

## 部署

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml` 包含应用程序、监控栈和 nginx 反向代理。

### 守护进程模式

```bash
# 24/7 自主运行，带心跳循环和主动触发器
node dist/index.js daemon --channel web

# 崩溃时自动重启，指数退避（1 秒到 60 秒，最多 10 次重启）
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
- [ ] 配置守护进程预算限制（`RATE_LIMIT_DAILY_BUDGET_USD`）

---

## 测试

```bash
npm test                         # 默认完整套件（为稳定性分批执行）
npm run test:watch               # 监视模式
npm test -- --coverage           # 带覆盖率
npm test -- src/agents/tools/file-read.test.ts  # 单个文件 / 定向执行
npm test -- src/dashboard/prometheus.test.ts    # 通过默认 runner 执行定向套件
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # 校验 Strada.Core API drift
npm run test:file-build-flow     # opt-in 本地 .NET 集成流程
npm run test:unity-fixture       # opt-in 本地 Unity fixture 编译/测试流程
npm run test:hnsw-perf           # opt-in HNSW 基准 / recall 套件
npm run typecheck                # TypeScript 类型检查
npm run lint                     # ESLint
```

说明:
- `npm test` 使用分批的 Vitest runner 和 `fork` worker，以避免之前完整套件的 OOM 路径。
- 依赖真实 socket bind 的 dashboard 测试默认会被跳过；如需真实本地验证，请使用 `LOCAL_SERVER_TESTS=1`。
- `sync:check` 会把 Strada.Brain 的 Strada.Core 知识与真实 checkout 做比对；CI 会以 `--max-drift-score 0` 强制执行。
- `test:file-build-flow`、`test:unity-fixture` 和 `test:hnsw-perf` 有意保持为 opt-in，因为它们依赖本地构建工具、带许可证的 Unity 编辑器或较重的基准负载。
- `test:unity-fixture` 即使生成代码本身正确，也可能因为本地 Unity batchmode / 许可证环境异常而失败。

---

## 项目结构

```
src/
  index.ts              # CLI 入口点（Commander.js）
  core/
    bootstrap.ts        # 完整初始化序列——所有连接在此完成
    event-bus.ts        # TypedEventBus，用于解耦的事件驱动通信
    tool-registry.ts    # 工具实例化和注册
  agents/
    orchestrator.ts     # PAOR 代理循环、会话管理、流式传输
    agent-state.ts      # 阶段状态机（计划/行动/观察/反思）
    paor-prompts.ts     # 阶段感知的提示构建器
    instinct-retriever.ts # 主动已学习模式检索
    failure-classifier.ts # 错误分类和自动重新规划触发器
    autonomy/           # 错误恢复、任务规划、自我验证
    context/            # 系统提示（Strada.Core 知识库）
    providers/          # Claude、OpenAI、Ollama、DeepSeek、Kimi、Qwen、MiniMax、Groq 等
    tools/              # 30+ 工具实现（ask_user, show_plan, switch_personality 等）
    soul/               # SOUL.md 个性加载器，支持热重载和按频道覆盖
    plugins/            # 外部插件加载器
  profiles/             # 个性配置文件：casual.md, formal.md, minimal.md
  channels/
    telegram/           # 基于 Grammy 的机器人
    discord/            # discord.js 机器人，支持斜杠命令
    slack/              # Slack Bolt（Socket 模式），支持 Block Kit
    whatsapp/           # 基于 Baileys 的客户端，带会话管理
    web/                # Express + WebSocket Web 频道
    cli/                # Readline REPL
  web-portal/           # React + Vite 聊天 UI（暗/亮主题、文件上传、流式传输、仪表板标签页、侧面板）
  memory/
    file-memory-manager.ts   # 旧版后端：JSON + TF-IDF（回退）
    unified/
      agentdb-memory.ts      # 活跃后端：SQLite + HNSW，3 层自动分层
      agentdb-adapter.ts     # AgentDBMemory 的 IMemoryManager 适配器
      migration.ts           # 旧版 FileMemoryManager -> AgentDB 迁移
      consolidation-engine.ts # 空闲记忆整合与 HNSW 聚类
      consolidation-types.ts  # 整合类型定义和接口
    decay/                    # 指数记忆衰减系统
  rag/
    rag-pipeline.ts     # 索引 + 搜索 + 格式化编排
    chunker.ts          # C# 特定的结构化分块
    hnsw/               # HNSW 向量存储（hnswlib-node）
    embeddings/         # OpenAI 和 Ollama 嵌入提供商
    reranker.ts         # 加权重排序（向量 + 关键词 + 结构）
  learning/
    pipeline/
      learning-pipeline.ts  # 模式检测、本能创建、进化提议
      learning-queue.ts     # 事件驱动学习的串行异步处理器
      embedding-queue.ts    # 有界异步嵌入生成
    scoring/
      confidence-scorer.ts  # 混合加权置信度（5因素）、Elo、Wilson 区间
    matching/
      pattern-matcher.ts    # 关键词 + 语义模式匹配
    hooks/
      error-learning-hooks.ts  # 错误/解决方案捕获钩子
    storage/
      learning-storage.ts  # 本能、轨迹、模式的 SQLite 存储
      migrations/          # 模式迁移（跨会话来源）
    chains/
      chain-detector.ts    # 重复工具序列检测
      chain-synthesizer.ts # 基于 LLM 的组合工具生成
      composite-tool.ts    # 可执行组合工具
      chain-validator.ts   # 合成后验证、运行时反馈
      chain-manager.ts     # 完整生命周期编排器
  multi-agent/
    agent-manager.ts    # 多代理生命周期和会话隔离
    agent-budget-tracker.ts  # 代理级预算跟踪
    agent-registry.ts   # 活跃代理中央注册表
  delegation/
    delegation-manager.ts    # 委派生命周期管理
    delegation-tool.ts       # 面向代理的委派工具
    tier-router.ts           # 4 级任务路由
  goals/
    goal-decomposer.ts  # 基于 DAG 的目标分解（主动 + 反应式）
    goal-executor.ts    # 基于波次的并行执行，带失败预算
    goal-validator.ts   # Kahn 算法 DAG 环检测
    goal-storage.ts     # 目标树的 SQLite 持久化
    goal-progress.ts    # 进度跟踪和报告
    goal-resume.ts      # 重启后恢复中断的目标树
    goal-renderer.ts    # 目标树可视化
  daemon/
    heartbeat-loop.ts   # 核心心跳-评估-触发循环
    trigger-registry.ts # 触发器注册和生命周期
    daemon-storage.ts   # 守护进程状态的 SQLite 持久化
    daemon-events.ts    # 守护进程子系统的类型化事件定义
    daemon-cli.ts       # 守护进程管理的 CLI 命令
    budget/
      budget-tracker.ts # 每日美元预算跟踪
    resilience/
      circuit-breaker.ts # 每触发器断路器，带指数退避
    security/
      daemon-security-policy.ts  # 守护进程的工具审批要求
      approval-queue.ts          # 带过期时间的审批请求队列
    dedup/
      trigger-deduplicator.ts    # 内容 + 冷却时间去重
    triggers/
      cron-trigger.ts        # Cron 表达式调度
      file-watch-trigger.ts  # 文件系统变更监控
      checklist-trigger.ts   # 到期日检查清单项
      webhook-trigger.ts     # HTTP POST Webhook 端点
      deploy-trigger.ts      # 带审批门控的部署条件触发器
    deployment/
      deployment-executor.ts # 带回滚的部署执行
      readiness-checker.ts   # 部署前就绪验证
    reporting/
      notification-router.ts # 基于紧急级别的通知路由
      digest-reporter.ts     # 定期摘要生成
      digest-formatter.ts    # 为频道格式化摘要报告
      quiet-hours.ts         # 非关键通知缓冲
  identity/
    identity-state.ts   # 持久代理身份（UUID、启动次数、运行时间）
    crash-recovery.ts   # 崩溃检测和恢复上下文
  tasks/
    task-manager.ts     # 任务生命周期管理
    task-storage.ts     # SQLite 任务持久化
    background-executor.ts # 后台任务执行，带目标集成
    message-router.ts   # 消息路由到编排器
    command-detector.ts # 斜杠命令检测
    command-handler.ts  # 命令执行
  metrics/
    metrics-storage.ts  # SQLite 指标存储
    metrics-recorder.ts # 按会话指标捕获
    metrics-cli.ts      # CLI 指标显示命令
  utils/
    media-processor.ts  # 媒体下载、验证（MIME/大小/魔数字节）、SSRF 保护
  security/             # 认证、RBAC、路径守卫、速率限制、密钥清洗
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
