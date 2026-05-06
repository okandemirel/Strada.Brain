# Strada.Brain -- Eylem Listesi (Action Items)

> Kritik (P0) → Yuksek (P1) → Orta (P2) → Dusuk (P3) oncelik sirasi

---

## 🔴 P0 -- Hemen (Bugun)

| # | Sorun | Lokasyon | Kategori | Tahmini Sure |
|---|-------|----------|----------|--------------|
| 1 | Slack bootstrap'ta eksik | `src/core/bootstrap-channels.ts:29` | Kanal | 15 dk |
| 2 | Slack timeout reject (Error) | `src/channels/slack/app.ts:527` | Kanal | 5 dk |
| 3 | Orchestrator write-gate runtime crash | `src/agents/orchestrator-write-gate.ts:66` | Orchestrator | 15 dk |
| 4 | Orchestrator end-turn incomplete response | `src/agents/orchestrator.ts:4832` | Orchestrator | 15 dk |
| 5 | /api/triggers response formati uyumsuz | `src/dashboard/server-daemon-routes.ts:279` | Web Portal | 15 dk |
| 6 | Batch runner tests/ dizinini atliyor | `scripts/run-vitest-batches.mjs:75` | Test | 15 dk |
| 7 | validateFilePath Windows uyumsuz | `src/validation/index.ts:310` | Guvenlik | 15 dk |
| 8 | safePathSchema Windows backslash bypass | `src/validation/schemas.ts:66` | Guvenlik | 15 dk |
| 9 | Docker build COPY'leri eksik | `docker/Dockerfile.hardened:39-53` | Build | 30 dk |
| 10 | Docker runtime 127.0.0.1 binding | `src/channels/web/channel.ts:271` | Build | 30 dk |
| 11 | AgentDBMemory.retrieve semantic→TF-IDF bug | `src/memory/unified/agentdb-memory.ts:764` | Bellek | 30 dk |
| 12 | RAGPipeline sadece .cs indexliyor | `src/rag/rag-pipeline.ts:291` | RAG | 15 dk |

---

## 🟠 P1 -- Bu Hafta

| # | Sorun | Lokasyon | Kategori | Tahmini Sure |
|---|-------|----------|----------|--------------|
| 13 | Framework store bootstrap race condition | `src/core/bootstrap.ts:416` | Bootstrap | 2 saat |
| 14 | DI container kaldir veya gercek DI yap | `src/core/di-container.ts` | Bootstrap | 4 saat |
| 15 | SelfVault init kosullu (AGENTS.md ile celiski) | `src/core/bootstrap.ts:617` | Bootstrap | 30 dk |
| 16 | Vault applyDdl kaldir | `src/vault/sqlite-vault-store.ts:10` | Vault | 15 dk |
| 17 | Vault write-hook mutex | `src/vault/write-hook.ts:13` | Vault | 1 saat |
| 18 | GoalExecutor entegrasyonu veya sil | `src/goals/goal-executor.ts` | Goals | 4 saat |
| 19 | Circuit breaker recordSuccess fix | `src/daemon/resilience/circuit-breaker.ts:73` | Daemon | 30 dk |
| 20 | Deployment gate expired approval fix | `src/daemon/security/approval-queue.ts:84` | Daemon | 1 saat |
| 21 | Interactive chat cost tracking | `src/core/bootstrap.ts:805` | Budget | 1 saat |
| 22 | Agent cost double-counting kaldir | `src/agents/multi/agent-manager.ts:595` | Budget | 1 saat |
| 23 | canSpend pre-flight kontrolu | `src/budget/unified-budget-manager.ts:147` | Budget | 2 saat |
| 24 | Plugin sandbox veya PluginPermissions kaldir | `src/plugins/registry.ts:33` | Plugin | 2 saat |
| 25 | Skill dependency resolution fix | `src/skills/skill-manager.ts:84` | Skills | 1 saat |
| 26 | Teams turn context tasarim hatasi | `src/channels/teams/channel.ts:165` | Kanal | 2-4 saat |
| 27 | WhatsApp confirmation chatId key | `src/channels/whatsapp/client.ts:668` | Kanal | 30 dk |
| 28 | Matrix markdown→HTML bug | `src/channels/matrix/channel.ts:127` | Kanal | 30 dk |
| 29 | Terminal wizard kanal eksikligi | `src/core/terminal-wizard.ts:47` | Kanal | 15 dk |
| 30 | AccessCount unbounded skor | `src/memory/unified/agentdb-tiering.ts:74` | Bellek | 30 dk |
| 31 | HNSW remove hatasi Map/SQLite tutarsizligi | `src/memory/unified/agentdb-tiering.ts` | Bellek | 1 saat |
| 32 | AuthManager sadece 3 kanal | `src/security/auth.ts` | Guvenlik | 2 saat |
| 33 | PasswordHasher scryptSync → async | `src/security/auth-hardened.ts:252` | Guvenlik | 1 saat |
| 34 | Gunluk mesaj limiti ekle | `src/security/rate-limiter.ts:78` | Guvenlik | 30 dk |
| 35 | Confidence scoring tek model | `src/learning/scoring/confidence-scorer.ts` | Learning | 2 saat |
| 36 | Kullanici feedback lifecycle'a yansit | `src/learning/feedback/feedback-handler.ts:29` | Learning | 1 saat |
| 37 | Cross-level DAG dependsOn remap | `src/goals/goal-decomposer.ts:404` | Goals | 1 saat |
| 38 | Saga rollback timer cleanup | `src/learning/chains/chain-rollback.ts:109` | Daemon | 30 dk |
| 39 | Task pause touchedFiles | `src/tasks/task-manager.ts:145` | Tasks | 30 dk |
| 40 | Supervisor kanal basina isolation | `src/supervisor/supervisor-brain.ts` | Supervisor | 2 saat |
| 41 | Orchestrator alt modullerine test | `src/agents/orchestrator-*.ts` (8 modul) | Test | 8 saat |
| 42 | Duplicate test'leri coz | `src/tests/unit/` vs `src/*/` | Test | 2 saat |
| 43 | Web portal reconnect exhaustion | `web-portal/src/hooks/useWebSocket.ts:299` | Web Portal | 30 dk |
| 44 | Ana orchestrator butce kaydi | `src/agents/orchestrator-supervisor-routing.ts:611` | Provider | 1 saat |
| 45 | PROVIDER_COSTS 5 provider ekle | `src/budget/cost-model.ts:10` | Provider | 1 saat |
| 46 | maxTokensAbort finish() cagrisi | `src/agents/orchestrator.ts:3258` | Orchestrator | 30 dk |
| 47 | streamResponse dead code kaldir | `src/agents/orchestrator.ts:5289` | Orchestrator | 15 dk |
| 48 | Context window butce hesaplamasi | `src/agents/orchestrator-context-builder.ts:566` | Orchestrator | 1 saat |
| 49 | getSnapshot agentExceeded doldur | `src/budget/unified-budget-manager.ts:114` | Budget | 30 dk |
| 50 | Delegation gercek token usage | `src/agents/multi/delegation/delegation-manager.ts:856` | Budget | 1 saat |
| 51 | Hot-reload gercekten reload yapmiyor | `src/skills/skill-loader.ts:166` | Skills | 2 saat |
| 52 | Dynamic tool auto-deprecation | `src/agents/tools/dynamic/dynamic-tool-factory.ts:70` | Tools | 2 saat |
| 53 | Nginx ↔ Docker Compose port uyumu | `nginx/nginx.conf:81` | Build | 30 dk |
| 54 | Docker Compose nginx servisi ekle | `docker/docker-compose.security.yml` | Build | 30 dk |
| 55 | createLogger singleton fix | `src/utils/logger.ts:71` | Logging | 1 saat |
| 56 | Duplicate global error handlers | `src/index.ts:869` + `src/common/errors.ts:515` | Error | 1 saat |
| 57 | secretPatterns dead code kaldir | `src/config/config.ts:2540` | Config | 15 dk |
| 58 | config.ts monolitik dosya bol | `src/config/config.ts` | Config | 4 saat |

---

## 🟡 P2 -- Bu Ay

| # | Sorun | Lokasyon | Kategori |
|---|-------|----------|----------|
| 59 | Bootstrap DAG-based execution engine | `src/core/bootstrap.ts` | Bootstrap |
| 60 | MetricsStorage cift olusturma | `src/core/bootstrap-stages/stage-runtime.ts:56` | Bootstrap |
| 61 | Shutdown parallelize et | `src/core/bootstrap-wiring.ts:189` | Bootstrap |
| 62 | sendSystemMessage diger kanallara | `src/channels/*/channel.ts` | Kanal |
| 63 | Matrix streaming + confirmation | `src/channels/matrix/channel.ts` | Kanal |
| 64 | Teams streaming + confirmation | `src/channels/teams/channel.ts` | Kanal |
| 65 | Web streamSentLengths leak fix | `src/channels/web/channel.ts:601` | Kanal |
| 66 | compact freedBytes hesapla | `src/memory/unified/agentdb-memory.ts:965` | Bellek |
| 67 | retrieveTFIDF erisim metrikleri | `src/memory/unified/agentdb-retrieval.ts` | Bellek |
| 68 | consolidation-engine tip genislet | `src/memory/unified/consolidation-types.ts:99` | Bellek |
| 69 | vault_embeddings index_version | `src/vault/schema.sql:33` | Vault |
| 70 | .js dosyalarini vault'a ekle | `src/vault/discovery.ts:13` | Vault |
| 71 | VaultRegistry butce kontrolu | `src/vault/vault-registry.ts:68` | Vault |
| 72 | Magic bytes coverage artir | `src/utils/media-processor.ts:55` | Guvenlik |
| 73 | isUrlSafeToFetch allowlist | `src/utils/media-processor.ts:173` | Guvenlik |
| 74 | IPv6 literal private range | `src/utils/media-processor.ts:201` | Guvenlik |
| 75 | Prompt injection sanitization | `src/security/` yeni modul | Guvenlik |
| 76 | sanitizeInput entegrasyonu | `src/validation/schemas.ts:108` | Guvenlik |
| 77 | Learning ↔ Memory Store bridge | `src/learning/storage/learning-storage.ts` | Learning |
| 78 | Framework knowledge runtime etkisi | `src/intelligence/framework/` | Intelligence |
| 79 | Cross-level DAG validation | `src/goals/goal-decomposer.ts:239` | Goals |
| 80 | Delegation depth limit dis mekanizmalar | `src/agents/multi/delegation/delegation-tool.ts:126` | Delegation |
| 81 | Compensating action idempotent dokumante | `src/learning/chains/composite-tool.ts` | Daemon |
| 82 | pruneTriggerFireHistory optimize | `src/daemon/heartbeat-loop.ts:188` | Daemon |
| 83 | activeTriggerTasks TaskId cast | `src/daemon/heartbeat-loop.ts:392` | Daemon |
| 84 | executeWithTimeout cleanup | `src/supervisor/supervisor-dispatcher.ts:602` | Supervisor |
| 85 | taskWorkspaceLease idempotent | `src/tasks/background-executor.ts:1001` | Tasks |
| 86 | FailureBudget edge case | `src/supervisor/supervisor-dispatcher.ts:86` | Supervisor |
| 87 | Dashboard route test'leri | `src/dashboard/server-*.ts` (7 route) | Test |
| 88 | Skip edilen test'leri fixle | `src/**/*.test.ts` (9 skip) | Test |
| 89 | Test helper duplication coz | `src/test-helpers.ts` vs `src/tests/helpers/` | Test |
| 90 | as any kullanimini azalt | `src/agents/*.test.ts` | Test |
| 91 | WS rate limit frontend | `web-portal/src/hooks/useWebSocket.ts` | Web Portal |
| 92 | tldraw-vendor chunk kaldir | `web-portal/vite.config.ts:35` | Web Portal |
| 93 | @types/d3-force devDependencies | `web-portal/package.json:31` | Web Portal |
| 94 | Gemini chatStream super kullan | `src/agents/providers/gemini.ts:124` | Provider |
| 95 | chatStream usage fallback | `src/agents/providers/openai.ts:132` | Provider |
| 96 | KimiProvider User-Agent duzelt | `src/agents/providers/kimi.ts:51` | Provider |
| 97 | DeepSeek cacheCreationInputTokens | `src/agents/providers/deepseek.ts:75` | Provider |
| 98 | Provider hata normalizasyonu | `src/agents/providers/fallback-chain.ts:36` | Provider |
| 99 | sessionManager.persistTimeMap encapsulate | `src/agents/orchestrator.ts:2740` | Orchestrator |
| 100 | buildProjectWorldMemoryLayer birlestir | `src/agents/orchestrator-context-builder.ts:76` | Orchestrator |
| 101 | shouldSynthesize fix | `src/agents/orchestrator-end-turn-handler.ts:87` | Orchestrator |
| 102 | handleMessage explicit recovery | `src/agents/orchestrator.ts:2495` | Orchestrator |
| 103 | vaultWriteHook tum write ops | `src/agents/orchestrator.ts:6976` | Orchestrator |
| 104 | Retry cost explicit belge | `src/agents/orchestrator.ts:3141` | Budget |
| 105 | Cancelled task refund politikasi | `src/tasks/background-executor.ts` | Budget |
| 106 | interactiveTokenBudget env fallback | `src/budget/budget-config-store.ts:84` | Budget |
| 107 | Background executor model ID | `src/tasks/background-executor.ts:1020` | Budget |
| 108 | DEFAULT_COST dusur | `src/budget/cost-model.ts:22` | Budget |
| 109 | checkAndEmitEvents interactive loop | `src/daemon/heartbeat-loop.ts:256` | Budget |
| 110 | skill enable/disable mesaj fix | `src/skills/skill-cli.ts:118` | Skills |
| 111 | installSkillFromRepo rollback | `src/skills/skill-installer.ts:88` | Skills |
| 112 | readSkillConfig boolean fix | `src/skills/skill-config.ts:33` | Skills |
| 113 | YAML parser dokumante | `src/skills/frontmatter-parser.ts:112` | Skills |
| 114 | create_tool existingToolNames gec | `src/agents/tools/dynamic/create-tool.ts:133` | Tools |
| 115 | Composite tool create-time validate | `src/agents/tools/dynamic/dynamic-tool-factory.ts:289` | Tools |
| 116 | COMPOSITE_BLOCKED_TOOLS guncelle | `src/agents/tools/dynamic/dynamic-tool-factory.ts:16` | Tools |
| 117 | Plugin tool metadata oku | `src/core/tool-registry.ts:170` | Plugin |
| 118 | unregister transitive dependents | `src/plugins/registry.ts:116` | Plugin |
| 119 | new Error → AppError migration | `src/` (164 dosya) | Common |
| 120 | console.* → getLoggerSafe migration | `src/` (17 dosya) | Common |
| 121 | Rate limiter abstraction | `src/common/rate-limiting.ts` yeni | Common |
| 122 | withRetry + fetchWithRetry birlestir | `src/common/errors.ts:561` | Common |
| 123 | CHANNEL_LIMITS tum kanallar | `src/utils/diff-formatter.ts:10` | Common |
| 124 | common/index.ts barrel karari | `src/common/index.ts` | Common |
| 125 | ValidationResult birlestir | `src/types/index.ts:245` | Types |
| 126 | ValidationError birlestir | `src/types/index.ts:250` | Types |
| 127 | FilePath brand yap | `src/types/index.ts:33` | Types |
| 128 | TaskId Brand helper'a gec | `src/tasks/types.ts:15` | Types |
| 129 | mapResult cast'leri kaldir | `src/types/index.ts:150` | Types |
| 130 | JsonObject interface yap | `src/types/index.ts` | Types |
| 131 | Error swallowing pattern'leri incele | `src/**/*.ts` | Error |
| 132 | String(err) sanitize et | `src/agents/orchestrator.ts:1226` | Error |
| 133 | AppError subclass kullanimi | `src/channels/*`, `src/vault/*` | Error |
| 134 | wrapError Error.cause destegi | `src/common/errors.ts:485` | Error |
| 135 | withRetry error.code kullan | `src/common/errors.ts:561` | Error |
| 136 | EventBus hata stratejisi | `src/core/event-bus.ts:313` | Error |
| 137 | Portal build fail durdur | `scripts/build-package.mjs:38` | Build |
| 138 | tsc asset kopyalama | `scripts/build-package.mjs` | Build |
| 139 | Build pipeline typecheck+lint | `scripts/build-package.mjs:30` | Build |
| 140 | Docker Bench path'ler guncelle | `docker/security-scan.sh:57` | Build |
| 141 | SSL key size 4096 | `scripts/generate-ssl.sh:32` | Build |
| 142 | security-scanner rootless | `docker/docker-compose.security.yml:99` | Build |

---

## 🟢 P3 -- Gelecek Sprint'ler

| # | Sorun | Lokasyon | Kategori |
|---|-------|----------|----------|
| 143 | config.ts monolitik bol | `src/config/config.ts` | Config |
| 144 | Vault bootstrap duplicate import | `src/core/bootstrap.ts:619` | Bootstrap |
| 145 | Telegram timeout 5dk yap | `src/channels/telegram/bot.ts:198` | Kanal |
| 146 | Discord typing queue | `src/channels/discord/bot.ts:426` | Kanal |
| 147 | CLI type guard fix | `src/channels/cli/repl.ts:103` | Kanal |
| 148 | streamSentLengths TTL cleanup | `src/channels/web/channel.ts:601` | Kanal |
| 149 | consolidation-engine getStats ad | `src/memory/unified/consolidation-engine.ts:782` | Bellek |
| 150 | readonly embedding cast | `src/memory/unified/agentdb-memory.ts:1295` | Bellek |
| 151 | EmbeddingQueue flush zorla | `src/learning/pipeline/embedding-queue.ts:54` | Learning |
| 152 | EmbeddingCache model degisimi | `src/rag/embeddings/embedding-cache.ts:191` | RAG |
| 153 | System prompt butce hesabi | `src/agents/orchestrator-context-builder.ts:566` | Orchestrator |
| 154 | VaultInitTool context registry | `src/agents/tools/vault-init-tool.ts:13` | Tools |
| 155 | getRecommendedMaxMessages fix | `src/agents/orchestrator.ts:2766` | Orchestrator |
| 156 | runCompletionReviewStages config | `src/agents/orchestrator.ts:6060` | Orchestrator |
| 157 | goal-decomposition rollback | `src/agents/orchestrator-goal-decomposition.ts:86` | Orchestrator |
| 158 | Ollama streaming capability | `src/agents/providers/ollama.ts:19` | Provider |
| 159 | isAvailable gercek health check | `src/agents/providers/provider-health.ts:278` | Provider |
| 160 | model-intelligence sync | `src/agents/providers/model-intelligence.ts:51` | Provider |
| 161 | isSourceExceeded kullan | `src/budget/unified-budget-manager.ts:133` | Budget |
| 162 | BudgetConfigStore val pattern | `src/budget/budget-config-store.ts:84` | Budget |
| 163 | Type duplicate'larini coz (21+) | `src/` | Types |
| 164 | as any production (15 adet) | `src/` | Types |
| 165 | Test mock'larinda as any azalt | `src/**/*.test.ts` | Test |
| 166 | AGENTS.md guncelle | `AGENTS.md` | Docs |
| 167 | PROJECT.md kanal/tool/provider sayisi | `.planning/PROJECT.md` | Docs |
| 168 | README badge guncelle | `README.md` | Docs |
| 169 | README Project Structure | `README.md:1288` | Docs |
| 170 | eksik README'ler olustur | `src/goals/`, `src/daemon/`, `src/vault/` | Docs |
| 171 | STATE.md guncelle | `.planning/STATE.md` | Docs |
| 172 | Test sayisi senkronizasyonu | `README.md` + `.planning/` | Docs |

---

*Toplam 172 eylem maddesi*
