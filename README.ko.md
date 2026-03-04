<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Unity / Strada.Core 프로젝트를 위한 AI 개발 에이전트</strong><br/>
  웹 대시보드, Telegram, Discord, Slack, WhatsApp 또는 터미널에 연결되는 자율 코딩 에이전트 &mdash; 코드베이스를 읽고, 코드를 작성하고, 빌드를 실행하고, 실수로부터 학습합니다.
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
  <a href="README.ja.md">日本語</a> |
  <strong>한국어</strong> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

---

## 이것은 무엇인가요?

Strada.Brain은 채팅 채널을 통해 대화하는 AI 에이전트입니다. 원하는 것을 설명하면 &mdash; "플레이어 이동을 위한 새로운 ECS 시스템 생성" 또는 "health를 사용하는 모든 컴포넌트 찾기" &mdash; 에이전트가 C# 프로젝트를 읽고, 코드를 작성하고, `dotnet build`를 실행하고, 에러를 자동으로 수정하고, 결과를 전송합니다. 영구적인 메모리를 갖고 있으며, 과거 에러에서 학습하고, 자동 장애 조치가 가능한 여러 AI 공급자를 사용할 수 있습니다.

**이것은 라이브러리나 API가 아닙니다.** 독립 실행형 애플리케이션입니다. 채팅 플랫폼에 연결하여 디스크의 Unity 프로젝트를 읽고, 구성한 범위 내에서 자율적으로 작동합니다.

---

## 빠른 시작

### 사전 요구사항

- **Node.js 20+** 및 npm
- **Anthropic API 키** (Claude) &mdash; 다른 공급자는 선택 사항
- **Unity 프로젝트** (Strada.Core 프레임워크 사용, 에이전트에게 전달할 경로)

### 1. 설치

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. 구성

```bash
cp .env.example .env
```

`.env`를 열고 최소한 다음을 설정하세요:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Claude API 키
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Assets/를 포함해야 함
JWT_SECRET=<생성 방법: openssl rand -hex 64>
```

### 3. 실행

```bash
# 웹 채널 (기본값) - 설정 마법사가 localhost:3000에서 열림
# .env가 없으면 마법사가 초기 설정을 안내합니다
npm start

# 또는 웹 채널을 명시적으로 사용
npm run dev -- start --channel web

# 인터랙티브 CLI 모드 (가장 빠른 테스트 방법)
npm run dev -- cli

# 또는 다른 채팅 채널로
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. 대화하기

실행 후 구성된 채널을 통해 메시지를 보내세요:

```
> 프로젝트 구조를 분석해줘
> DamageSystem과 HealthComponent가 포함된 "Combat"이라는 새 모듈을 만들어줘
> PositionComponent를 쿼리하는 모든 시스템을 찾아줘
> 빌드를 실행하고 에러를 수정해줘
```

**웹 채널:** 터미널이 필요 없습니다 &mdash; `localhost:3000`에서 웹 대시보드를 통해 상호작용합니다.

---

## 아키텍처

```
+-----------------------------------------------------------------+
|  채팅 채널                                                       |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter 인터페이스
                               |
+------------------------------v----------------------------------+
|  오케스트레이터 (에이전트 루프)                                    |
|  시스템 프롬프트 + 메모리 + RAG 컨텍스트 -> LLM -> 도구 호출      |
|  메시지당 최대 50회 도구 반복                                     |
|  자율성: 에러 복구, 정체 감지, 빌드 검증                          |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| AI 공급자      |  | 30+ 도구       |  | 컨텍스트 소스       |
| Claude (주요)  |  | 파일 I/O       |  | 메모리 (TF-IDF)    |
| OpenAI, Kimi   |  | Git 작업       |  | RAG (HNSW 벡터)    |
| DeepSeek, Qwen |  | 셸 실행        |  | 프로젝트 분석       |
| MiniMax, Groq  |  | .NET 빌드/테스트|  | 학습 패턴          |
| Ollama (로컬)  |  | 브라우저        |  +--------------------+
| + 4개 추가     |  | Strata 코드 생성|
+----------------+  +----------------+
```

### 에이전트 루프의 작동 방식

1. **메시지 도착** — 채팅 채널에서 메시지 수신
2. **메모리 검색** — TF-IDF로 가장 관련성 높은 과거 대화 3건 검색
3. **RAG 검색** — C# 코드베이스에 대한 시맨틱 검색 (HNSW 벡터, 상위 6건)
4. **캐시된 분석** — 이전에 분석한 프로젝트 구조 주입
5. **LLM 호출** — 시스템 프롬프트 + 컨텍스트 + 도구 정의 전송
6. **도구 실행** — LLM이 도구를 호출하면 실행 후 결과를 LLM에 피드백
7. **자율 검사** — 에러 복구가 실패를 분석, 정체 감지기가 멈춤 상태 경고, `.cs` 파일이 수정된 경우 응답 전 `dotnet build` 강제 실행
8. **반복** — LLM이 최종 텍스트 응답을 생성할 때까지 최대 50회 반복
9. **응답 전송** — 채널을 통해 사용자에게 응답 (스트리밍 지원 시 스트리밍)

---

## 구성 레퍼런스

모든 구성은 환경 변수를 통해 이루어집니다. 전체 목록은 `.env.example`을 참조하세요.

### 필수

| 변수 | 설명 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API 키 (주요 LLM 공급자) |
| `UNITY_PROJECT_PATH` | Unity 프로젝트 루트의 절대 경로 (`Assets/` 포함 필수) |
| `JWT_SECRET` | JWT 서명용 시크릿. 생성 방법: `openssl rand -hex 64` |

### AI 공급자

OpenAI 호환 공급자라면 어떤 것이든 작동합니다. 아래 공급자는 모두 구현되어 있으며 API 키만 설정하면 활성화됩니다.

| 변수 | 공급자 | 기본 모델 |
|------|--------|-----------|
| `ANTHROPIC_API_KEY` | Claude (주요) | `claude-sonnet-4-20250514` |
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
| `OLLAMA_BASE_URL` | Ollama (로컬) | `llama3` |
| `PROVIDER_CHAIN` | 폴백 순서 | 예: `claude,kimi,deepseek,ollama` |

**공급자 체인:** `PROVIDER_CHAIN`에 공급자 이름을 쉼표로 구분하여 설정합니다. 시스템은 순서대로 시도하며, 실패 시 다음으로 폴백합니다. 예: `PROVIDER_CHAIN=kimi,deepseek,claude`는 Kimi를 먼저 사용하고, Kimi가 실패하면 DeepSeek, 그다음 Claude를 사용합니다.

### 채팅 채널

**Web:**
| 변수 | 설명 |
|------|------|
| `WEB_CHANNEL_PORT` | 웹 대시보드 포트 (기본값: `3000`) |

**Telegram:**
| 변수 | 설명 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | @BotFather에서 발급받은 토큰 |
| `ALLOWED_TELEGRAM_USER_IDS` | 쉼표로 구분된 Telegram 사용자 ID (필수, 비어 있으면 전체 거부) |

**Discord:**
| 변수 | 설명 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord 봇 토큰 |
| `DISCORD_CLIENT_ID` | Discord 애플리케이션 클라이언트 ID |
| `ALLOWED_DISCORD_USER_IDS` | 쉼표로 구분된 사용자 ID (비어 있으면 전체 거부) |
| `ALLOWED_DISCORD_ROLE_IDS` | 역할 기반 접근을 위한 쉼표로 구분된 역할 ID |

**Slack:**
| 변수 | 설명 |
|------|------|
| `SLACK_BOT_TOKEN` | `xoxb-...` 봇 토큰 |
| `SLACK_APP_TOKEN` | `xapp-...` 앱 레벨 토큰 (소켓 모드용) |
| `SLACK_SIGNING_SECRET` | Slack 앱의 서명 시크릿 |
| `ALLOWED_SLACK_USER_IDS` | 쉼표로 구분된 사용자 ID (**비어 있으면 모든 사용자에게 개방**) |
| `ALLOWED_SLACK_WORKSPACES` | 쉼표로 구분된 워크스페이스 ID (**비어 있으면 모든 워크스페이스에 개방**) |

**WhatsApp:**
| 변수 | 설명 |
|------|------|
| `WHATSAPP_SESSION_PATH` | 세션 파일 디렉터리 (기본값: `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | 쉼표로 구분된 전화번호 |

### 기능

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `RAG_ENABLED` | `true` | C# 프로젝트에 대한 시맨틱 코드 검색 활성화 |
| `EMBEDDING_PROVIDER` | `openai` | 임베딩 공급자: `openai` 또는 `ollama` |
| `MEMORY_ENABLED` | `true` | 영구 대화 메모리 활성화 |
| `MEMORY_DB_PATH` | `.strata-memory` | 메모리 데이터베이스 파일 디렉터리 |
| `WEB_CHANNEL_PORT` | `3000` | 웹 대시보드 포트 |
| `DASHBOARD_ENABLED` | `false` | HTTP 모니터링 대시보드 활성화 |
| `DASHBOARD_PORT` | `3001` | 대시보드 서버 포트 |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket 실시간 대시보드 활성화 |
| `ENABLE_PROMETHEUS` | `false` | Prometheus 메트릭 엔드포인트 활성화 (포트 9090) |
| `READ_ONLY_MODE` | `false` | 모든 쓰기 작업 차단 |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` 또는 `debug` |

### 속도 제한

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `RATE_LIMIT_ENABLED` | `false` | 속도 제한 활성화 |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | 사용자당 분당 메시지 제한 (0 = 무제한) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | 사용자당 시간당 제한 |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | 글로벌 일일 토큰 할당량 |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | 일일 지출 한도 (USD) |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | 월간 지출 한도 (USD) |

### 보안

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `REQUIRE_MFA` | `false` | 다중 인증 요구 |
| `BROWSER_HEADLESS` | `true` | 브라우저 자동화를 헤드리스로 실행 |
| `BROWSER_MAX_CONCURRENT` | `5` | 최대 동시 브라우저 세션 수 |

---

## 도구

에이전트에는 카테고리별로 정리된 30개 이상의 내장 도구가 있습니다:

### 파일 작업
| 도구 | 설명 |
|------|------|
| `file_read` | 줄 번호 포함 파일 읽기, 오프셋/리밋 페이지네이션 (512KB 제한) |
| `file_write` | 파일 생성 또는 덮어쓰기 (256KB 제한, 디렉터리 자동 생성) |
| `file_edit` | 유일성 검증이 포함된 검색-대체 편집 |
| `file_delete` | 단일 파일 삭제 |
| `file_rename` | 프로젝트 내 파일 이름 변경 또는 이동 |
| `file_delete_directory` | 재귀적 디렉터리 삭제 (안전 한도 50 파일) |

### 검색
| 도구 | 설명 |
|------|------|
| `glob_search` | glob 패턴으로 파일 검색 (최대 50건) |
| `grep_search` | 파일 전체에 걸친 정규식 콘텐츠 검색 (최대 20건) |
| `list_directory` | 파일 크기 포함 디렉터리 목록 |
| `code_search` | RAG를 통한 시맨틱/벡터 검색 &mdash; 자연어 쿼리 |
| `memory_search` | 영구 대화 메모리 검색 |

### Strada 코드 생성
| 도구 | 설명 |
|------|------|
| `strata_analyze_project` | C# 프로젝트 전체 스캔 &mdash; 모듈, 시스템, 컴포넌트, 서비스 |
| `strata_create_module` | 완전한 모듈 스캐폴드 생성 (`.asmdef`, 구성, 디렉터리) |
| `strata_create_component` | 필드 정의가 포함된 ECS 컴포넌트 구조체 생성 |
| `strata_create_mediator` | 컴포넌트 바인딩이 포함된 `EntityMediator<TView>` 생성 |
| `strata_create_system` | `SystemBase`/`JobSystemBase`/`SystemGroup` 생성 |

### Git
| 도구 | 설명 |
|------|------|
| `git_status` | 작업 트리 상태 |
| `git_diff` | 변경 사항 표시 |
| `git_log` | 커밋 이력 |
| `git_commit` | 스테이지 및 커밋 |
| `git_push` | 리모트에 푸시 |
| `git_branch` | 브랜치 목록, 생성 또는 체크아웃 |
| `git_stash` | 스태시 push, pop, list 또는 drop |

### .NET / Unity
| 도구 | 설명 |
|------|------|
| `dotnet_build` | `dotnet build` 실행, MSBuild 에러를 구조화된 출력으로 파싱 |
| `dotnet_test` | `dotnet test` 실행, 통과/실패/스킵 결과 파싱 |

### 기타
| 도구 | 설명 |
|------|------|
| `shell_exec` | 셸 명령 실행 (30초 타임아웃, 위험 명령 차단 목록) |
| `code_quality` | 파일별 또는 프로젝트별 코드 품질 분석 |
| `rag_index` | 증분 또는 전체 프로젝트 재인덱싱 트리거 |

---

## 채널 기능

| 기능 | Telegram | Discord | Slack | WhatsApp | CLI |
|------|----------|---------|-------|----------|-----|
| 텍스트 메시징 | 지원 | 지원 | 지원 | 지원 | 지원 |
| 스트리밍 (인플레이스 편집) | 지원 | 지원 | 지원 | 지원 | 지원 |
| 입력 중 표시기 | 지원 | 지원 | 미지원 | 지원 | 미지원 |
| 확인 대화상자 | 지원 (인라인 키보드) | 지원 (버튼) | 지원 (Block Kit) | 지원 (번호 답장) | 지원 (readline) |
| 파일 업로드 | 미지원 | 미지원 | 지원 | 지원 | 미지원 |
| 스레드 지원 | 미지원 | 지원 | 지원 | 미지원 | 미지원 |
| 속도 제한기 (아웃바운드) | 미지원 | 지원 (토큰 버킷) | 지원 (4단계 슬라이딩 윈도우) | 인라인 스로틀 | 미지원 |

### 스트리밍

모든 채널에서 인플레이스 편집 스트리밍을 구현합니다. LLM이 생성하는 대로 에이전트의 응답이 점진적으로 표시됩니다. 속도 제한을 피하기 위해 플랫폼별로 업데이트 빈도가 조절됩니다 (WhatsApp/Discord: 1회/초, Slack: 2회/초).

### 인증

- **Telegram**: 기본적으로 전체 거부. `ALLOWED_TELEGRAM_USER_IDS` 설정 필수.
- **Discord**: 기본적으로 전체 거부. `ALLOWED_DISCORD_USER_IDS` 또는 `ALLOWED_DISCORD_ROLE_IDS` 설정 필수.
- **Slack**: **기본적으로 전체 개방.** `ALLOWED_SLACK_USER_IDS`가 비어 있으면 모든 Slack 사용자가 봇에 접근 가능. 프로덕션에서는 허용 목록을 설정하세요.
- **WhatsApp**: 어댑터 내에서 로컬로 확인되는 `WHATSAPP_ALLOWED_NUMBERS` 허용 목록 사용.

---

## 메모리 시스템

프로덕션 메모리 백엔드는 `FileMemoryManager`입니다 &mdash; JSON 파일과 TF-IDF 텍스트 인덱싱을 통한 검색.

**작동 방식:**
- 세션 이력이 40개 메시지를 초과하면 이전 메시지가 요약되어 대화 항목으로 저장
- 각 LLM 호출 전에 에이전트가 가장 관련성 높은 메모리 3건을 자동 검색
- `strata_analyze_project` 도구가 프로젝트 구조 분석을 캐시하여 즉시 컨텍스트 주입
- 메모리는 `MEMORY_DB_PATH` 디렉터리(기본값: `.strata-memory/`)에 영구 저장되어 재시작 후에도 유지

**고급 백엔드 (구현 완료, 미연결):** `AgentDBMemory` &mdash; SQLite + HNSW 벡터 검색, 3단계 메모리 (워킹/임시/영구), 하이브리드 검색 (70% 시맨틱 + 30% TF-IDF). 완전히 코딩되었지만 부트스트랩에서 연결되지 않았습니다. `FileMemoryManager`가 현재 활성 백엔드입니다.

---

## RAG 파이프라인

RAG (검색 증강 생성) 파이프라인은 C# 소스 코드를 인덱싱하여 시맨틱 검색을 가능하게 합니다.

**인덱싱 흐름:**
1. Unity 프로젝트 내 `**/*.cs` 파일 스캔
2. 코드를 구조적으로 청크 분할 &mdash; 파일 헤더, 클래스, 메서드, 생성자
3. OpenAI (`text-embedding-3-small`) 또는 Ollama (`nomic-embed-text`)로 임베딩 생성
4. 빠른 근사 최근접 이웃 검색을 위해 HNSW 인덱스에 벡터 저장
5. 시작 시 백그라운드에서 자동 실행 (논블로킹)

**검색 흐름:**
1. 동일한 공급자로 쿼리를 임베딩
2. HNSW 검색이 `topK * 3` 후보 반환
3. 리랭커 스코어링: 벡터 유사도 (60%) + 키워드 겹침 (25%) + 구조 보너스 (15%)
4. 점수 0.2 이상의 상위 6건이 LLM 컨텍스트에 주입

**참고:** RAG 파이프라인은 현재 C# 파일만 지원합니다. 청커는 C# 전용입니다.

---

## 학습 시스템

학습 시스템은 에이전트의 동작을 관찰하고 에러에서 학습합니다:

- **에러 패턴**이 전문 검색 인덱싱과 함께 캡처됨
- **솔루션**이 에러 패턴에 연결되어 향후 검색에 활용
- **인스팅트**는 베이지안 신뢰도 점수가 포함된 원자적 학습 동작
- **트라젝토리**는 도구 호출 시퀀스와 결과를 기록
- 신뢰도 점수는 통계적 타당성을 위해 **Elo 레이팅**과 **Wilson 점수 구간**을 사용
- 신뢰도 0.3 미만의 인스팅트는 폐기, 0.9 이상은 승격 후보

학습 파이프라인은 타이머로 실행: 패턴 감지는 5분마다, 진화 제안은 1시간마다. 데이터는 별도의 SQLite 데이터베이스(`learning.db`)에 저장됩니다.

---

## 보안

### 레이어 1: 채널 인증
플랫폼별 허용 목록이 메시지 도착 시 (모든 처리 전에) 확인됩니다.

### 레이어 2: 속도 제한
사용자별 슬라이딩 윈도우 (분/시간) + 글로벌 일일/월간 토큰 및 USD 예산 한도.

### 레이어 3: 경로 가드
모든 파일 작업에서 심볼릭 링크를 해석하고 경로가 프로젝트 루트 내에 있는지 검증. 30개 이상의 민감한 패턴 차단 (`.env`, `.git/credentials`, SSH 키, 인증서, `node_modules/`).

### 레이어 4: 시크릿 새니타이저
24개의 정규식 패턴이 모든 도구 출력에서 LLM에 도달하기 전에 자격 증명을 감지하고 마스킹합니다. 대상: OpenAI 키, GitHub 토큰, Slack/Discord/Telegram 토큰, AWS 키, JWT, Bearer 인증, PEM 키, 데이터베이스 URL, 일반 시크릿 패턴.

### 레이어 5: 읽기 전용 모드
`READ_ONLY_MODE=true`인 경우, 23개의 쓰기 도구가 에이전트의 도구 목록에서 완전히 제거됩니다 &mdash; LLM은 호출을 시도할 수조차 없습니다.

### 레이어 6: 작업 확인
쓰기 작업 (파일 쓰기, Git 커밋, 셸 실행)은 채널의 인터랙티브 UI (버튼, 인라인 키보드, 텍스트 프롬프트)를 통해 사용자 확인을 요구할 수 있습니다.

### 레이어 7: 도구 출력 새니타이제이션
모든 도구 결과는 8192자로 제한되며, LLM에 피드백하기 전에 API 키 패턴이 제거됩니다.

### 레이어 8: RBAC (내부)
5개의 역할 (superadmin, admin, developer, viewer, service)과 9개의 리소스 유형을 포괄하는 권한 매트릭스. 정책 엔진은 시간 기반, IP 기반, 커스텀 조건을 지원합니다.

---

## 대시보드 및 모니터링

### HTTP 대시보드 (`DASHBOARD_ENABLED=true`)
`http://localhost:3001`에서 접근 가능 (localhost 전용). 표시 항목: 가동 시간, 메시지 수, 토큰 사용량, 활성 세션, 도구 사용 현황 테이블, 보안 통계. 3초마다 자동 새로고침.

### 헬스 엔드포인트
- `GET /health` &mdash; 생존 확인 프로브 (`{"status":"ok"}`)
- `GET /ready` &mdash; 심층 준비 상태: 메모리 및 채널 상태 확인. 200 (준비 완료), 207 (저하 상태) 또는 503 (준비 안 됨) 반환

### Prometheus (`ENABLE_PROMETHEUS=true`)
`http://localhost:9090/metrics`에서 메트릭 제공. 메시지, 도구 호출, 토큰의 카운터. 요청 시간, 도구 실행 시간, LLM 레이턴시의 히스토그램. 기본 Node.js 메트릭 (CPU, 힙, GC, 이벤트 루프).

### WebSocket 대시보드 (`ENABLE_WEBSOCKET_DASHBOARD=true`)
매초 실시간 메트릭 푸시. 인증된 연결 및 원격 명령 (플러그인 리로드, 캐시 클리어, 로그 조회) 지원.

---

## 배포

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml`에는 애플리케이션, 모니터링 스택, nginx 리버스 프록시가 포함되어 있습니다.

### 데몬 모드

```bash
# 크래시 시 지수 백오프로 자동 재시작 (1초~60초, 최대 10회)
node dist/index.js daemon --channel telegram
```

### 프로덕션 체크리스트

- [ ] `NODE_ENV=production` 설정
- [ ] `LOG_LEVEL=warn` 또는 `error` 설정
- [ ] `RATE_LIMIT_ENABLED=true`를 예산 한도와 함께 설정
- [ ] 채널 허용 목록 설정 (특히 Slack &mdash; 기본적으로 개방)
- [ ] 안전한 탐색만 원할 경우 `READ_ONLY_MODE=true` 설정
- [ ] 모니터링을 위해 `DASHBOARD_ENABLED=true` 활성화
- [ ] 메트릭 수집을 위해 `ENABLE_PROMETHEUS=true` 활성화
- [ ] 강력한 `JWT_SECRET` 생성

---

## 테스트

```bash
npm test                         # 전체 1560+ 테스트 실행
npm run test:watch               # 워치 모드
npm test -- --coverage           # 커버리지 포함
npm test -- src/agents/tools/file-read.test.ts  # 단일 파일
npm run typecheck                # TypeScript 타입 체크
npm run lint                     # ESLint
```

94개의 테스트 파일이 커버: 에이전트, 채널, 보안, RAG, 메모리, 학습, 대시보드, 통합 플로우.

---

## 프로젝트 구조

```
src/
  index.ts              # CLI 진입점 (Commander.js)
  core/
    bootstrap.ts        # 전체 초기화 시퀀스 — 모든 연결이 여기서 이루어짐
    di-container.ts     # DI 컨테이너 (사용 가능하나 수동 연결이 주류)
    tool-registry.ts    # 도구 인스턴스화 및 등록
  agents/
    orchestrator.ts     # 코어 에이전트 루프, 세션 관리, 스트리밍
    autonomy/           # 에러 복구, 작업 계획, 자체 검증
    context/            # 시스템 프롬프트 (Strada.Core 지식 베이스)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + 기타
    tools/              # 30+ 도구 구현
    plugins/            # 외부 플러그인 로더
  channels/
    telegram/           # Grammy 기반 봇
    discord/            # discord.js 봇 (슬래시 명령 포함)
    slack/              # Slack Bolt (소켓 모드) + Block Kit
    whatsapp/           # Baileys 기반 클라이언트 (세션 관리 포함)
    cli/                # Readline REPL
  memory/
    file-memory-manager.ts   # 활성 백엔드: JSON + TF-IDF
    unified/                 # AgentDB 백엔드: SQLite + HNSW (미연결)
  rag/
    rag-pipeline.ts     # 인덱스 + 검색 + 포맷 오케스트레이션
    chunker.ts          # C# 전용 구조적 청킹
    hnsw/               # HNSW 벡터 스토어 (hnswlib-node)
    embeddings/         # OpenAI 및 Ollama 임베딩 공급자
    reranker.ts         # 가중 리랭킹 (벡터 + 키워드 + 구조)
  security/             # 인증, RBAC, 경로 가드, 속도 제한기, 시크릿 새니타이저
  learning/             # 패턴 매칭, 신뢰도 스코어링, 인스팅트 라이프사이클
  intelligence/         # C# 파싱, 프로젝트 분석, 코드 품질
  dashboard/            # HTTP, WebSocket, Prometheus 대시보드
  config/               # Zod 검증 환경 구성
  validation/           # 입력 검증 스키마
```

---

## 기여

개발 환경 설정, 코드 컨벤션, PR 가이드라인은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

---

## 라이선스

MIT 라이선스 - 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.
