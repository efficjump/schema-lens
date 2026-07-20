# Contributing

Schema Lens에 기여해 주셔서 감사합니다. 실제 사내 소스, 자격증명, 내부 도메인이나 개인정보를 이슈·테스트 fixture·스크린샷에 포함하지 말아 주세요.

## 개발 환경

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

## 변경 전 확인

- 정적 분석 규칙을 추가할 때는 파일·줄 근거와 신뢰도 계산을 함께 검토합니다.
- 브라우저 파일 처리는 기존 크기, 개수, 동시성, 취소 한도를 우회하지 않아야 합니다.
- LLM으로 전달하는 새 필드는 `lib/llm/redaction.ts`의 마스킹과 허용 목록을 거쳐야 합니다.
- UI는 키보드 탐색, 포커스 복귀, 읽기 전용 코드 렌더링을 유지해야 합니다.
- 특정 LLM 제공자나 모델을 기본값, 화면 문구, 예제 데이터에 고정하지 않습니다.

## 검증

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm licenses list --json
```

의존성 변경이 있으면 `THIRD_PARTY_NOTICES.md`의 검토 결과도 갱신해 주세요.

## Pull request

PR 설명에는 변경 이유, 사용자 영향, 검증 명령과 결과를 적어 주세요. UI 변경에는 비밀값과 로컬 절대 경로가 없는 내장 데모 화면을 사용해 주세요.
