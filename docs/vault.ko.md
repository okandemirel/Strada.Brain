# 코드베이스 메모리 Vault (Codebase Memory Vault) — Phase 1 + Phase 2

> 번역 참고: 이 문서는 [docs/vault.md](vault.md) 의 한국어 번역입니다. 런타임 동작과 내부 식별자의 정본은 영문판과 소스(`src/vault/`)입니다.

## 1. 개요

Codebase Memory Vault 는 Strada.Brain 에 **프로젝트별 영구 코드베이스 메모리** 계층을 더합니다. 매 요청마다 수백 개의 파일을 다시 읽는 대신, Vault 는 프로젝트를 한 번 색인하고 증분적으로 최신 상태를 유지하며, 질의마다 **가장 관련 있는 조각** 만을 토큰 예산 안에 담아 에이전트에 전달합니다.

핵심 구성:

- **하이브리드 검색** — BM25 (FTS5) 와 벡터 검색 (HNSW) 을 Reciprocal Rank Fusion 으로 융합.
- **심볼릭 검색** — 호출 · 임포트 그래프 위에서 **Personalized PageRank (PPR)** 로 재순위.
- **Unity 프로젝트 이해** — `UnityProjectVault` 가 `Assets/` 를 색인하고 C# 심볼을 추출.
- **SelfVault** — Strada.Brain 자체 소스를 색인해 에이전트가 자기 자신의 아키텍처를 이해하게 만듭니다.
- **토큰 절약** — `packByBudget` 이 토큰 한도 안에서만 청크를 패킹하므로 컨텍스트 팽창이 없습니다.

### 왜 중요한가요?

전통적인 RAG 구현은 질의마다 파일 시스템을 훑거나, LLM 컨텍스트에 파일 전체를 밀어넣습니다. 이는 토큰 낭비 · 느린 응답 · 일관되지 않는 결과로 이어집니다. Vault 는 대신:

- `xxhash64` 기반 **내용 해시 단락(short-circuit)** — 내용이 같으면 재임베딩 안 함.
- **chokidar watcher** (800 ms debounce) 로 사용자 편집 자동 반영.
- **Write-hook** (200 ms 예산) 으로 에이전트 자신의 도구 쓰기까지 즉시 반영.
- **수동 `/vault sync`** — 필요 시 전체 재색인.

결과적으로 대형 Unity 프로젝트 · 거대한 모노레포에서도 에이전트 응답이 빠르고 비용이 낮아집니다.

## 2. 빠른 시작

```bash
# 1) Vault 활성화
export STRADA_VAULT_ENABLED=true

# 2) Strada.Brain 시작
npm start
```

에이전트 또는 채팅 채널에서:

```
/vault init /path/to/unity/project   # 새 Vault 등록 + 초기 색인
/vault sync                           # 수동 전체 재색인
/vault status                         # 파일 · 청크 · 심볼 · 엣지 수 확인
```

포털에서 `http://localhost:3000/admin/vaults` 를 열면 **Files · Search · Graph** 세 탭이 표시됩니다.

## 3. 아키텍처 개요

Vault 는 **3계층 표현** 으로 같은 코드베이스를 바라봅니다:

| 계층 | 내용 | 테이블 | 사용 시점 |
|---|---|---|---|
| **L1 — 파일 메타데이터** | 경로, `xxhash64` 블롭 해시, mtime, 크기, 언어, 종류 | `vault_files` | 변경 감지 · 단락 평가 |
| **L2 — 심볼 그래프** | 클래스/함수/메서드 심볼 + 호출 · 임포트 엣지 + 마크다운 wikilink | `vault_symbols`, `vault_edges`, `vault_wikilinks` | PPR 재순위 · Graph UI · `findCallers` |
| **L3 — 하이브리드 청크** | 라인 범위 단위 청크 + BM25 FTS5 + 벡터 임베딩 | `vault_chunks`, `vault_chunks_fts`, `vault_embeddings` | 자연어 질의 · 하이브리드 검색 |

주요 소스 파일:

- `src/vault/vault.interface.ts` — 모든 Vault 가 만족하는 `IVault` 계약.
- `src/vault/unity-project-vault.ts` — Unity 프로젝트를 `<project>/.strada/vault/index.db` 로 색인.
- `src/vault/self-vault.ts` — Strada.Brain 자체 소스를 색인 (심볼릭 링크는 건너뜀).
- `src/vault/vault-registry.ts` — 싱글톤 레지스트리. `query()` 를 모든 Vault 에 팬아웃하고 RRF 점수로 병합.
- `src/vault/ppr.ts` — Personalized PageRank 구현.
- `src/vault/symbol-extractor/` — Tree-sitter WASM 기반 TypeScript · C# 추출기 + 마크다운 wikilink 파서.

## 4. Phase 1: 하이브리드 검색

Phase 1 은 L1 + L3 계층을 제공합니다.

### 4.1 질의 파이프라인

`VaultRegistry.query({ text })` 는 다음 순서로 동작합니다:

1. **Per-vault recall** — 각 Vault 가 BM25 (FTS5) 와 벡터 (HNSW) 로 각각 상위 결과를 산출합니다.
2. **Reciprocal Rank Fusion** (k = 60) — 두 순위 리스트를 융합합니다.
3. **선택적 필터** — `langFilter` · `pathGlob` 로 결과를 좁힙니다.
4. **`packByBudget`** — 요청된 토큰 예산까지 청크를 그리디 패킹합니다.
5. **Cross-vault** — 모든 Vault 결과를 RRF 점수로 정렬하고 `topK` 로 자릅니다.

### 4.2 저장소

Vault 마다 독립된 SQLite DB (`better-sqlite3`, WAL + `foreign_keys`):

- `vault_files` — 경로, `xxhash64` 블롭 해시, mtime, 크기, 언어, 종류.
- `vault_chunks` — 청크 ID (sha256 절단), 파일 FK, 라인 범위, 본문, 토큰 수.
- `vault_chunks_fts` — FTS5 가상 테이블, BM25 점수.
- `vault_embeddings` — 외부 HNSW 저장소 포인터.
- `vault_meta` — 마이그레이션용 key/value.

### 4.3 갱신 경로 (3가지)

| 경로 | 지연 | 트리거 |
|---|---|---|
| chokidar watcher | 800 ms debounce | 사용자의 파일 시스템 편집 |
| Write-hook (`installWriteHook`) | 200 ms 동기 예산 | Strada.Brain 자체 도구 쓰기 |
| 수동 `/vault sync` | 즉시 | 명시적 전체 재색인 |

세 경로 모두 `reindexFile` 의 해시 단락을 따르므로 **변경되지 않은 파일은 다시 임베딩되지 않습니다.**

### 4.4 에이전트 도구

부트스트랩 시 `stage-knowledge.ts :: initVaultsFromBootstrap` 에서 다음 도구가 에이전트 도구 레지스트리에 등록됩니다:

- `vault_init` — 새 Vault 등록 + 초기 색인.
- `vault_sync` — 전체 재색인.
- `vault_status` — 파일 · 청크 수 · 최근 갱신 요약.

## 5. Phase 2: 심볼 그래프 + PPR + SelfVault + Graph UI

Phase 2 는 Phase 1 의 L3 하이브리드 검색 위에 **결정론적 L2 심볼 계층** 을 덧씌웁니다.

### 5.1 새로운 테이블

- `vault_symbols` — 언어 · 상대 경로 · 정규화된 이름 · 종류 · 라인 범위.
- `vault_edges` — 방향 있는 엣지 (호출 · 임포트 등), 소스/대상 심볼 ID.
- `vault_wikilinks` — 마크다운 `[[target]]` 링크.
- `vault_meta.indexer_version = 'phase2.v1'`.

### 5.2 심볼 ID 형식

```
<lang>::<relPath>::<qualifiedName>
```

예:

- `csharp::Assets/Scripts/Player.cs::Game.Player.Move`
- `typescript::src/foo.ts::Foo.bar`

해결되지 않는 외부 참조는 `<lang>::unresolved::<label>` 로 기록됩니다.

### 5.3 Tree-sitter 추출기

`src/vault/symbol-extractor/` 에는 Tree-sitter WASM 기반 추출기가 있습니다:

- **TypeScript** — 클래스 · 함수 · 메서드 + 호출/임포트 엣지.
- **C#** — 클래스 · 구조체 · 메서드 · 속성 + 호출/임포트 엣지.
- **Markdown wikilinks** — 정규식 기반.

보안 강화로 **요청마다 새로운 `Parser` 인스턴스** 를 사용하며, **2 MB 초과 파일은 심볼 추출에서 제외** 됩니다 (전체 청크 색인은 여전히 수행).

### 5.4 Graph Canvas

`.strada/vault/graph.canvas` — JSON Canvas 1.0 파일입니다. 다음 시점에 **원자적 쓰기 (temp + rename)** 로 재생성됩니다:

- 콜드 스타트.
- `/vault sync`.
- watcher drain (debounce 완료 시).

### 5.5 Personalized PageRank

`VaultQuery.focusFiles` 가 주어지면 `src/vault/ppr.ts` 가 엣지 그래프 위에서 **PPR 재순위** 를 실행합니다. 지정된 "초점" 파일에서 도달 가능한 심볼이 상위로 부상합니다. `focusFiles` 가 없으면 RRF 전용 경로가 유지됩니다.

담핑 팩터는 정규화되고, 엣지 캐시는 변경 시 무효화되며, `findCallers` 는 경계를 갖습니다 (DoS 방지).

### 5.6 SelfVault

`src/vault/self-vault.ts` 는 **Strada.Brain 자기 자신** 을 색인합니다:

포함 대상:
- `src/`
- `web-portal/src/`
- `tests/`
- `docs/`
- `AGENTS.md`, `CLAUDE.md`

**심볼릭 링크는 건너뜁니다** (무한 루프 · 외부 경로 이스케이프 방지).

덕분에 에이전트는 사용자 코드뿐 아니라 자기 자신의 아키텍처에 대한 질문 ("`VaultRegistry.query` 호출자는?", "`ppr.ts` 는 어디서 import 되나?") 에 답할 수 있습니다.

### 5.7 Graph UI

포털의 **Graph** 탭은 `@xyflow/react` + `@dagrejs/dagre` 로 심볼 그래프를 인터랙티브하게 시각화합니다. 노드 클릭 → 호출자 목록, 엣지 호버 → 관계 정보. **새로운 프론트엔드 의존성은 추가되지 않았습니다** (기존 포털 번들 재사용).

## 6. 설정 레퍼런스

`src/config/config.ts :: vault` 아래:

| 키 | 기본값 | 환경변수 | 설명 |
|---|---|---|---|
| `enabled` | `false` | `STRADA_VAULT_ENABLED` | Vault 서브시스템 전체 on/off |
| `writeHookBudgetMs` | `200` | `STRADA_VAULT_WRITE_HOOK_BUDGET_MS` | write-hook 동기 예산 (ms) |
| `debounceMs` | `800` | `STRADA_VAULT_DEBOUNCE_MS` | chokidar debounce (ms) |
| `embeddingFallback` | `'local'` | — | 원격 임베딩 실패 시 동작 (`'none' \| 'local'`) |
| `self.enabled` | `true` | — | SelfVault 활성 여부 |

활성화 예:

```bash
export STRADA_VAULT_ENABLED=true
export STRADA_VAULT_WRITE_HOOK_BUDGET_MS=300
export STRADA_VAULT_DEBOUNCE_MS=1000
```

## 7. HTTP API 레퍼런스

기본 베이스: `http://localhost:3000/api/vaults`

### Phase 1 엔드포인트

| 메서드 | 경로 | 용도 |
|---|---|---|
| `GET` | `/api/vaults` | 등록된 Vault 목록 |
| `GET` | `/api/vaults/:id/files` | 파일 트리 + 메타데이터 |
| `GET` | `/api/vaults/:id/files/:path` | 파일 원문 · 마크다운 미리보기 |
| `POST` | `/api/vaults/:id/search` | 하이브리드 검색 (BM25 + 벡터 + RRF) |
| `POST` | `/api/vaults/:id/sync` | 수동 전체 재색인 트리거 |

### Phase 2 엔드포인트

| 메서드 | 경로 | 용도 |
|---|---|---|
| `GET` | `/api/vaults/:id/canvas` | `graph.canvas` 반환 (JSON Canvas 1.0) |
| `GET` | `/api/vaults/:id/symbols/by-name?q=X` | 짧은 이름으로 심볼 검색 |
| `GET` | `/api/vaults/:id/symbols/:symbolId/callers` | 들어오는 호출 엣지 목록 |

### WebSocket 이벤트

```json
{
  "type": "vault:update",
  "vaultId": "unity-main",
  "dirty": { "added": 3, "modified": 7, "removed": 1 }
}
```

watcher 와 write-hook 이 dirty-set 을 배치로 브로드캐스트하므로 포털 UI 가 자동으로 새로 고쳐집니다.

## 8. 포털 UI 가이드

페이지: `/admin/vaults` (`web-portal/src/pages/VaultsPage.tsx`).

### Files 탭
- 좌측: 파일 트리 (폴더 확장/축소).
- 우측: 선택한 파일의 마크다운 렌더 / 원문 토글.
- 상단: Vault 선택기 (여러 Vault 등록 시).

### Search 탭
- 자연어 질의 입력 → 하이브리드 검색.
- 옵션: `langFilter`, `pathGlob`, `topK`, 토큰 예산.
- 결과: 청크 본문 + BM25 점수 + 벡터 유사도 + RRF 최종 점수.

### Graph 탭 (Phase 2)
- `@xyflow/react` 기반 인터랙티브 캔버스.
- `@dagrejs/dagre` 자동 레이아웃.
- 노드 클릭 → `findCallers` 호출 → 들어오는 엣지 표시.
- `focusFiles` 지정 시 PPR 재순위 결과가 강조됨.

## 9. 보안

보안 강화 (commit `5563d48`) 는 다음을 포함합니다:

- **원자적 canvas 쓰기** — temp 파일 + `rename()` 으로 부분 쓰기 방지.
- **심볼릭 링크 스킵** — Vault 루트 외부로 이스케이프 방지.
- **요청마다 fresh `Parser`** — Tree-sitter 파서 상태 누수 방지.
- **요청 본문 DoS 캡** — 비정상 페이로드 거부.
- **고아 엣지 GC** — 파일 삭제 시 연결된 엣지 자동 정리.
- **정규화된 PPR 담핑** — 점수 폭주 방지.
- **2 MB 심볼 추출 캡** — 거대한 자동 생성 파일은 청크만 색인, 심볼 추출 스킵.
- **엣지 캐시 무효화** — 파일 변경 시 관련 캐시 엔트리 drop.
- **경계 있는 `findCallers`** — 깊이 · 결과 수 제한.

자세한 보안 모델은 [SECURITY.md](../SECURITY.md) 참고.

## 10. 로드맵 (Phase 3)

Phase 3 에서 다룰 예정:

- **Haiku 롤링 요약** — 거대한 파일 · 긴 함수에 대해 Claude Haiku 로 요약을 생성해 벡터 계층에 주입.
- **FrameworkVault 업그레이드** — Strada.Core · Unity 공식 문서까지 시맨틱 검색 + docstring 추출.
- **양방향 Learning 파이프라인 결합** — Vault 조회 결과가 Learning 시스템 피드백을 받고, 반대로 Learning 이 Vault 의 재순위 가중치를 학습.

## 11. 링크

- 소스: [`src/vault/`](../src/vault/)
- 영문판: [docs/vault.md](vault.md)
- 시스템 개요: [README.ko.md](../README.ko.md#코드베이스-메모리-vault-codebase-memory-vault)
- 보안: [SECURITY.md](../SECURITY.md)
