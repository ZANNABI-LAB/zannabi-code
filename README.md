<p align="center">
  <img src="docs/assets/hero.png" alt="zannabi-code — verification-first external runner" width="100%">
</p>

# zannabi-code

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![runtime](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![tests](https://img.shields.io/badge/tests-90%20passing-brightgreen)]()

> **Shake the branch before you cross.** — 잔나비는 건너기 전에 가지를 흔들어본다

검증 우선 외부 러너 — 증거 없으면 완료가 아니다. 검증 게이트를 에이전트 밖에 두고,
헤드리스 코딩 에이전트를 구동하며, 모든 완료 선언에 기계 검증 가능한 증거를 요구한다.

## 원리

```
zannabi run "결제 API에 재시도 로직 추가"
  1. PLAN    에이전트가 계획 + 게이트 제안 → 사람이 승인   ← 유일한 사람 개입
  2. EXECUTE 헤드리스 Claude Code 실행
  3. VERIFY  러너가 게이트를 직접 실행 — 에이전트 자기보고는 판정에 쓰지 않음
  4. 실패 → 실패 증거를 넣어 재시도 (기본 3회)
  5. 성공 → .zannabi/runs/<시각>-<슬러그>/ 에 증거 확정
```

## 전제조건

- [Bun](https://bun.sh) 1.3+
- [Claude Code](https://claude.com/claude-code) 또는 [Codex](https://developers.openai.com/codex/cli) CLI
  — 러너가 `claude`/`codex`를 헤드리스로 구동한다 (`--agent`로 선택)
- 대상 프로젝트에 **기계 검증 가능한 게이트**가 있을 것 (테스트·빌드·린트 등 종료코드로 판정되는 명령)

## 사용

```bash
bun install
bun link          # zannabi 명령 등록 (생략하려면 bun run packages/cli/src/index.ts 로 대체)

zannabi run "작업 설명" --cwd /path/to/project --gate "test:bun test" --budget 3
```

| 옵션 | 뜻 |
|---|---|
| `--gate "<이름>:<명령>"` | 검증 게이트. 여러 번 줄 수 있다 |
| `--budget <N>` | 재시도 횟수 (기본 3) |
| `--agent claude\|codex` | 구동할 코딩 에이전트 (기본 claude) |
| `--model <이름>` | 에이전트 모델 지정 |
| `--plan-agent` · `--plan-model` | 계획 턴만 다른 런타임/모델로 |
| `--exec-agent` · `--exec-model` | 실행 턴만 다른 런타임/모델로 |
| `--yes` | 승인 프롬프트를 건너뛴다 (배치 실행용) |

**생성-검증 분리.** 계획과 실행에 다른 런타임을 쓸 수 있다.

```bash
zannabi run "..." --plan-model claude-opus-5 --exec-model claude-haiku-4-5-20251001
zannabi run "..." --plan-agent claude --exec-agent codex
```

판정은 어차피 게이트가 하므로, 강한 모델이 계획하고 저가 모델이 실행해도 품질이 유지되는가 —
이것이 "생성은 싸고 검증이 병목"이라는 이 프로젝트의 베팅이고, 이 옵션이 그걸 재는 손잡이다.
어떤 조합으로 돌았는지는 `goal.json`과 `report.md`의 `runtime` 에 남는다.
계획 세션은 계획 런타임의 것이므로 분리 실행이면 실행 턴으로 넘기지 않는다 (계획 내용 자체는 프롬프트에 담긴다).

**`--yes` 주의.** 설계상 사람의 승인은 유일한 개입 지점이다. 이를 건너뛰는 대신 러너가
게이트의 실행 가능성을 먼저 확인하고, 실행할 수 없는 게이트가 있으면 거부한다.
이 검사는 명령의 **존재**만 본다 — 작업 전 실패하는 게이트는 정상이므로 통과/불통과는 판정하지 않는다.

## 증거 디렉토리

`plan.md`(승인된 계획) · `goal.json`(intent/게이트/예산) · `transcript.jsonl`(에이전트 이벤트)
· `evidence.json`(라운드별 게이트 결과) · `diff.patch`(변경분) · `report.md`(요약·실패 사유·런타임 조합)

`diff.patch` 는 **신규 파일을 포함**한다. 이를 위해 인덱스가 필요하지만 러너는 대상 저장소의
인덱스를 건드리지 않는다 — 실제 인덱스를 임시 파일로 복사해 쓰므로 스테이징 상태는 그대로다.

## 패키지

- `@zannabi-lab/core` — 런타임 중립: 스키마, 게이트 러너, PEV 루프, 증거 저장소
- `@zannabi-lab/adapter-claude` — Claude Code 헤드리스 어댑터
- `@zannabi-lab/adapter-codex` — Codex CLI 헤드리스 어댑터
- `@zannabi-lab/cli` — `zannabi` 명령

두 번째 어댑터를 붙이며 확인된 것: **PEV 루프·게이트 러너·증거 저장소는 한 줄도 바뀌지 않았다.**
core 변경분은 두 어댑터가 공유하는 프로세스 구동 배관을 추출한 것뿐이고, `AgentAdapter` 계약 자체는 그대로다.

같은 ZANNABI LAB의 [oh-my-zannabi](https://github.com/ZANNABI-LAB/oh-my-zannabi)(Claude Code
조련 레이어)와 상호보완: 러너가 구동하는 Claude Code에 oh-my-zannabi 설정이 그대로 적용된다.

## 개발

```bash
bun test        # 90개
bun run typecheck
```

## 라이선스

[Apache License 2.0](LICENSE)
