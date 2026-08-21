/**
 * 비용 상한.
 *
 * 왜 라운드 예산과 **별도의 축**이 필요한가: `--budget`은 라운드 수의 상한이지 지출의 상한이
 * 아니다. 2026-08-20 실측에서 opus 실행 1라운드가 $1.64 ~ $4.53으로 **2.8배** 흩어졌다.
 * 그러면 `--budget 4`는 실제로는 "$6.5에서 $18 사이 어딘가"라는 뜻이고, 사용자는 돌리기 전에
 * 그 폭을 알 방법이 없다. 라운드 수가 조합을 가르는 축이 아니라는 것이 같은 측정의 결론이었으므로,
 * 남는 축은 비용이다.
 *
 * 이 문제는 우리만의 것이 아니고 답도 이미 수렴해 있다 — SWE-agent는
 * `per_instance_cost_limit`(기본 $3)을 걸고 초과하면 그때까지의 작업물을 남긴 채 끝내며,
 * OpenHands는 이터레이션 상한만으로는 새는 것을 겪고 **누적 비용 컷오프를 따로 걸라**고 권고한다.
 *
 * **예측하지 않는다.** "다음 라운드가 얼마 나올 것"을 추정해 미리 멈추는 설계도 가능하지만,
 * 편차 2.8배를 관측해 놓고 그 분포로 다음 값을 부르는 것은 근거 없는 숫자를 만드는 일이다.
 * 누적이 상한에 닿았는지만 본다.
 */
import type { Usage } from './adapter'

/** 계획 턴과 실행 턴의 사용량. 이 축을 나눠 두는 이유는 {@link Usage} 참고 */
export interface UsageSplit {
  plan: Usage
  exec: Usage
}

/**
 * 상한이 실제로 지출의 얼마를 덮고 있는지.
 *
 * 이 구분이 없으면 안 되는 이유: 비용을 보고하는 러너와 안 하는 러너가 섞인다(codex는 안 준다).
 * plan=claude / exec=codex 조합에서 보고된 값만 보고 "상한 안"이라고 말하면, 러너가
 * **통과가 아닌 것을 통과라고 말하는** 그 실패의 비용 판(版)이 된다.
 */
export type CostCoverage =
  /** 자원을 쓴 모든 턴이 비용을 보고했다 — 상한이 지출 전체를 본다 */
  | 'full'
  /** 일부 턴만 보고했다 — 상한은 지출의 일부만 본다 */
  | 'partial'
  /** 돈을 쓴 턴이 있는데 아무도 보고하지 않았다 — 상한이 걸릴 수 없다 */
  | 'none'
  /**
   * 애초에 돈을 쓴 턴이 없다 — 사전점검 실패처럼 한 턴도 돌지 않고 끝난 실행.
   *
   * `none`과 갈라 두는 이유: 실측에서 사전점검이 죽은 실행이 "이 런타임은 비용을 보고하지
   * 않는다"고 리포트했다. **사실이 아니다** — 그 런타임은 보고할 기회조차 없었다.
   * 러너가 관측하지 않은 것을 관측한 것처럼 말하면, 그 말을 믿고 조합을 고르는 판단이 틀어진다.
   */
  | 'not-run'

/**
 * 어느 축이 실제로 돌았는지. 루프만이 아는 사실이라 밖에서 받는다.
 *
 * **왜 `turns > 0`으로 갈음할 수 없는가**: `turns`는 "우리가 아는 턴 수"지 "실제 턴 수"가
 * 아니다. 사용량을 통째로 보고하지 않는 어댑터는 돌고도 `turns`가 0으로 남아,
 * 침묵한 축이 **아직 안 돈 축으로 위장**된다. 그러면 커버리지가 `partial`이어야 할 실행이
 * `full`로 보고되고, 상한이 지출의 일부만 봤다는 경고가 사라진다 — 상한을 건 사람이
 * 보호받고 있다고 잘못 믿게 되는, 이 축에서 가장 나쁜 실패다.
 * (테스트가 잡았다: plan만 비용을 보고하는 분리 실행이 `full`로 판정됐다.)
 */
export interface RanAxes {
  plan: boolean
  exec: boolean
}

/**
 * 돈을 쓴 축만 센다.
 *
 * `ran`을 주면 그것이 사실의 근거고, 없으면 `turns > 0`으로 추정한다 — 추정은
 * 사용량을 보고하는 어댑터에서만 맞는다. 루프는 언제나 `ran`을 준다.
 */
function reportingAxes(
  usage: UsageSplit,
  ran?: RanAxes,
): { active: number; spent: number; silent: number; sum: number } {
  let active = 0
  let spent = 0
  let silent = 0
  let sum = 0
  for (const [axis, u] of [['plan', usage.plan], ['exec', usage.exec]] as const) {
    const ranThisAxis = ran ? ran[axis] : u.turns > 0
    if (!ranThisAxis) continue
    active++
    if (u.costUsd === undefined) silent++
    else {
      spent++
      sum += u.costUsd
    }
  }
  return { active, spent, silent, sum }
}

/** 보고된 비용 합계. 아무도 보고하지 않았으면 undefined — 0으로 채우면 "공짜"라는 거짓이 된다 */
export function reportedCost(usage: UsageSplit, ran?: RanAxes): number | undefined {
  const { spent, sum } = reportingAxes(usage, ran)
  return spent === 0 ? undefined : sum
}

export function costCoverage(usage: UsageSplit, ran?: RanAxes): CostCoverage {
  const { active, spent, silent } = reportingAxes(usage, ran)
  if (active === 0) return 'not-run'
  if (spent === 0) return 'none'
  return silent === 0 ? 'full' : 'partial'
}

/** 상한 검사 한 번의 결과. 멈출지와, 그 판단이 무엇에 근거했는지를 함께 담는다 */
export interface CostVerdict {
  /** 보고된 누적이 상한에 닿았는가. 미보고면 절대 true가 되지 않는다 */
  exceeded: boolean
  limitUsd: number
  /** 보고된 누적. 미보고면 없다 */
  spentUsd?: number
  coverage: CostCoverage
}

/**
 * 누적이 상한에 닿았는지 본다.
 *
 * `>=`인 이유: 상한은 "여기까지 써도 된다"가 아니라 "여기서 멈춘다"는 선이다. 정확히 상한에
 * 닿은 채로 한 라운드를 더 시작하면 그 라운드는 반드시 상한을 넘긴다.
 *
 * 미보고 축이 섞여 있어도(`partial`) 보고된 것만으로 판정한다 — 덜 보고된 만큼 상한이
 * 늦게 걸릴 뿐이고, 그 사실은 {@link CostVerdict.coverage}로 함께 나간다.
 */
export function checkCost(usage: UsageSplit, limitUsd: number, ran?: RanAxes): CostVerdict {
  const spentUsd = reportedCost(usage, ran)
  return {
    exceeded: spentUsd !== undefined && spentUsd >= limitUsd,
    limitUsd,
    ...(spentUsd === undefined ? {} : { spentUsd }),
    coverage: costCoverage(usage, ran),
  }
}

/** 상한이 제 일을 못 하고 있을 때 사람에게 할 말. 문제없으면 undefined */
export function coverageWarning(verdict: CostVerdict): string | undefined {
  // 한 턴도 안 돈 실행에 대고 런타임을 평하지 않는다 — 관측하지 않은 것은 말하지 않는다
  if (verdict.coverage === 'full' || verdict.coverage === 'not-run') return undefined
  if (verdict.coverage === 'none')
    return (
      `비용 상한 $${verdict.limitUsd}을 걸었지만 이 실행의 런타임이 비용을 보고하지 않습니다` +
      ' — 상한은 이번 실행에서 걸리지 않습니다(codex가 비용을 주지 않는 쪽입니다)'
    )
  return (
    `비용 상한 $${verdict.limitUsd}이 지출의 일부만 봅니다 — 계획/실행 중 한쪽이 비용을` +
    ' 보고하지 않아, 보고된 금액이 상한 아래라도 실제 지출은 그보다 큽니다'
  )
}
