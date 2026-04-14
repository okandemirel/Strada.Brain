# 代码库内存 Vault 子系统（Phase 1 + Phase 2）

> 翻译说明：当前运行时行为、配置默认值和安全语义的正本是 [docs/vault.md](vault.md)。本文件是其中文翻译版本。

## 1. 概述

**Codebase Memory Vault**（代码库内存 Vault）是 Strada.Brain 的持久化、按项目粒度的代码库记忆层。它的设计目标是**让代理停止在每次请求时重新阅读整个项目**。

在没有 Vault 的情况下，代理每次调用都可能会打开几十个源文件、重新计算上下文、并消耗大量 token。Vault 将这一切替换为三层记忆结构，所有结果持久化到 `<project>/.strada/vault/index.db`（SQLite）中：

- **L1 — 文件元数据**：路径、语言、xxhash64 内容哈希、大小、修改时间
- **L2 — 符号图（Phase 2）**：由 Tree-sitter 抽取的类/函数/方法节点以及 `calls` / `imports` / `wikilink` 边
- **L3 — 混合 chunk（Phase 1）**：tokenized chunk，同时由 BM25（FTS5）和 HNSW 向量索引索引

查询时，Vault 通过 **Reciprocal Rank Fusion (RRF, k = 60)** 同时融合词法检索和语义检索结果，可选地通过 **Personalized PageRank (PPR)** 在调用/导入图上重排，并用 `packByBudget` 按 token 预算贪心打包。输出是一组最小必要的代码上下文，可直接交给 LLM，显著降低 token 消耗。

Vault 同时理解两类项目：

- **Unity 项目**（`UnityProjectVault`）— 索引用户的 Unity 工程，落盘 markdown 到 `<unity-project>/.strada/vault/codebase/`
- **Strada.Brain 本体**（`SelfVault`）— 索引 Brain 自己的源代码，使代理在回答"我自己是怎么实现的"这类问题时也拥有同等检索能力

---

## 2. 快速开始

```bash
# 启用 Vault（默认关闭）
export STRADA_VAULT_ENABLED=true

# 启动 Strada.Brain
npm start

# 在代理会话里：
/vault init /path/to/unity/project   # 创建并冷启动索引
/vault sync                          # 手动触发一次全量重建
/vault status                        # 查看文件数、chunk 数、符号数、边数
```

启用后你会看到：

1. 目标项目下出现 `.strada/vault/` 目录，包含 `index.db`、`graph.canvas`、`codebase/`
2. chokidar watcher 开始监听文件变更（默认 800 ms debounce）
3. Brain 自身的工具写入会走 write-hook（默认 200 ms 预算），实现自动同步
4. 门户 `/admin/vaults` 页面展示 Files / Search / Graph 三个标签页

---

## 3. 架构概览

```
+-----------------------------------------------------------------+
|                        VaultRegistry (singleton)                |
|   fan-out query() -> 每个 IVault -> 按 RRF 分数合并 + topK       |
+-----------------------------+-----------------------------------+
                              |
        +---------------------+---------------------+
        |                                           |
  UnityProjectVault                             SelfVault
  (用户 Unity 工程)                      (Strada.Brain 自己的源码)
        |                                           |
        v                                           v
+-----------------------------------------------------------------+
|            <project>/.strada/vault/index.db (SQLite, WAL)       |
|                                                                 |
|  L1  vault_files       路径 / 哈希 / 语言 / mtime               |
|  L2  vault_symbols     符号节点（Phase 2）                       |
|      vault_edges       calls / imports 边（Phase 2）             |
|      vault_wikilinks   markdown wikilink 边（Phase 2）           |
|  L3  vault_chunks      tokenized chunk 正文                     |
|      vault_chunks_fts  FTS5 / BM25 虚拟表                       |
|      vault_embeddings  HNSW 外部存储指针                         |
|      vault_meta        indexer_version 等元数据                  |
+-----------------------------------------------------------------+
```

- `IVault`（`src/vault/vault.interface.ts`）是所有 Vault 实现必须满足的契约
- `VaultRegistry`（`src/vault/vault-registry.ts`）是单例查询入口，负责跨 Vault 合并
- 每个 Vault 使用 **better-sqlite3**，打开 `WAL` 模式并启用 `foreign_keys`

---

## 4. Phase 1 — 混合检索

### 4.1 查询流水线

`VaultRegistry.query({ text, topK, budgetTokens, langFilter?, pathGlob? })` 按以下步骤执行：

1. **单个 Vault 召回**：同时执行 BM25（FTS5）和向量（HNSW）检索
2. **RRF 融合**：使用 `k = 60` 的 Reciprocal Rank Fusion 合并两个有序列表
3. **过滤**：可选的 `langFilter` 和 `pathGlob` 进一步缩小结果
4. **打包**：`packByBudget` 在给定 token 预算内贪心打包 chunk
5. **跨 Vault 合并**：按 RRF 分数排序，截断到 `topK`

### 4.2 存储结构

SQLite 表结构（精简版）：

| 表 | 用途 |
|---|---|
| `vault_files` | 路径、xxhash64 blob 哈希、mtime、大小、语言、kind |
| `vault_chunks` | chunkId（sha256 截断）、path 外键、行范围、正文、token 数 |
| `vault_chunks_fts` | FTS5 虚拟表，使用 BM25 评分 |
| `vault_embeddings` | 指向外部 HNSW 存储的指针 |
| `vault_meta` | key/value 元数据，供迁移使用 |

### 4.3 三条更新路径（hybrid）

Vault 同时支持三种互补的更新入口：

1. **chokidar watcher** — 监听用户文件系统变更，默认 800 ms debounce
2. **Write-hook**（`installWriteHook`）— 捕获 Strada.Brain 自身工具的写操作，默认 200 ms 同步预算
3. **Manual `/vault sync`** — 按需执行完整重建

三者都遵守 `reindexFile` 中的 **xxhash64 内容哈希短路**：内容未变的文件永远不会重新 embed。

### 4.4 工具

以下工具在引导阶段就会注册到代理的工具表中（集成通过 `stage-knowledge.ts` 里的 `initVaultsFromBootstrap` 辅助函数完成）：

| 工具 | 说明 |
|---|---|
| `vault_init` | 为指定路径创建并冷启动一个 Vault |
| `vault_sync` | 触发一次手动同步 |
| `vault_status` | 返回文件数、chunk 数、符号数、边数、最后同步时间 |

---

## 5. Phase 2 — 符号图 + PPR + SelfVault + Graph UI

Phase 2 在 Phase 1 的 L3 混合检索之上叠加了一个确定性的 L2 符号层。

### 5.1 新增内容

- 新表：`vault_symbols`、`vault_edges`、`vault_wikilinks`
- `vault_meta.indexer_version = 'phase2.v1'`
- Tree-sitter **WASM** 抽取器（`src/vault/symbol-extractor/`）：
  - TypeScript
  - C#
  - Markdown wikilink（基于正则）
- `.strada/vault/graph.canvas` — 符合 **JSON Canvas 1.0** 的文件；在每次冷启动、`/vault sync` 以及 watcher drain 时重新生成（原子写入）
- Personalized PageRank（`src/vault/ppr.ts`）— 当 `VaultQuery.focusFiles` 提供时对检索结果重排；未提供时保留纯 RRF 路径
- **SelfVault**（`src/vault/self-vault.ts`）— 索引 Strada.Brain 自身源码：`src/`、`web-portal/src/`、`tests/`、`docs/`、`AGENTS.md`、`CLAUDE.md`。跳过符号链接
- 门户 `/vaults` 新增 **Graph** 标签，使用 `@xyflow/react` + `@dagrejs/dagre` 渲染 canvas（无新增前端依赖）

### 5.2 符号 ID 格式

```
<lang>::<relPath>::<qualifiedName>
```

示例：

- `csharp::Assets/Scripts/Player.cs::Game.Player.Move`
- `typescript::src/foo.ts::Foo.bar`

对于无法解析到具体文件的外部引用，使用保留命名空间：

```
<lang>::unresolved::<label>
```

### 5.3 Personalized PageRank（PPR）

当调用方传入 `VaultQuery.focusFiles`（例如代理当前正在编辑的文件集合），Vault 会在 `vault_edges` 构成的有向图上运行 PPR：

- 以 `focusFiles` 中的符号作为重启向量
- 阻尼因子经过归一化处理，避免低度节点溢出
- 将 PPR 分数与 RRF 分数融合，使得结构上"距离"当前工作更近的符号优先出现

当 `focusFiles` 省略时，流水线完全回退到 Phase 1 的纯 RRF 行为。

---

## 6. 配置参考

Vault 配置位于 `src/config/config.ts` 的 `vault` 段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 主开关（env: `STRADA_VAULT_ENABLED`） |
| `writeHookBudgetMs` | `200` | write-hook 同步预算（毫秒） |
| `debounceMs` | `800` | chokidar watcher debounce |
| `embeddingFallback` | `'local'` | `'none'` \| `'local'` — 云端 embedding 失败时的降级策略 |
| `self.enabled` | `true` | 是否启用 SelfVault |

环境变量：

```bash
STRADA_VAULT_ENABLED=true
STRADA_VAULT_WRITE_HOOK_BUDGET_MS=200
STRADA_VAULT_DEBOUNCE_MS=800
```

`config.vault.enabled` 是整个子系统的主开关；`config.vault.self.enabled = false` 可以在保留用户项目 Vault 的同时单独关闭 SelfVault。

---

## 7. HTTP API 参考

所有 Vault 相关接口都挂在 `/api/vaults` 下。WebSocket 广播使用 `vault:update` 事件，随附 dirty-set 批次。

### 7.1 Phase 1

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/vaults` | 列出已注册 Vault |
| GET | `/api/vaults/:id/files` | 列出文件树 |
| GET | `/api/vaults/:id/files/*` | 读取单个文件（markdown 或原文） |
| POST | `/api/vaults/:id/query` | 执行混合查询 |
| POST | `/api/vaults/:id/sync` | 触发手动同步 |

### 7.2 Phase 2 新增

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/vaults/:id/canvas` | 返回 `graph.canvas`（JSON Canvas 1.0） |
| GET | `/api/vaults/:id/symbols/by-name?q=X` | 按短名查找符号 |
| GET | `/api/vaults/:id/symbols/:symbolId/callers` | 列出指向该符号的入边（调用者） |

---

## 8. 门户 UI 指南

`/admin/vaults`（`web-portal/src/pages/VaultsPage.tsx`）提供三个标签页：

### 8.1 Files 标签

- 左侧是文件树，支持按 Vault 切换
- 右侧预览：可在 **markdown**（Vault 提取出的精简版）和 **raw**（原始源文件）之间切换
- 文件状态通过 `vault:update` WebSocket 事件实时刷新

### 8.2 Search 标签

- 单个输入框即可触发混合查询（BM25 + 向量 + RRF）
- 可选过滤：`langFilter`、`pathGlob`、token 预算
- 结果卡片展示 chunk、路径、行号范围、RRF 分数

### 8.3 Graph 标签（Phase 2）

- 通过 `@xyflow/react` 渲染 `graph.canvas`
- 使用 `@dagrejs/dagre` 进行自动布局
- 节点代表符号，边代表 `calls` / `imports` / `wikilink`
- 点击节点可导航到对应符号，并反向调用 `symbols/:id/callers` 获取调用者

---

## 9. 安全

Phase 2 的安全加固（commit `5563d48`）涵盖以下关键点：

- **原子 canvas 写入** — 先写临时文件再 `rename`，避免门户读到半写入的 JSON
- **跳过符号链接** — SelfVault 和 UnityProjectVault 都拒绝跟随 symlink，防止越界索引
- **每次调用使用全新的 Parser** — Tree-sitter parser 不在请求间共享状态，防止污染
- **请求体 DoS 上限** — HTTP 层对 Vault 接口请求体设硬上限
- **孤立边 GC** — 文件删除时，其出入边同步回收
- **归一化 PPR 阻尼** — 低度节点不会被阻尼因子放大到不合理分数
- **2 MB 符号抽取上限** — 超大文件跳过符号抽取，防止 WASM parser OOM
- **边缓存失效** — `vault_edges` 变更时同步作废内部缓存
- **`findCallers` 有界** — 限制最大返回深度/宽度，防止病态图拖垮查询

所有 Vault 数据都驻留在本地磁盘（`<project>/.strada/vault/`），不会被发送到任何远端；embedding 调用遵循全局 provider 隔离策略。

---

## 10. 路线图（Phase 3）

Phase 3 将在 Phase 2 的符号图基础上继续演进：

- **Haiku 滚动摘要** — 使用轻量模型为每个符号/文件持续生成简短摘要，供检索时优先加载
- **FrameworkVault 升级** — 对 Strada.Core 框架文档启用语义检索 + docstring 抽取
- **双向 Learning 耦合** — Learning pipeline 的发现会反哺 Vault（如热门符号、高频错误路径），Vault 的结构信号也会反馈给 Learning pipeline

---

## 11. 链接

- 源代码：[`src/vault/`](../src/vault/)
- 英文版：[`docs/vault.md`](vault.md)
- 入口工具：`vault_init`、`vault_sync`、`vault_status`
- 门户页面：`/admin/vaults`
