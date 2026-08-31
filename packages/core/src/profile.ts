/**
 * 조합 프리셋.
 *
 * 난이도를 보고 조합을 **자동으로** 고르는 것이 목표지만, 그 판단 신호(비용·라운드 실적)는
 * 아직 쌓이지 않았다. 없는 데이터로 규칙을 박는 대신, 이미 근거가 있는 것만 담는다 —
 * 초기 8회 실측에서 나온 운용 방침이다:
 *   · 계획 모델을 낮춘 조는 0/2 (실패 지점은 구현이 아니라 게이트 설계였다)
 *   · 실행 모델을 낮춰도 대체로 통과했고, 대가는 품질이 아니라 라운드 수였다
 *   · codex 실행이 가장 안정적이었다 (2/2, attempts 1)
 *
 * 그래서 프리셋은 **실행 턴만 건드리고 계획 턴은 손대지 않는다.** 계획 런타임을 비워 두면
 * 사용자가 이미 고른 기본값(대개 강한 모델)이 그대로 쓰인다 — "계획은 낮추지 마라"를
 * 값을 지정하는 방식이 아니라 건드리지 않는 방식으로 지킨다.
 */

import { DEFAULT_BUDGET } from './progress'

/** 실행 턴을 낮출 때 쓰는 저가 모델. 날짜 접미사 없는 별칭이 권장 표기다 */
const CHEAP_CLAUDE_MODEL = 'claude-haiku-4-5'

export interface Profile {
  /** 이 프리셋이 무엇을 하는지 — --help와 리포트에 그대로 실린다 */
  summary: string
  /** 실행 턴 런타임. 지정하지 않으면 사용자 기본값을 그대로 둔다 */
  execAgent?: string
  execModel?: string
  budget?: number
  verifyRepeat?: number
}

export const PROFILES = {
  /**
   * 실행을 저가 모델로 낮추고 예산을 늘린다.
   * 실측에서 저가 실행의 대가는 품질이 아니라 라운드 수였으므로, 그 대가를 예산으로 산다.
   */
  cheap: {
    summary: `실행을 저가 모델로(claude:${CHEAP_CLAUDE_MODEL}) · 예산 5`,
    execAgent: 'claude',
    execModel: CHEAP_CLAUDE_MODEL,
    budget: 5,
  },
  /** 실측에서 가장 안정적이었던 조합 — codex 실행은 2/2 성공에 attempts 1이었다 */
  balanced: {
    summary: '실행을 codex로 · 예산 4',
    execAgent: 'codex',
    budget: DEFAULT_BUDGET,
  },
  /**
   * 아무것도 낮추지 않고, 대신 통과를 재확인한다.
   * "safe"는 더 강한 모델을 쓰는 것이 아니라 **증거를 더 요구하는 것**이다 —
   * 이 프로젝트에서 안전은 모델 등급이 아니라 검증 강도의 문제다.
   */
  safe: {
    summary: '기본 런타임 유지 · 예산 4 · 통과 2회 재확인',
    budget: DEFAULT_BUDGET,
    verifyRepeat: 2,
  },
} as const satisfies Record<string, Profile>

export type ProfileName = keyof typeof PROFILES
export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[]

export function isProfileName(value: string): value is ProfileName {
  return value in PROFILES
}
