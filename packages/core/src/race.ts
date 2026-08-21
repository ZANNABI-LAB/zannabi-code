/**
 * best-of-N — 같은 작업을 여러 조합으로 동시에 돌리고, 게이트로 고른다.
 *
 * **왜 이것이 우리 자리인가**: 검증자가 에이전트인 도구는 N개 결과 중 무엇이 나은지를
 * 결국 모델에게 묻는다(자기 확신도·자기 평가). 게이트를 러너가 직접 돌리는 구조에서는
 * **종료코드가 고른다** — 통과와 불통과 사이에 해석의 여지가 없다.
 *
 * **계획은 공유한다.** 조마다 계획까지 다르면 무엇 때문에 이겼는지 알 수 없다.
 * 변수는 실행 턴 하나여야 비교가 성립하고, 그것이 이 프로젝트의 베팅
 * ("강한 계획 + 약한 실행")을 재는 방식이기도 하다.
 *
 * **이겼다고 함부로 말하지 않는다.** 실측에서 라운드 수는 조합을 가르지 못했고
 * (11회 전부 attempts 1), 비용은 보고하지 않는 런타임이 섞인다. 비교할 수 없는 축으로
 * 순위를 매기면 그 순위를 믿고 조합을 고르는 판단이 틀어진다 — 무엇으로 갈랐는지 함께 적는다.
 */
import type { LoopResult } from './loop'
import type { CostCoverage } from './cost'

/** 한 조(組). 실행 턴의 런타임만 다르다 */
export interface RaceArm {
  /** 사람이 읽는 이름. 기본은 `agent:model` 표기 그대로다 */
  name: string
  agent: string
  model?: string
}

export interface ArmOutcome {
  arm: RaceArm
  /** 이 조의 실행 기록이 어디 남았는지 */
  runId: string
  result: LoopResult
  /** 시작부터 끝까지 걸린 시간 */
  elapsedMs: number
  /** 이 조가 남긴 브랜치. 워크트리로 돌았을 때만 */
  branch?: string
  /** 브랜치에 쌓인 커밋 수 */
  commits?: number
}

export interface RaceSummary {
  raceId: string
  intent: string
  arms: ArmOutcome[]
  /**
   * 조들이 공유한 계획 턴의 비용. 조가 아니라 race 전체가 한 번 낸다.
   *
   * **이것을 빼먹으면 집계가 실제 지출보다 항상 적다.** 조별 비용은 실행 턴만 세는 것이
   * 옳지만(조끼리 비교되는 것은 그것뿐이다), 총액은 실제로 쓴 돈이어야 한다 —
   * "집계 = 개별 합"이라는 이 기능의 완료 기준이 그 지점에서 깨진다.
   */
  planCostUsd?: number
  /** 게이트를 전부 통과한 조 */
  passed: ArmOutcome[]
  /** 통과하지 못한 조. 이유는 각자의 `result.status`에 있다 */
  failed: ArmOutcome[]
  /**
   * 보고된 비용의 합. **일부만 보고했으면 그 사실이 커버리지에 실린다** —
   * 개별 실행에서 지키던 규칙이 집계에서 무너지면, 합계가 가장 거짓말하기 쉬운 자리가 된다.
   */
  totalCostUsd?: number
  costCoverage: CostCoverage
  /** 이긴 조. 가를 수 없으면 없다 */
  winner?: ArmOutcome
  /** 무엇으로 갈랐는지. 승자가 없으면 왜 없는지 */
  verdict: string
}

/** 이 조가 쓴 돈. 계획은 공유되므로 실행 턴만 센다 — 조끼리 비교되는 것은 그것뿐이다 */
function armCost(outcome: ArmOutcome): number | undefined {
  return outcome.result.usage?.exec.costUsd
}

/**
 * 통과한 조들 중에서 고른다.
 *
 * 순서: ① 라운드가 적은 쪽 ② 비용이 적은 쪽(양쪽 다 보고했을 때만) ③ 빨리 끝난 쪽.
 * 라운드를 먼저 보는 이유는 그것이 **모든 런타임이 동등하게 보고하는 유일한 축**이어서다.
 * 비용은 보고하지 않는 런타임이 있어 2순위로 밀린다 — 없는 값으로 순위를 매기면
 * 침묵한 런타임이 언제나 이기거나 언제나 진다.
 */
function pickWinner(passed: ArmOutcome[]): { winner?: ArmOutcome; verdict: string } {
  if (passed.length === 0) return { verdict: '게이트를 통과한 조가 없습니다 — 고를 것이 없습니다' }
  if (passed.length === 1)
    return { winner: passed[0], verdict: `${passed[0].arm.name}만 게이트를 통과했습니다` }

  const sorted = [...passed].sort((a, b) => {
    if (a.result.attempts !== b.result.attempts) return a.result.attempts - b.result.attempts
    const [ca, cb] = [armCost(a), armCost(b)]
    if (ca !== undefined && cb !== undefined && ca !== cb) return ca - cb
    return a.elapsedMs - b.elapsedMs
  })
  const [first, second] = sorted

  const byRounds = first.result.attempts < second.result.attempts
  if (byRounds)
    return {
      winner: first,
      verdict: `${first.arm.name}이 가장 적은 라운드로 통과했습니다 (${first.result.attempts}R vs ${second.result.attempts}R)`,
    }

  const [c1, c2] = [armCost(first), armCost(second)]
  if (c1 !== undefined && c2 !== undefined && c1 !== c2)
    return {
      winner: first,
      verdict: `라운드 수가 같아 비용으로 갈랐습니다 — ${first.arm.name} $${c1.toFixed(4)} vs ${second.arm.name} $${c2.toFixed(4)}`,
    }

  // 여기까지 왔으면 라운드도 같고 비용은 비교할 수 없다. 시간으로 고르되 그 사실을 밝힌다
  const silent = sorted.filter(o => armCost(o) === undefined).map(o => o.arm.name)
  const why =
    silent.length > 0
      ? `비용을 보고하지 않는 조가 있어(${silent.join(', ')}) 비용으로는 가를 수 없었습니다`
      : '라운드도 비용도 같았습니다'
  return {
    winner: first,
    verdict: `${why} — 먼저 끝난 ${first.arm.name}을 골랐습니다 (${(first.elapsedMs / 1000).toFixed(1)}s)`,
  }
}

/**
 * 조들의 결과를 집계한다.
 *
 * 완료 기준이 "판정·비용 집계 = 개별 합"인 이유가 여기 있다 — 집계가 개별 실행과
 * 다른 말을 하기 시작하면 병렬은 측정 도구가 아니라 측정을 망치는 장치가 된다.
 */
export function summarizeRace(
  raceId: string,
  intent: string,
  arms: ArmOutcome[],
  /** 공유된 계획 턴이 보고한 비용. 보고하지 않는 런타임이면 없다 */
  planCostUsd?: number,
): RaceSummary {
  const passed = arms.filter(a => a.result.status === 'success')
  const failed = arms.filter(a => a.result.status !== 'success')

  // 돈을 쓴 조 중 몇이 보고했는지로 커버리지를 정한다. 개별 실행에서 쓰는 규칙 그대로다
  const ran = arms.filter(a => a.result.usage !== undefined)
  const reported = ran.filter(a => armCost(a) !== undefined)
  // 계획 턴도 돈을 쓴 축이다. 조가 아니라 race가 한 번 내지만, 안 세면 총액이 거짓이 된다
  const planReported = planCostUsd !== undefined
  const costCoverage: CostCoverage =
    ran.length === 0
      ? 'not-run'
      : reported.length === 0 && !planReported
        ? 'none'
        : reported.length === ran.length && planReported
          ? 'full'
          : 'partial'
  // 아무도 보고하지 않았으면 0이 아니라 없는 것이다 — 0으로 적으면 공짜라는 거짓이 된다
  const armTotal = reported.reduce((sum, a) => sum + (armCost(a) ?? 0), 0)
  const totalCostUsd =
    reported.length === 0 && !planReported ? undefined : armTotal + (planCostUsd ?? 0)

  const { winner, verdict } = pickWinner(passed)
  return {
    raceId,
    intent,
    arms,
    passed,
    failed,
    ...(planCostUsd === undefined ? {} : { planCostUsd }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    costCoverage,
    ...(winner === undefined ? {} : { winner }),
    verdict,
  }
}

/**
 * `agent[:model]` 한 줄을 조로 읽는다.
 *
 * 계획 런타임을 여기서 받지 않는 것은 의도다 — **조는 실행 턴만 가른다.**
 * 계획까지 조마다 다르면 변수가 둘이 되어 무엇 때문에 이겼는지 말할 수 없다.
 */
export function parseArm(spec: string, allowedAgents: readonly string[]): RaceArm {
  const trimmed = spec.trim()
  if (!trimmed) throw new Error('--arm 값이 비어 있습니다')
  const idx = trimmed.indexOf(':')
  const agent = idx === -1 ? trimmed : trimmed.slice(0, idx)
  const model = idx === -1 ? undefined : trimmed.slice(idx + 1)
  if (!allowedAgents.includes(agent))
    throw new Error(`--arm의 런타임은 ${allowedAgents.join(' | ')} 중 하나여야 합니다: ${agent}`)
  if (model !== undefined && model.trim() === '')
    throw new Error(`--arm에 모델이 비어 있습니다: ${spec}`)
  return { name: trimmed, agent, ...(model === undefined ? {} : { model }) }
}

/**
 * 여러 작업을 정해진 동시 실행 수 안에서 돌린다.
 *
 * 왜 상한을 두는가: 조 하나가 에이전트 프로세스 하나에 게이트 프로세스 하나를 더 쓴다.
 * 조가 열이면 스무 개가 붙고, 그러면 게이트의 소요시간이 서로의 부하로 늘어나 —
 * **재확인의 소요시간 비교(캐시 감지)가 그때부터 못 믿을 값이 된다.**
 */
export async function runConcurrent<T>(
  jobs: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(jobs.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= jobs.length) return
      results[index] = await jobs[index]()
    }
  })
  await Promise.all(workers)
  return results
}
