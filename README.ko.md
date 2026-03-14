<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain 로고" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>Unity / Strada.Core 프로젝트를 위한 AI 기반 개발 에이전트</strong><br/>
  웹 대시보드, Telegram, Discord, Slack, WhatsApp 또는 터미널에 연결되는 자율 코딩 에이전트 &mdash; 코드베이스를 읽고, 코드를 작성하고, 빌드를 실행하고, 실수로부터 학습하며, 24/7 데몬 루프로 자율 운영됩니다. 멀티 에이전트 오케스트레이션, 작업 위임, 메모리 통합, 승인 게이트가 포함된 배포 하위 시스템, 그리고 LLM 비전 지원을 포함한 미디어 공유를 탑재했습니다.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3220%2B-brightgreen?style=flat-square" alt="테스트">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="라이선스">
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <strong>&#54620;&#44397;&#50612;</strong> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## 이것은 무엇인가요?

Strada.Brain은 채팅 채널을 통해 대화하는 AI 에이전트입니다. 원하는 것을 설명하면 -- "플레이어 이동을 위한 새로운 ECS 시스템 생성" 또는 "health를 사용하는 모든 컴포넌트 찾기" -- 에이전트가 C# 프로젝트를 읽고, 코드를 작성하고, `dotnet build`를 실행하고, 에러를 자동으로 수정하고, 결과를 전송합니다.

SQLite + HNSW 벡터 기반의 영구 메모리를 갖추고 있으며, 하이브리드 가중 신뢰도 점수를 활용하여 과거 에러로부터 학습하고, 복잡한 목표를 병렬 DAG 실행으로 분해하고, saga 롤백이 포함된 다중 도구 체인을 자동 합성하며, 사전 트리거가 포함된 24/7 데몬으로 운영할 수 있습니다. 채널/세션별 격리가 포함된 멀티 에이전트 오케스트레이션, 계층적 작업 위임, 자동 메모리 통합, 그리고 휴먼 인 더 루프 승인 게이트와 서킷 브레이커 보호 기능이 포함된 배포 하위 시스템을 지원합니다.

**이것은 라이브러리나 API가 아닙니다.** 직접 실행하는 독립형 애플리케이션입니다. 채팅 플랫폼에 연결하여 디스크의 Unity 프로젝트를 읽고, 구성한 범위 내에서 자율적으로 작동합니다.

---

## 빠른 시작

### 사전 요구사항

- **Node.js 20+** 및 npm
- **Anthropic API 키** (Claude) -- 다른 공급자는 선택 사항
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

# 또는 웹 채널을 명시적으로 지정
npm run dev -- start --channel web

# 인터랙티브 CLI 모드 (가장 빠른 테스트 방법)
npm run dev -- cli

# 데몬 모드 (24/7 자율 운영, 사전 트리거 포함)
npm run dev -- daemon --channel web

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

**웹 채널:** 터미널이 필요 없습니다 -- `localhost:3000`에서 웹 대시보드를 통해 상호작용합니다.

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
|  오케스트레이터 (PAOR 에이전트 루프)                              |
|  계획 -> 행동 -> 관찰 -> 반성 상태 머신                          |
|  본능 검색, 실패 분류, 자동 재계획                                |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| AI 공급자    | | 30+ 도구   | | 컨텍스트   | | 학습 시스템      |
| Claude (주요)| | 파일 I/O   | | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git 작업   | | (SQLite +  | | 하이브리드 가중  |
| DeepSeek,Qwen| | 셸 실행    | |  HNSW)     | | 본능 라이프       |
| MiniMax, Groq| | .NET 빌드  | | RAG 벡터   | |  사이클           |
| Ollama +기타 | | Strada 생성| | 아이덴티티 | | 도구 체인         |
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

### 에이전트 루프의 작동 방식

1. **메시지 도착** -- 채팅 채널에서
2. **메모리 검색** -- AgentDB 하이브리드 검색 (70% 시맨틱 HNSW + 30% TF-IDF)으로 가장 관련성 높은 과거 대화 검색
3. **RAG 검색** -- C# 코드베이스 시맨틱 검색 (HNSW 벡터, 상위 6개 결과)
4. **본능 검색** -- 작업과 관련된 학습된 패턴을 사전 검색 (시맨틱 + 키워드 매칭)
5. **아이덴티티 컨텍스트** -- 영구 에이전트 아이덴티티 주입 (UUID, 부팅 횟수, 가동 시간, 크래시 복구 상태)
6. **계획 단계** -- LLM이 학습된 인사이트와 과거 실패를 반영하여 번호가 매겨진 계획 생성
7. **행동 단계** -- LLM이 계획에 따라 도구 호출 실행
8. **관찰** -- 결과 기록; 오류 복구가 실패 분석; 실패 분류기가 오류 분류
9. **반성** -- 3단계마다 (또는 오류 시), LLM이 결정: **계속**, **재계획**, 또는 **완료**
10. **자동 재계획** -- 동일 유형 실패가 3회 이상 연속되면, 실패한 전략을 피하는 새로운 접근 강제
11. **반복** -- 완료까지 최대 50회 반복
12. **학습** -- 도구 결과가 TypedEventBus를 통해 학습 파이프라인으로 흘러가 즉시 패턴 저장
13. **응답 전송** -- 채널을 통해 사용자에게 전송 (지원 시 스트리밍)

---

## 메모리 시스템

활성 메모리 백엔드는 `AgentDBMemory`입니다 -- SQLite와 HNSW 벡터 인덱싱, 그리고 3계층 자동 티어링 아키텍처를 갖추고 있습니다.

**3계층 메모리:**
- **워킹 메모리** -- 활성 세션 컨텍스트, 지속적 사용 후 자동 승격
- **임시 메모리** -- 단기 저장소, 용량 임계값에 도달하면 자동 제거
- **영구 메모리** -- 장기 저장소, 접근 빈도와 중요도에 따라 임시 메모리에서 승격

**작동 방식:**
- 세션 이력이 40개 메시지를 초과하면 이전 메시지가 요약되어 대화 항목으로 저장
- 하이브리드 검색이 70% 시맨틱 유사도 (HNSW 벡터)와 30% TF-IDF 키워드 매칭을 결합
- `strada_analyze_project` 도구가 프로젝트 구조 분석을 캐시하여 즉시 컨텍스트 주입
- 메모리는 `MEMORY_DB_PATH` 디렉터리 (기본값: `.strada-memory/`)에 영구 저장되어 재시작 후에도 유지
- 레거시 FileMemoryManager로부터의 자동 마이그레이션이 첫 시작 시 실행

**폴백:** AgentDB 초기화가 실패하면, 시스템이 자동으로 `FileMemoryManager` (JSON + TF-IDF)로 폴백합니다.

---

## 학습 시스템

학습 시스템은 에이전트의 동작을 관찰하고 이벤트 기반 파이프라인을 통해 에러로부터 학습합니다.

**이벤트 기반 파이프라인:**
- 도구 결과가 `TypedEventBus`를 통해 직렬 `LearningQueue`로 흘러가 즉시 처리
- 타이머 기반 배칭 없음 -- 패턴이 발생하는 즉시 감지 및 저장
- `LearningQueue`는 오류 격리가 포함된 제한 FIFO 사용 (학습 실패가 에이전트를 크래시시키지 않음)

**하이브리드 가중 신뢰도 점수:**
- 신뢰도 = 5가지 요소의 가중 합: 성공률 (0.35), 패턴 강도 (0.25), 최근성 (0.20), 컨텍스트 일치 (0.15), 검증 (0.05)
- 판정 점수 (0.0-1.0)가 신뢰 구간을 위한 알파/베타 증거 카운터를 업데이트
- 알파/베타 파라미터는 불확실성 추정을 위해 유지되지만 주요 신뢰도 계산에는 사용되지 않음

**본능 라이프사이클:**
- **제안됨** (신규) -- 신뢰도 0.7 미만
- **활성** -- 신뢰도 0.7에서 0.9 사이
- **진화** -- 0.9 이상, 영구 승격 후보
- **폐기** -- 0.3 미만, 제거 대상
- **냉각 기간** -- 상태 변경 전 최소 관찰 요구사항을 갖는 7일 기간
- **영구** -- 고정, 더 이상의 신뢰도 업데이트 없음

**능동적 검색:** 각 작업 시작 시 `InstinctRetriever`를 사용하여 본능을 사전 검색합니다. 키워드 유사성과 HNSW 벡터 임베딩으로 관련 학습 패턴을 검색하여 계획 단계 프롬프트에 주입합니다.

**교차 세션 학습:** 본능은 교차 세션 지식 전달을 위해 출처 메타데이터 (소스 세션, 세션 횟수)를 보유합니다.

---

## 목표 분해

복잡한 다단계 요청은 하위 목표의 방향성 비순환 그래프 (DAG)로 자동 분해됩니다.

**GoalDecomposer:**
- 휴리스틱 사전 검사가 간단한 작업에 대한 LLM 호출을 방지 (복잡도 지표에 대한 패턴 매칭)
- LLM이 의존성 간선과 선택적 재귀 깊이 (최대 3레벨)를 포함한 DAG 구조 생성
- Kahn 알고리즘이 비순환 DAG 구조를 검증
- 반응형 재분해: 노드가 실패하면 더 작은 복구 단계로 분할 가능

**GoalExecutor:**
- 웨이브 기반 병렬 실행이 의존성 순서를 준수
- 세마포어 기반 동시성 제한 (`GOAL_MAX_PARALLEL`)
- 실패 예산 (`GOAL_MAX_FAILURES`)과 사용자 대면 계속 진행 프롬프트
- LLM 중요도 평가가 실패한 노드가 의존 노드를 차단해야 하는지 결정
- 노드별 재시도 로직 (`GOAL_MAX_RETRIES`)과 소진 시 복구 분해
- 취소를 위한 AbortSignal 지원
- `GoalStorage` (SQLite)를 통한 영구 목표 트리 상태로 재시작 후 재개 가능

---

## 도구 체인 합성

에이전트가 다중 도구 체인 패턴을 자동으로 감지하고 재사용 가능한 복합 도구로 합성합니다. V2에서는 DAG 기반 병렬 실행과 복잡한 체인을 위한 saga 롤백이 추가되었습니다.

**파이프라인:**
1. **ChainDetector** -- 트라젝토리 데이터를 분석하여 반복되는 도구 시퀀스 탐색 (예: `file_read` -> `file_edit` -> `dotnet_build`)
2. **ChainSynthesizer** -- LLM을 사용하여 적절한 입출력 매핑과 설명을 갖춘 `CompositeTool` 생성
3. **ChainValidator** -- 합성 후 검증과 런타임 피드백; 가중 신뢰도 점수를 통한 체인 실행 성공 추적
4. **ChainManager** -- 라이프사이클 오케스트레이터: 시작 시 기존 체인 로드, 주기적 감지 실행, 구성 도구가 제거되면 체인 자동 무효화

**V2 향상 기능:**
- **DAG 실행** -- 독립적인 단계는 병렬 실행
- **Saga 롤백** -- 단계 실패 시 이전 단계를 역순으로 되돌림
- **체인 버전 관리** -- 이전 버전은 아카이브됨

**보안:** 복합 도구는 구성 도구 중 가장 제한적인 보안 플래그를 상속합니다.

**신뢰도 연쇄:** 체인 본능은 일반 본능과 동일한 신뢰도 라이프사이클을 따릅니다. 폐기 임계값 아래로 떨어지는 체인은 자동으로 등록 해제됩니다.

---

## 멀티 에이전트 오케스트레이션

여러 에이전트 인스턴스가 채널/세션별 격리로 동시에 실행될 수 있습니다.

**AgentManager:**
- 채널/세션별로 에이전트 인스턴스를 생성하고 관리
- 세션 격리로 서로 다른 채널의 에이전트가 간섭하지 않음
- `MULTI_AGENT_ENABLED`로 활성화 (옵트인, 기본 비활성 -- 비활성 시 단일 에이전트 동작과 동일)

**AgentBudgetTracker:**
- 에이전트별 토큰 및 비용 추적과 구성 가능한 예산 한도
- 모든 에이전트에 걸친 공유 일일/월간 예산 상한
- 예산 소진 시 하드 실패 대신 정상적 저하 (읽기 전용 모드) 트리거

**AgentRegistry:**
- 모든 활성 에이전트 인스턴스의 중앙 레지스트리
- 헬스 체크 및 정상 종료 지원
- 멀티 에이전트는 완전한 옵트인: 비활성 시 v2.0과 동일하게 작동

---

## 작업 위임

에이전트가 계층적 라우팅 시스템을 사용하여 하위 작업을 다른 에이전트에 위임할 수 있습니다.

**TierRouter (4단계):**
- **Tier 1** -- 현재 에이전트가 처리하는 간단한 작업 (위임 없음)
- **Tier 2** -- 중간 복잡도, 보조 에이전트에 위임
- **Tier 3** -- 높은 복잡도, 확장된 예산으로 위임
- **Tier 4** -- 전문 에이전트 능력이 필요한 중요 작업

**DelegationManager:**
- 위임 수명 주기 관리: 생성, 추적, 완료, 취소
- 무한 위임 루프를 방지하기 위한 최대 위임 깊이 적용 (기본값: 2)
- 예산 인식: 위임된 작업은 부모의 남은 예산 일부를 상속

**DelegationTool:**
- 에이전트가 작업을 위임하기 위해 호출할 수 있는 도구로 노출
- 위임된 하위 작업의 결과 집계 포함

---

## 메모리 감쇠 및 통합

메모리 항목은 지수적 감쇠 모델을 사용하여 시간이 지남에 따라 자연적으로 감쇠되며, 유휴 통합으로 중복을 줄입니다.

**지수적 감쇠:**
- 각 메모리 항목은 시간이 지남에 따라 감소하는 감쇠 점수를 가짐
- 접근 빈도와 중요도가 감쇠 저항을 강화
- 본능은 감쇠에서 면제 (만료되지 않음)

**유휴 통합:**
- 저활동 기간에 통합 엔진이 HNSW 클러스터링을 사용하여 의미적으로 유사한 메모리를 식별
- 관련 메모리가 통합된 요약으로 병합되어 저장 공간을 줄이고 검색 품질을 향상
- 소프트 삭제 및 실행 취소 지원: 통합된 원본 메모리는 통합됨으로 표시 (물리적으로 삭제되지 않음)되며 복원 가능

**통합 엔진:**
- 클러스터 감지를 위한 구성 가능한 유사도 임계값
- 구성 가능한 청크 크기의 배치 처리
- 통합 작업의 전체 감사 추적

---

## 배포 하위 시스템

휴먼 인 더 루프 승인 게이트와 서킷 브레이커 보호 기능이 포함된 옵트인 배포 시스템입니다.

**ReadinessChecker:**
- 배포 전 시스템 준비 상태 검증 (빌드 상태, 테스트 결과, 리소스 가용성)
- 구성 가능한 준비 기준

**DeployTrigger:**
- 데몬의 트리거 시스템과 새로운 트리거 유형으로 통합
- 배포 조건이 충족되면 실행 (예: 모든 테스트 통과, 승인 획득)
- 승인 큐 포함: 배포는 실행 전에 명시적 인간 승인이 필요

**DeploymentExecutor:**
- 롤백 기능이 포함된 순차적 배포 단계 실행
- 환경 변수 새니타이제이션으로 배포 로그에서 자격 증명 유출 방지
- 서킷 브레이커: 연속 배포 실패 시 연쇄 실패를 방지하기 위한 자동 쿨다운 트리거

**보안:** 배포는 기본적으로 비활성이며 구성을 통한 명시적 옵트인이 필요합니다. 모든 배포 작업은 로깅되고 감사 가능합니다.

---

## 데몬 모드

데몬은 하트비트 기반 트리거 시스템으로 24/7 자율 운영을 제공합니다.

```bash
npm run dev -- daemon --channel web
```

**HeartbeatLoop:**
- 설정 가능한 틱 간격으로 매 사이클마다 등록된 트리거를 평가
- 순차적 트리거 평가로 예산 경합 상태 방지
- 크래시 복구를 위한 실행 상태 영속화

**트리거 유형:**
- **Cron** -- cron 표현식을 사용한 예약 작업
- **파일 감시** -- 설정된 경로의 파일 시스템 변경 모니터링
- **체크리스트** -- 체크리스트 항목이 기한에 도달하면 실행
- **웹훅** -- HTTP POST 엔드포인트가 수신 요청 시 작업 트리거
- **Deploy** -- 배포 조건이 충족되면 실행 (승인 게이트 필수)

**복원력:**
- **서킷 브레이커** -- 트리거별 지수 백오프 쿨다운, 재시작 시에도 유지
- **예산 추적** -- 일일 USD 지출 한도와 경고 임계값 이벤트
- **트리거 중복 제거** -- 콘텐츠 기반 및 쿨다운 기반 억제로 중복 실행 방지
- **중첩 억제** -- 이미 활성 작업이 실행 중인 트리거는 건너뜀

**보안:**
- `DaemonSecurityPolicy`가 데몬 트리거에 의해 호출되는 도구 중 사용자 승인이 필요한 도구를 제어
- 쓰기 작업을 위한 설정 가능한 만료 기간이 있는 `ApprovalQueue`

**보고:**
- `NotificationRouter`가 긴급도 수준 (무음/낮음/중간/높음/심각)에 따라 설정된 채널로 이벤트 라우팅
- 긴급도별 속도 제한 및 조용한 시간 지원 (비긴급 알림 버퍼링)
- `DigestReporter`가 주기적 요약 보고서 생성
- 모든 알림이 SQLite 이력에 기록

---

## 아이덴티티 시스템

에이전트는 세션과 재시작을 걸쳐 영구 아이덴티티를 유지합니다.

**IdentityStateManager** (SQLite 기반):
- 첫 부팅 시 고유 에이전트 UUID 생성
- 부팅 횟수, 누적 가동 시간, 마지막 활동 타임스탬프
- 총 메시지 및 작업 카운터
- 크래시 복구를 위한 정상 종료 감지
- SQLite 쓰기 최소화를 위한 인메모리 카운터 캐시와 주기적 플러시

**크래시 복구:**
- 시작 시 이전 세션이 정상 종료되지 않았으면 `CrashRecoveryContext` 구축
- 다운타임 지속 시간, 중단된 목표 트리, 부팅 횟수 포함
- 시스템 프롬프트에 주입되어 LLM이 자연스럽게 크래시를 인식하고 중단된 작업을 재개 가능

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
| `EMBEDDING_PROVIDER` | `auto` | 임베딩 공급자: `auto`, `openai`, `gemini`, `mistral`, `together`, `fireworks`, `qwen`, `ollama` |
| `EMBEDDING_DIMENSIONS` | `256` | 임베딩 벡터 차원 수 (Matryoshka 차원 지원) |
| `MEMORY_ENABLED` | `true` | 영구 대화 메모리 활성화 |
| `MEMORY_DB_PATH` | `.strada-memory` | 메모리 데이터베이스 파일 디렉터리 |
| `WEB_CHANNEL_PORT` | `3000` | 웹 대시보드 포트 |
| `DASHBOARD_ENABLED` | `false` | HTTP 모니터링 대시보드 활성화 |
| `DASHBOARD_PORT` | `3001` | 대시보드 서버 포트 |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | WebSocket 실시간 대시보드 활성화 |
| `ENABLE_PROMETHEUS` | `false` | Prometheus 메트릭 엔드포인트 활성화 (포트 9090) |
| `MULTI_AGENT_ENABLED` | `false` | 멀티 에이전트 오케스트레이션 활성화 |
| `DELEGATION_ENABLED` | `false` | 에이전트 간 작업 위임 활성화 |
| `DELEGATION_MAX_DEPTH` | `2` | 최대 위임 체인 깊이 |
| `DEPLOYMENT_ENABLED` | `false` | 배포 하위 시스템 활성화 |
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

에이전트에는 카테고리별로 정리된 40개 이상의 내장 도구가 있습니다:

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
| `code_search` | RAG를 통한 시맨틱/벡터 검색 -- 자연어 쿼리 |
| `memory_search` | 영구 대화 메모리 검색 |

### Strada 코드 생성
| 도구 | 설명 |
|------|------|
| `strada_analyze_project` | C# 프로젝트 전체 스캔 -- 모듈, 시스템, 컴포넌트, 서비스 |
| `strada_create_module` | 완전한 모듈 스캐폴드 생성 (`.asmdef`, 구성, 디렉터리) |
| `strada_create_component` | 필드 정의가 포함된 ECS 컴포넌트 구조체 생성 |
| `strada_create_mediator` | 컴포넌트 바인딩이 포함된 `EntityMediator<TView>` 생성 |
| `strada_create_system` | `SystemBase`/`JobSystemBase`/`BurstSystem` 스캐폴드 생성 |

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

## RAG 파이프라인

RAG (검색 증강 생성) 파이프라인은 C# 소스 코드를 인덱싱하여 시맨틱 검색을 가능하게 합니다.

**인덱싱 흐름:**
1. Unity 프로젝트 내 `**/*.cs` 파일 스캔
2. 코드를 구조적으로 청크 분할 -- 파일 헤더, 클래스, 메서드, 생성자
3. Gemini Embedding 2.0 (기본값), OpenAI (`text-embedding-3-small`), 또는 Ollama (`nomic-embed-text`)로 임베딩 생성 (Matryoshka 차원 지원)
4. 빠른 근사 최근접 이웃 검색을 위해 HNSW 인덱스에 벡터 저장
5. 시작 시 백그라운드에서 자동 실행 (논블로킹)

**검색 흐름:**
1. 동일한 공급자로 쿼리를 임베딩
2. HNSW 검색이 `topK * 3` 후보 반환
3. 리랭커 스코어링: 벡터 유사도 (60%) + 키워드 겹침 (25%) + 구조 보너스 (15%)
4. 점수 0.2 이상의 상위 6건이 LLM 컨텍스트에 주입

**참고:** RAG 파이프라인은 현재 C# 파일만 지원합니다. 청커는 C# 전용입니다.

---

## 채널 기능

| 기능 | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|------|-----|----------|---------|-------|----------|-----|
| 텍스트 메시징 | 지원 | 지원 | 지원 | 지원 | 지원 | 지원 |
| 미디어 첨부 | 지원 (base64) | 지원 (사진/문서/동영상/음성) | 지원 (모든 첨부) | 지원 (파일 다운로드) | 지원 (이미지/동영상/오디오/문서) | 미지원 |
| 비전 (이미지→LLM) | 지원 | 지원 | 지원 | 지원 | 지원 | 미지원 |
| 스트리밍 (인플레이스 편집) | 지원 | 지원 | 지원 | 지원 | 지원 | 지원 |
| 입력 중 표시기 | 지원 | 지원 | 지원 | 미작동 | 지원 | 미지원 |
| 확인 대화상자 | 지원 (모달) | 지원 (인라인 키보드) | 지원 (버튼) | 지원 (Block Kit) | 지원 (번호 답장) | 지원 (readline) |
| 스레드 지원 | 미지원 | 미지원 | 지원 | 지원 | 미지원 | 미지원 |
| 속도 제한기 (아웃바운드) | 지원 (세션별) | 미지원 | 지원 (토큰 버킷) | 지원 (4단계 슬라이딩 윈도우) | 인라인 스로틀 | 미지원 |

### 스트리밍

모든 채널에서 인플레이스 편집 스트리밍을 구현합니다. LLM이 생성하는 대로 에이전트의 응답이 점진적으로 표시됩니다. 속도 제한을 피하기 위해 플랫폼별로 업데이트 빈도가 조절됩니다 (WhatsApp/Discord: 1회/초, Slack: 2회/초).

### 인증

- **Telegram**: 기본적으로 전체 거부. `ALLOWED_TELEGRAM_USER_IDS` 설정 필수.
- **Discord**: 기본적으로 전체 거부. `ALLOWED_DISCORD_USER_IDS` 또는 `ALLOWED_DISCORD_ROLE_IDS` 설정 필수.
- **Slack**: **기본적으로 전체 개방.** `ALLOWED_SLACK_USER_IDS`가 비어 있으면 모든 Slack 사용자가 봇에 접근 가능. 프로덕션에서는 허용 목록을 설정하세요.
- **WhatsApp**: 어댑터 내에서 로컬로 확인되는 `WHATSAPP_ALLOWED_NUMBERS` 허용 목록 사용.

---

## 보안

### 레이어 1: 채널 인증
플랫폼별 허용 목록이 메시지 도착 시 (모든 처리 전에) 확인됩니다.

### 레이어 2: 속도 제한
사용자별 슬라이딩 윈도우 (분/시간) + 글로벌 일일/월간 토큰 및 USD 예산 한도.

### 레이어 3: 경로 가드
모든 파일 작업에서 심볼릭 링크를 해석하고 경로가 프로젝트 루트 내에 있는지 검증합니다. 30개 이상의 민감한 패턴이 차단됩니다 (`.env`, `.git/credentials`, SSH 키, 인증서, `node_modules/`).

### 레이어 4: 미디어 보안
모든 미디어 첨부 파일은 처리 전에 검증됩니다: MIME 허용 목록, 유형별 크기 제한 (이미지 20MB, 동영상 50MB, 오디오 25MB, 문서 10MB), 매직 바이트 검증, 그리고 다운로드 URL에 대한 SSRF 보호.

### 레이어 5: 시크릿 새니타이저
24개의 정규식 패턴이 모든 도구 출력에서 LLM에 도달하기 전에 자격 증명을 감지하고 마스킹합니다. 대상: OpenAI 키, GitHub 토큰, Slack/Discord/Telegram 토큰, AWS 키, JWT, Bearer 인증, PEM 키, 데이터베이스 URL, 일반 시크릿 패턴.

### 레이어 6: 읽기 전용 모드
`READ_ONLY_MODE=true`인 경우, 23개의 쓰기 도구가 에이전트의 도구 목록에서 완전히 제거됩니다 -- LLM은 호출을 시도할 수조차 없습니다.

### 레이어 7: 작업 확인
쓰기 작업 (파일 쓰기, Git 커밋, 셸 실행)은 채널의 인터랙티브 UI (버튼, 인라인 키보드, 텍스트 프롬프트)를 통해 사용자 확인을 요구할 수 있습니다.

### 레이어 8: 도구 출력 새니타이제이션
모든 도구 결과는 8192자로 제한되며, LLM에 피드백하기 전에 API 키 패턴이 제거됩니다.

### 레이어 9: RBAC (내부)
5개의 역할 (superadmin, admin, developer, viewer, service)과 9개의 리소스 유형을 포괄하는 권한 매트릭스. 정책 엔진은 시간 기반, IP 기반, 커스텀 조건을 지원합니다.

### 레이어 10: 데몬 보안
`DaemonSecurityPolicy`가 데몬 트리거 작업에 대해 도구 수준의 승인 요구사항을 적용합니다. 쓰기 도구는 실행 전에 `ApprovalQueue`를 통한 명시적 사용자 승인이 필요합니다.

---

## 대시보드 및 모니터링

### HTTP 대시보드 (`DASHBOARD_ENABLED=true`)
`http://localhost:3001`에서 접근 가능 (localhost 전용). 표시 항목: 가동 시간, 메시지 수, 토큰 사용량, 활성 세션, 도구 사용 현황 테이블, 보안 통계. 3초마다 자동 새로고침.

### 헬스 엔드포인트
- `GET /health` -- 생존 확인 프로브 (`{"status":"ok"}`)
- `GET /ready` -- 심층 준비 상태: 메모리 및 채널 상태 확인. 200 (준비 완료), 207 (저하 상태) 또는 503 (준비 안 됨) 반환

### Prometheus (`ENABLE_PROMETHEUS=true`)
`http://localhost:9090/metrics`에서 메트릭 제공. 메시지, 도구 호출, 토큰의 카운터. 요청 시간, 도구 실행 시간, LLM 레이턴시의 히스토그램. 기본 Node.js 메트릭 (CPU, 힙, GC, 이벤트 루프).

### WebSocket 대시보드 (`ENABLE_WEBSOCKET_DASHBOARD=true`)
매초 실시간 메트릭 푸시. 인증된 연결 및 원격 명령 (플러그인 리로드, 캐시 클리어, 로그 조회) 지원. 데몬 이벤트 (트리거 실행, 예산 경고, 목표 진행)가 WebSocket을 통해 브로드캐스트됩니다.

### 메트릭 시스템
`MetricsStorage` (SQLite)가 작업 완료율, 반복 횟수, 도구 사용, 패턴 재사용을 기록합니다. `MetricsRecorder`가 세션별 메트릭을 캡처합니다. `metrics` CLI 명령으로 이력 메트릭을 표시합니다.

---

## 배포

### Docker

```bash
docker-compose up -d
```

`docker-compose.yml`에는 애플리케이션, 모니터링 스택, nginx 리버스 프록시가 포함되어 있습니다.

### 데몬 모드

```bash
# 24/7 자율 운영, 하트비트 루프와 사전 트리거 포함
node dist/index.js daemon --channel web

# 크래시 시 지수 백오프로 자동 재시작 (1초~60초, 최대 10회)
node dist/index.js daemon --channel telegram
```

### 프로덕션 체크리스트

- [ ] `NODE_ENV=production` 설정
- [ ] `LOG_LEVEL=warn` 또는 `error` 설정
- [ ] `RATE_LIMIT_ENABLED=true`를 예산 한도와 함께 설정
- [ ] 채널 허용 목록 설정 (특히 Slack -- 기본적으로 개방)
- [ ] 안전한 탐색만 원할 경우 `READ_ONLY_MODE=true` 설정
- [ ] 모니터링을 위해 `DASHBOARD_ENABLED=true` 활성화
- [ ] 메트릭 수집을 위해 `ENABLE_PROMETHEUS=true` 활성화
- [ ] 강력한 `JWT_SECRET` 생성
- [ ] 데몬 예산 한도 설정 (`RATE_LIMIT_DAILY_BUDGET_USD`)

---

## 테스트

```bash
npm test                         # 기본 전체 스위트 (안정성을 위한 배치 실행)
npm run test:watch               # 워치 모드
npm test -- --coverage           # 커버리지 포함
npm test -- src/agents/tools/file-read.test.ts  # 단일 파일 / 대상 실행
npm test -- src/dashboard/prometheus.test.ts    # 기본 러너로 대상 스위트 실행
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Strada.Core API 드리프트 검증
npm run test:file-build-flow     # opt-in 로컬 .NET 통합 플로우
npm run test:unity-fixture       # opt-in 로컬 Unity fixture 컴파일/테스트 플로우
npm run test:hnsw-perf           # opt-in HNSW 벤치마크 / 재현율 스위트
npm run typecheck                # TypeScript 타입 체크
npm run lint                     # ESLint
```

메모:
- `npm test` 는 이전 전체 스위트 OOM 경로를 피하기 위해 배치형 Vitest 러너와 `fork` 워커를 사용합니다.
- 실제 소켓 바인딩이 필요한 dashboard 테스트는 기본적으로 skip 됩니다. 실제 로컬 검증에는 `LOCAL_SERVER_TESTS=1` 을 사용하세요.
- `sync:check` 는 Strada.Brain 의 Strada.Core 지식을 실제 checkout 과 대조하며, CI 는 `--max-drift-score 0` 으로 이를 강제합니다.
- `test:file-build-flow`, `test:unity-fixture`, `test:hnsw-perf` 는 로컬 빌드 도구, 라이선스가 있는 Unity 에디터, 또는 무거운 벤치마크 부하가 필요하므로 의도적으로 opt-in 입니다.
- `test:unity-fixture` 는 생성된 코드가 맞아도 로컬 Unity batchmode / 라이선스 환경이 불안정하면 실패할 수 있습니다.

---

## 프로젝트 구조

```
src/
  index.ts              # CLI 진입점 (Commander.js)
  core/
    bootstrap.ts        # 전체 초기화 시퀀스 -- 모든 연결이 여기서 이루어짐
    event-bus.ts        # 분리된 이벤트 기반 통신을 위한 TypedEventBus
    tool-registry.ts    # 도구 인스턴스화 및 등록
  agents/
    orchestrator.ts     # PAOR 에이전트 루프, 세션 관리, 스트리밍
    agent-state.ts      # 단계 상태 머신 (계획/행동/관찰/반성)
    paor-prompts.ts     # 단계 인식 프롬프트 빌더
    instinct-retriever.ts # 사전 학습 패턴 검색
    failure-classifier.ts # 오류 분류 및 자동 재계획 트리거
    autonomy/           # 오류 복구, 작업 계획, 자체 검증
    context/            # 시스템 프롬프트 (Strada.Core 지식 베이스)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + 기타
    tools/              # 30+ 도구 구현
    plugins/            # 외부 플러그인 로더
  channels/
    telegram/           # Grammy 기반 봇
    discord/            # discord.js 봇 (슬래시 명령 포함)
    slack/              # Slack Bolt (소켓 모드) + Block Kit
    whatsapp/           # Baileys 기반 클라이언트 (세션 관리 포함)
    web/                # Express + WebSocket 웹 대시보드
    cli/                # Readline REPL
  memory/
    file-memory-manager.ts   # 레거시 백엔드: JSON + TF-IDF (폴백)
    unified/
      agentdb-memory.ts      # 활성 백엔드: SQLite + HNSW, 3계층 자동 티어링
      agentdb-adapter.ts     # AgentDBMemory용 IMemoryManager 어댑터
      migration.ts           # 레거시 FileMemoryManager -> AgentDB 마이그레이션
      consolidation-engine.ts # HNSW 클러스터링을 활용한 유휴 메모리 통합
      consolidation-types.ts  # 통합 타입 정의 및 인터페이스
    decay/                    # 지수적 메모리 감쇠 시스템
  rag/
    rag-pipeline.ts     # 인덱스 + 검색 + 포맷 오케스트레이션
    chunker.ts          # C# 전용 구조적 청킹
    hnsw/               # HNSW 벡터 스토어 (hnswlib-node)
    embeddings/         # OpenAI 및 Ollama 임베딩 공급자
    reranker.ts         # 가중 리랭킹 (벡터 + 키워드 + 구조)
  learning/
    pipeline/
      learning-pipeline.ts  # 패턴 감지, 본능 생성, 진화 제안
      learning-queue.ts     # 이벤트 기반 학습을 위한 직렬 비동기 프로세서
      embedding-queue.ts    # 제한된 비동기 임베딩 생성
    scoring/
      confidence-scorer.ts  # 하이브리드 가중 신뢰도 (5요소), Elo, Wilson 구간
    matching/
      pattern-matcher.ts    # 키워드 + 시맨틱 패턴 매칭
    hooks/
      error-learning-hooks.ts  # 에러/해결 캡처 후크
    storage/
      learning-storage.ts  # 본능, 트라젝토리, 패턴의 SQLite 저장소
      migrations/          # 스키마 마이그레이션 (교차 세션 출처)
    chains/
      chain-detector.ts    # 반복 도구 시퀀스 감지
      chain-synthesizer.ts # LLM 기반 복합 도구 생성
      composite-tool.ts    # 실행 가능한 복합 도구
      chain-validator.ts   # 합성 후 검증, 런타임 피드백
      chain-manager.ts     # 전체 라이프사이클 오케스트레이터
  multi-agent/
    agent-manager.ts    # 멀티 에이전트 라이프사이클 및 세션 격리
    agent-budget-tracker.ts  # 에이전트별 예산 추적
    agent-registry.ts   # 활성 에이전트의 중앙 레지스트리
  delegation/
    delegation-manager.ts    # 위임 수명 주기 관리
    delegation-tool.ts       # 에이전트용 위임 도구
    tier-router.ts           # 4단계 작업 라우팅
  goals/
    goal-decomposer.ts  # DAG 기반 목표 분해 (사전 + 반응형)
    goal-executor.ts    # 실패 예산이 포함된 웨이브 기반 병렬 실행
    goal-validator.ts   # Kahn 알고리즘 DAG 순환 감지
    goal-storage.ts     # 목표 트리의 SQLite 영속화
    goal-progress.ts    # 진행 상황 추적 및 보고
    goal-resume.ts      # 재시작 후 중단된 목표 트리 재개
    goal-renderer.ts    # 목표 트리 시각화
  daemon/
    heartbeat-loop.ts   # 핵심 틱-평가-실행 루프
    trigger-registry.ts # 트리거 등록 및 라이프사이클
    daemon-storage.ts   # 데몬 상태의 SQLite 영속화
    daemon-events.ts    # 데몬 서브시스템의 타입 이벤트 정의
    daemon-cli.ts       # 데몬 관리 CLI 명령
    budget/
      budget-tracker.ts # 일일 USD 예산 추적
    resilience/
      circuit-breaker.ts # 지수 백오프가 포함된 트리거별 서킷 브레이커
    security/
      daemon-security-policy.ts  # 데몬의 도구 승인 요구사항
      approval-queue.ts          # 만료가 포함된 승인 요청 대기열
    dedup/
      trigger-deduplicator.ts    # 콘텐츠 + 쿨다운 중복 제거
    triggers/
      cron-trigger.ts        # Cron 표현식 스케줄링
      file-watch-trigger.ts  # 파일 시스템 변경 모니터링
      checklist-trigger.ts   # 기한 체크리스트 항목
      webhook-trigger.ts     # HTTP POST 웹훅 엔드포인트
      deploy-trigger.ts      # 승인 게이트가 포함된 배포 조건 트리거
    deployment/
      deployment-executor.ts # 롤백이 포함된 배포 실행
      readiness-checker.ts   # 배포 전 준비 상태 검증
    reporting/
      notification-router.ts # 긴급도 기반 알림 라우팅
      digest-reporter.ts     # 주기적 요약 다이제스트 생성
      digest-formatter.ts    # 채널용 다이제스트 보고서 포맷
      quiet-hours.ts         # 비긴급 알림 버퍼링
  identity/
    identity-state.ts   # 영구 에이전트 아이덴티티 (UUID, 부팅 횟수, 가동 시간)
    crash-recovery.ts   # 크래시 감지 및 복구 컨텍스트
  tasks/
    task-manager.ts     # 작업 라이프사이클 관리
    task-storage.ts     # SQLite 작업 영속화
    background-executor.ts # 목표 통합이 포함된 백그라운드 작업 실행
    message-router.ts   # 오케스트레이터로의 메시지 라우팅
    command-detector.ts # 슬래시 명령 감지
    command-handler.ts  # 명령 실행
  metrics/
    metrics-storage.ts  # SQLite 메트릭 저장소
    metrics-recorder.ts # 세션별 메트릭 캡처
    metrics-cli.ts      # CLI 메트릭 표시 명령
  security/             # 인증, RBAC, 경로 가드, 속도 제한기, 시크릿 새니타이저
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
