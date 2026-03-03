<p align="center">
  <img src="docs/assets/logo.svg" alt="Strata.Brain Logo" width="200"/>
</p>

<h1 align="center">🧠 Strata.Brain</h1>

<p align="center">
  <strong>AI 기반 Unity 개발 에이전트</strong><br/>
  지능형 코드 생성, 분석 및 다중 채널 협업으로 Strata.Core 워크플로우를 자동화하세요.
</p>

<p align="center">
  <a href="https://github.com/yourusername/strata-brain/releases"><img src="https://img.shields.io/github/v/release/yourusername/strata-brain?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/yourusername/strata-brain/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/strata-brain/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/테스트-600%2B-green?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/커버리지-85%25-brightgreen?style=flat-square" alt="Coverage">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="README.zh.md">中文</a> •
  <a href="README.ja.md">日本語</a> •
  <a href="README.tr.md">Türkçe</a> •
  <a href="README.de.md">Deutsch</a> •
  <a href="README.es.md">Español</a> •
  <a href="README.fr.md">Français</a>
</p>

---

## ✨ 주요 기능

### 🤖 AI 기반 개발
- **스마트 코드 생성** - 모듈, 시스템, 컴포넌트, 미디에이터 자동 생성
- **시맨틱 코드 검색** - HNSW 벡터 검색으로 150배 빠름 (무차별 대입 대비)
- **경험 재생 학습** - 과거 상호작용에서 학습하여 지속적 개선
- **다중 공급자 AI** - Claude, OpenAI, DeepSeek, Groq 및 10개 이상의 호환 공급자

### 💬 다중 채널 지원
선호하는 플랫폼으로 Strata.Brain과 소통하세요:
- **Telegram** - 이동 중 모바일 우선 개발
- **Discord** - 풍부한 임베드를 활용한 팀 협업
- **Slack** - 엔터프라이즈 워크플로우 통합
- **WhatsApp** - 빠른 수정 및 상태 확인
- **CLI** - 직접 터미널 접근

### 🎮 Unity/Strata.Core 통합
- **프로젝트 분석** - 전체 코드베이스 구조 매핑
- **빌드 자동화** - 컴파일 오류 자동 수정
- **코드 품질** - Strata.Core 패턴 및 모범 사례 적용
- **아키텍처 시각화** - 복잡한 시스템을 즉시 이해

### 🔒 엔터프라이즈 보안
- **RBAC** - 역할 기반 액세스 제어 (5개 역할, 14개 리소스 유형)
- **시크릿 삭제** - 18개 패턴 유형 자동 마스킹
- **감사 로그** - 완전한 활동 추적
- **읽기 전용 모드** - 변경 없이 안전한 탐색

### 📊 모니터링 및 운영
- **실시간 대시보드** - WebSocket 기반 라이브 메트릭
- **Prometheus 통합** - 메트릭을 스택으로 낳보기
- **스마트 알림** - Discord, Slack, 이메일, Telegram, PagerDuty
- **자동 백업** - 예약 + 온디맨드 백업

---

## 🚀 빠른 시작

### 사전 요구사항
- Node.js >= 20.0.0
- Strata.Core가 포함된 Unity 프로젝트
- ANTHROPIC_API_KEY (또는 다른 AI 공급자)

### 설치

```bash
# 저장소 클론
git clone https://github.com/yourusername/strata-brain.git
cd strata-brain

# 의존성 설치
npm install

# 환경 설정
cp .env.example .env
# .env를 설정으로 편집

# 개발 시작
npm run dev
```

### Docker (프로덕션 환경 권장)

```bash
# 원클릭 배포
./scripts/deploy.sh

# 또는 수동으로
docker-compose up -d
```

---

## 📖 사용 예시

### 새 모듈 생성

**Telegram:**
```
@StrataBrain 아이템, 슬롯, 무게 시스템이 포함된 인벤토리 모듈 생성
```

**Discord:**
```
!create-module PlayerStats Health, Mana, Stamina 속성 포함
```

**CLI:**
```bash
npm run cli -- create-module EnemyAI patrol, attack, flee 동작 포함
```

### 프로젝트 분석

```
@StrataBrain 내 프로젝트를 분석하고 전투 시스템에 대해 알려줘
```

응답:
```
📊 프로젝트 분석

전투 시스템 위치:
├── 📁 Modules/Combat/
│   ├── CombatModule.cs (진입점)
│   ├── Systems/
│   │   ├── DamageSystem.cs (데미지 적용)
│   │   └── CombatStateSystem.cs (상태 관리)
│   └── Components/
│       ├── HealthComponent.cs
│       └── AttackComponent.cs

🔍 주요 인사이트:
• 체강은 3곳에서 수정됨
• 데미지 값에 검증 없음
• CombatStateSystem에 null 체크 누락
```

### 시맨틱 검색

```
@StrataBrain 검색 "데미지를 받을 때 플레이어 체강이 수정되는 곳"
```

관련 코드 스니펫과 파일 위치를 포함한 결과를 몇 초 내에 반환합니다.

---

## 🏗️ 아키텍처

```
┌─────────────────────────────────────────┐
│  프레젠테이션 계층 (5개 채널)           │
│  Telegram • Discord • Slack • WhatsApp │
├─────────────────────────────────────────┤
│  오케스트레이션 계층                    │
│  세션 관리자 • 속도 제한기              │
│  자율성: PLAN-ACT-VERIFY-RESPOND       │
├─────────────────────────────────────────┤
│  서비스 계층                            │
│  AI 공급자 체인 • 25+ 도구              │
│  HNSW 벡터 검색 • 학습 시스템           │
├─────────────────────────────────────────┤
│  인프라 계층                            │
│  DI 컨테이너 • 보안 (RBAC)              │
│  인증 • 설정 • 로깅                     │
└─────────────────────────────────────────┘
```

---

## 🧪 테스트

```bash
# 모든 테스트 실행
npm test

# 커버리지로 실행
npm run test:coverage

# 통합 테스트 실행
npm run test:integration
```

**테스트 커버리지:**
- 600+ 단위 테스트
- 51 통합 테스트 (E2E)
- 85%+ 코드 커버리지

---

## 📚 문서

- [📖 시작 가이드](docs/getting-started.ko.md)
- [🏗️ 아키텍처 개요](docs/architecture.ko.md)
- [🔧 설정 참조](docs/configuration.ko.md)
- [🔒 보안 가이드](docs/security/security-overview.ko.md)
- [🛠️ 도구 개발](docs/tools.ko.md)
- [📊 API 참조](docs/api.ko.md)

---

## 🛡️ 보안

Strata.Brain은 포괄적인 보안 조치를 구현합니다:

- ✅ **OWASP Top 10** 준수
- ✅ **RBAC** 5개 역할 (슈퍼관리자에서 뷰어까지)
- ✅ **18개 시크릿 패턴** 검색 및 마스킹
- ✅ **경로 탐색** 보호
- ✅ **속도 제한** 예산 추적 포함
- ✅ **감사 로그** 모든 작업 기록
- ✅ **침투 테스트 스크립트** 포함

자세한 내용은 [보안 문서](docs/security/security-overview.ko.md)를 참조하세요.

---

## 🌍 다국어 지원

Strata.Brain은 당신의 언어를 이해합니다:

| 언어 | 파일 | 상태 |
|------|------|------|
| 🇺🇸 English | [README.md](README.md) | ✅ 완료 |
| 🇨🇳 中文 | [README.zh.md](README.zh.md) | ✅ 완료 |
| 🇯🇵 日本語 | [README.ja.md](README.ja.md) | ✅ 완료 |
| 🇰🇷 한국어 | [README.ko.md](README.ko.md) | ✅ 완료 |
| 🇹🇷 Türkçe | [README.tr.md](README.tr.md) | ✅ 완료 |
| 🇩🇪 Deutsch | [README.de.md](README.de.md) | ✅ 완료 |
| 🇪🇸 Español | [README.es.md](README.es.md) | ✅ 완료 |
| 🇫🇷 Français | [README.fr.md](README.fr.md) | ✅ 완료 |

---

## 🤝 기여

기여를 환영합니다! 자세한 내용은 [기여 가이드](CONTRIBUTING.ko.md)를 참조하세요.

```bash
# Fork 및 클론
git clone https://github.com/yourusername/strata-brain.git

# 브랜치 생성
git checkout -b feature/amazing-feature

# 변경사항 커밋
git commit -m "놀라운 기능 추가"

# 푸시 및 PR 생성
git push origin feature/amazing-feature
```

---

## 📜 라이선스

MIT 라이선스 - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

---

## 💖 감사의 말

- [Strata.Core](https://github.com/strata/core) - 모든 것을 구동하는 ECS 프레임워크
- [Grammy](https://grammy.dev) - Telegram 봇 프레임워크
- [Discord.js](https://discord.js.org) - Discord 통합
- [HNSWLib](https://github.com/nmslib/hnswlib) - 고성능 벡터 검색

---

<p align="center">
  <strong>🚀 Unity 개발을 가속화할 준비가 되셨나요?</strong><br/>
  <a href="https://github.com/yourusername/strata-brain/stargazers">⭐ GitHub에서 스타 주기</a> •
  <a href="https://twitter.com/stratabrain">🐦 Twitter 팔로우</a> •
  <a href="https://discord.gg/stratabrain">💬 Discord 참여</a>
</p>

<p align="center">
  Strata 팀이 ❤️로 제작
</p>
