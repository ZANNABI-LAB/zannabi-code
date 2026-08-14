<p align="center">
  <img src="docs/assets/hero.png" alt="zannabi-code — verification-first external runner" width="100%">
</p>

# zannabi-code

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![runtime](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![tests](https://img.shields.io/badge/tests-38%20passing-brightgreen)]()

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
- [Claude Code](https://claude.com/claude-code) CLI — 러너가 `claude`를 헤드리스로 구동한다
- 대상 프로젝트에 **기계 검증 가능한 게이트**가 있을 것 (테스트·빌드·린트 등 종료코드로 판정되는 명령)

## 사용

```bash
bun install
bun run packages/cli/src/index.ts run "작업 설명" --cwd /path/to/project \
  --gate "test:bun test" --budget 3
```

`--gate` 는 `<이름>:<명령>` 형식이며 여러 번 줄 수 있다. `--budget` 은 재시도 횟수(기본 3).

## 증거 디렉토리

`plan.md`(승인된 계획) · `goal.json`(intent/게이트/예산) · `transcript.jsonl`(에이전트 이벤트)
· `evidence.json`(라운드별 게이트 결과) · `diff.patch`(변경분) · `report.md`(요약)

## 패키지

- `@zannabi-lab/core` — 런타임 중립: 스키마, 게이트 러너, PEV 루프, 증거 저장소
- `@zannabi-lab/adapter-claude` — Claude Code 헤드리스 어댑터
- `@zannabi-lab/cli` — `zannabi` 명령

같은 ZANNABI LAB의 [oh-my-zannabi](https://github.com/ZANNABI-LAB/oh-my-zannabi)(Claude Code
조련 레이어)와 상호보완: 러너가 구동하는 Claude Code에 oh-my-zannabi 설정이 그대로 적용된다.

## 개발

```bash
bun test        # 38개
bun run typecheck
```

## 라이선스

[Apache License 2.0](LICENSE)
