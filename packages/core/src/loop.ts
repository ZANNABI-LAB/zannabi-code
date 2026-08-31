import { addUsage, emptyUsage, type AgentAdapter, type Usage } from './adapter'
import type { Gate, Evidence, Round, DroppedGate } from './goal'
import { extractGates, mergeGates } from './goal'
import { runGate, preflightGates, type GateWarning } from './gates'
import { planPrompt, executePrompt, failureSummary } from './prompts'
import { captureRevision } from './revision'
import { roundSignature, repeatOf, shouldStop, stallDetectionDead, DEFAULT_STALL_LIMIT } from './progress'
import { recheckGates, recheckSuspects, suppressedByCold, DEFAULT_VERIFY_REPEAT } from './recheck'
import {
  checkCost,
  costCoverage,
  coverageWarning,
  reportedCost,
  type CostVerdict,
  type RanAxes,
  type UsageSplit,
} from './cost'
import { CONTRACT_VERSION } from './journal'
import { WHOLE_RUN, type EvidenceLoss, type RunStore } from './store'

export type ApprovalDecision = { action: 'approve' } | { action: 'abort'; reason?: string }

export interface LoopOptions {
  intent: string
  userGates: Gate[]
  budget: number
  cwd: string
  /** 계획 턴에 쓰는 어댑터. execAdapter가 없으면 실행 턴에도 이것을 쓴다 */
  adapter: AgentAdapter
  /**
   * 실행 턴 전용 어댑터 — 생성-검증 분리용.
   * 강한 모델이 계획하고 저가 모델이 실행해도 판정은 게이트가 하므로 품질이 유지되는가,
   * 가 이 프로젝트의 핵심 베팅이고 이 옵션이 그것을 재는 손잡이다.
   */
  execAdapter?: AgentAdapter
  store: RunStore
  approve(plan: string, gates: Gate[], warnings: GateWarning[]): Promise<ApprovalDecision>
  log(message: string): void
  /** 증거에 남길 런타임 표기 (예: plan="claude:opus-5", exec="codex:gpt-5.4") */
  runtime?: RuntimeLabels
  /**
   * 리비전과 게이트 결과가 모두 같은 라운드가 이만큼 연속되면 예산을 남기고 중단한다.
   * 0 이하면 감지를 끈다. 기본 {@link DEFAULT_STALL_LIMIT}
   */
  stallLimit?: number
  /**
   * 모든 게이트가 통과한 라운드에서 게이트를 총 몇 번 돌려 재현을 확인할지.
   * 1이면 재확인하지 않는다. 기본 {@link DEFAULT_VERIFY_REPEAT}
   */
  verifyRepeat?: number
  /**
   * 에이전트가 제안한 게이트를 받지 않는다.
   * 완료 기준이 실행마다 달라지면 실행끼리 비교할 수 없어, 재측정의 전제 조건이다.
   */
  rejectSuggested?: boolean
  /** 모든 게이트의 타임아웃을 이 값으로 덮어쓴다 — 제안 게이트에도 걸린다 */
  gateTimeoutMs?: number
  /**
   * 보고된 누적 비용이 이 금액(USD)에 닿으면 라운드를 더 시작하지 않는다.
   *
   * `budget`과 다른 축이다 — 예산은 라운드 수의 상한이지 지출의 상한이 아니고,
   * 실측에서 같은 조합의 1라운드가 2.8배 흩어졌다. 자세한 근거는 `cost.ts`.
   */
  maxCostUsd?: number
  /**
   * 이 실행에 적용된 프리셋 이름. 루프 동작에는 영향이 없고 증거에만 남는다 —
   * 조합별 실적을 모을 때 실행들을 묶는 키다.
   */
  profile?: string
  /**
   * 중단된 실행을 이어받는다. 주면 계획 턴과 승인을 건너뛴다.
   *
   * **승인을 다시 묻지 않는 것이 재개의 정의다** — 다시 묻는 것은 이어가는 것이 아니라
   * 새 실행이다. 완료 기준(게이트)과 계획은 이미 사람이 승인한 그대로 쓴다.
   */
  resume?: ResumeState
  /**
   * 이미 세워지고 승인된 계획으로 시작한다 — 계획 턴을 돌리지 않는다.
   *
   * best-of-N(`race`)이 쓰는 자리다. **모든 조에 같은 계획을 주어야 비교가 성립한다** —
   * 계획까지 조마다 다르면 무엇 때문에 이겼는지 알 수 없고, 계획 비용을 N번 내며,
   * 무엇보다 승인이 N번 뜨는 도구는 쓸 수 없다.
   *
   * {@link resume}과 다른 점: 재개는 **중단된 실행을 이어받는** 것이라 라운드 이력과
   * 지출을 승계하지만, 이쪽은 라운드 0에서 시작하는 새 실행이다.
   */
  sharedPlan?: {
    text: string
    gates: Gate[]
    /**
     * 승인 단계에서 버려진 제안 게이트. **호출자가 병합했으므로 루프는 스스로 알 수 없다.**
     *
     * 없으면 race에서만 이 경고가 조용히 사라진다 — 일반 실행은 "제안 게이트를 이래서
     * 버렸다"를 리포트와 승인 화면에 싣는데, 같은 일이 조에서 벌어지면 아무도 모른다.
     * 버려진 게이트는 대개 이름 충돌이고, 그것은 완료 기준이 흔들렸다는 신호다.
     */
    dropped?: DroppedGate[]
  }
  /** best-of-N의 조로 도는 실행이면 그 race의 이름. 증거에만 남고 루프 동작에는 영향이 없다 */
  raceId?: string
  /**
   * 이 실행이 **차가운 작업 공간**에서 시작하는가(격리된 새 워크트리 등).
   *
   * 루프는 여전히 워크트리를 모른다 — 아는 것은 "첫 라운드의 첫 회가 콜드다"라는 사실뿐이고,
   * 그것이 재확인의 비율 판정을 구조적으로 오탐시킨다. 호출자만 아는 사실이라 받는다.
   */
  coldWorkspace?: boolean
  /**
   * 실행 턴의 에이전트가 **게이트 명령을 스스로 돌릴 수 있게** 한다. 기본 켬.
   *
   * **판정과 층이 다르다.** 여기서 무엇을 돌리든 완료는 러너가 돌린 게이트 결과로만
   * 정해진다. 이것은 자기 확인이다 — 실측에서 실행 턴이 컴파일 0회로 1,092줄을 썼고,
   * 라운드가 유일한 피드백 루프인 탓에 오타 하나가 라운드 하나($2~3) 값이었다.
   *
   * 끄면 그 상태로 돌아간다. 기본을 켠 이유는 **새 위험이 생기지 않기 때문**이다 —
   * 여는 것은 러너가 어차피 돌릴 명령뿐이다.
   */
  execShell?: boolean
  /**
   * 라운드 하나가 끝날 때마다 불린다 — 워크트리 격리가 라운드별 커밋을 남기는 자리다.
   *
   * 루프에 워크트리 개념을 넣지 않은 이유: 어댑터도 게이트도 리비전도 `cwd` 하나만 보므로,
   * 격리는 **호출자가 다른 `cwd`를 주는 것**으로 끝난다. 루프가 알아야 할 것은
   * "라운드가 끝났다"는 사실뿐이고, 그것으로 무엇을 할지는 호출자의 몫이다.
   *
   * 여기서 던지는 예외는 실행을 죽이지 않는다 — 커밋 실패로 판정을 뒤집는 것은
   * 뒤바뀐 우선순위다. 실패는 로그로만 나간다.
   */
  afterRound?(round: Round): Promise<void>
}

/**
 * 재개가 이어받는 것. 저널 재생에서 나오는 값이 그대로 들어온다.
 *
 * **계획 본문만 저널 밖(`plan.md`)에서 온다.** 저널에 계획 전문을 싣는 설계도 가능했지만
 * 한 줄이 수 KB가 되고 `plan.md`와 같은 내용이 두 벌 남는다. 상태 재구성(`status`)은
 * 저널 하나로 되고, 재개는 실행 디렉토리 전체를 쓴다 — 두 요구는 다르다.
 */
export interface ResumeState {
  /** 승인됐던 계획 본문. 실행 프롬프트에 그대로 들어간다 */
  planText: string
  /** 승인됐던 게이트. 재개가 이것을 다시 정하면 완료의 정의가 실행 도중에 바뀐다 */
  gates: Gate[]
  /** 이미 완료된 라운드들. 정체 감지와 리포트가 이 이력 위에서 이어진다 */
  rounds: Round[]
  /** 다음에 돌 라운드 번호. 중단된 라운드는 처음부터 다시 돈다 */
  startRound: number
  /** 이전까지의 사용량. 승계하지 않으면 재개할 때마다 비용 상한이 리셋된다 */
  usage: UsageSplit
  /** 실행 턴이 마지막으로 남긴 세션 */
  sessionId?: string
}

export interface RuntimeLabels {
  plan: string
  exec: string
}

/**
 * 실행이 끝날 수 있는 모든 방식.
 *
 * 타입이 아니라 **값**으로 두는 이유: 계약 문서가 이 목록을 그대로 싣는데, 타입은 런타임에
 * 없어서 문서와 코드가 갈렸는지 확인할 방법이 없다. 값이면 테스트가 대조할 수 있다.
 */
export const RUN_STATUSES = [
  'success',
  'budget-exhausted',
  'aborted',
  'env-error',
  'agent-error',
  'no-gates',
  'no-progress',
  'unreproduced-pass',
  'cost-exhausted',
  'evidence-lost',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export interface LoopResult {
  status: RunStatus
  attempts: number
  /** 라운드별 기록. 각 라운드가 어떤 리비전을 검사했고 앞 라운드의 반복인지까지 담는다 */
  rounds: Round[]
  /** 계획 턴과 실행 턴이 각각 쓴 자원. 조합별 실적을 비교하는 유일한 실측 축이다 */
  usage?: { plan: Usage; exec: Usage }
  /** 실패 사유 한 줄. report.md에 실려 transcript를 뒤지지 않아도 되게 한다 */
  detail?: string
  /** 어떤 조합으로 돌았는지 — 가설 측정의 기본 축이라 결과에 함께 남긴다 */
  runtime?: RuntimeLabels
  /**
   * 채택되지 못한 제안 게이트. 비어 있어도 배열로 남긴다.
   *
   * 에이전트가 러너의 눈먼 지점을 짚은 제안이 이름 충돌로 조용히 사라진 실행이 있었다.
   * 결과에 실어야 report.md가 그것을 말할 수 있다.
   */
  dropped?: DroppedGate[]
  /**
   * 이 실행에서 정체 감지가 구조적으로 죽어 있었는지(`stallLimit >= budget`).
   * 예산 소진으로 끝난 실행을 나중에 읽을 때, 감지가 안 걸린 것인지 못 걸린 것인지 갈린다.
   */
  stallDead?: boolean
  /**
   * 이 실행 도중 증거가 사라진 기록. 비어 있으면 아예 없다.
   *
   * 실측에서 대상 에이전트가 `.zannabi/`를 통째로 지웠다 — 증거 저장소는 대상 저장소 안에 있고
   * 작업하는 쪽이 지울 수 있다. 이 배열이 비어 있지 않으면 **판정이 증거로 뒷받침되지 않는다.**
   */
  evidenceLoss?: EvidenceLoss[]
  /**
   * 비용 상한을 건 실행에서만 있다. 멈췄는지뿐 아니라 **상한이 지출의 얼마를 봤는지**를
   * 함께 담는다 — 비용을 보고하지 않는 런타임이 섞이면 상한은 일부만 보고, 그 사실을
   * 감추면 "상한 안에서 끝났다"가 거짓이 된다.
   */
  cost?: CostVerdict
}

/**
 * 마지막 라운드에서 사용자 게이트와 제안 게이트가 각각 어떻게 끝났는지.
 *
 * 예산 소진은 "아무것도 안 됐다"처럼 읽히지만, 실제로는 완료 기준(사용자 게이트)을 전부
 * 통과하고 에이전트가 스스로 건 게이트에서만 막힌 실행이 있었다. 그 차이를 사유 한 줄에 담는다.
 */
function userGateSummary(rounds: Round[]): string | undefined {
  const last = rounds.at(-1)?.evidence
  if (!last || last.length === 0) return undefined
  const tally = (source: Evidence['source']) => {
    const of = last.filter(e => e.source === source)
    return { total: of.length, passed: of.filter(e => e.outcome === 'pass').length }
  }
  const user = tally('user')
  const agent = tally('suggested')
  const parts: string[] = []
  if (user.total > 0) parts.push(`사용자 게이트 ${user.passed}/${user.total} 통과`)
  if (agent.total > 0) parts.push(`제안 게이트 ${agent.passed}/${agent.total} 통과`)
  if (user.total > 0 && user.passed === user.total && agent.passed < agent.total)
    parts.push('완료 기준은 모두 충족했고 에이전트가 제안한 게이트만 남았습니다')
  return parts.join(' · ') || undefined
}

/**
 * 버려진 제안 게이트를 승인 화면에 띄울 경고로 바꾼다.
 *
 * `advisory`인 이유: 제안이 밀렸다는 사실이 실행을 막을 근거는 아니다. 사용자 게이트가
 * 이기는 것은 설계대로다. 다만 `--yes`로 사람이 안 볼 때도 report.md에는 남아야 한다.
 */
function droppedWarning(d: DroppedGate): GateWarning {
  return {
    gate: d.name,
    cmd: d.cmd,
    kind: 'advisory',
    reason:
      d.reason === 'rejected'
        ? '제안 게이트를 받지 않는 설정이라 이 제안을 쓰지 않았습니다'
        : `같은 이름의 사용자 게이트가 있어 이 제안을 쓰지 않았습니다 (실행된 명령: \`${d.keptCmd}\`)`,
  }
}

/**
 * 상한을 건 실행이라면 **어떤 경로로 끝나든** 비용 판정을 결과에 싣는다.
 * 성공했더라도 그 성공이 지출의 전체를 본 것인지 일부만 본 것인지는 남아야 한다.
 */
export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  // 계획과 실행을 나눠 센다 — "강한 계획 + 약한 실행"의 값을 재려면 두 축이 분리돼야 한다
  const usage: UsageSplit = opts.resume
    ? { plan: opts.resume.usage.plan, exec: opts.resume.usage.exec }
    : { plan: emptyUsage(), exec: emptyUsage() }
  // 어느 축이 실제로 돌았는지는 루프만 안다 — 사용량을 보고하지 않는 어댑터는
  // 돌고도 turns가 0이라, 그 수치로 추정하면 침묵이 "해당 없음"으로 위장된다.
  // 재개면 계획 축은 이전 실행에서 이미 돌았다 — 여기서 안 돌았다고 적으면
  // 커버리지가 "돈을 쓴 적 없음"으로 뒤집혀 상한 경고가 사라진다
  const ran: RanAxes = opts.resume
    ? { plan: true, exec: opts.resume.rounds.length > 0 }
    : { plan: false, exec: false }
  const result = await runLoopWith(opts, usage, ran)
  const withCost =
    opts.maxCostUsd === undefined
      ? result
      : { ...result, cost: checkCost(usage, opts.maxCostUsd, ran) }
  const final = degradeOnEvidenceLoss(withCost, opts.store.losses)
  // 끝을 여기서 한 번만 적는다. runLoopWith의 반환 지점은 열 곳이 넘고, 게다가
  // 증거 소실 강등은 그 뒤에 일어난다 — 각 반환 자리에서 쓰면 저널의 마지막 줄이
  // 리포트와 다른 판정을 말하게 된다
  opts.store.appendJournal({
    type: 'run-finished',
    status: final.status,
    attempts: final.attempts,
    ...(final.detail === undefined ? {} : { detail: final.detail }),
  })
  return final
}

/**
 * 증거가 사라진 실행의 성공을 성공이라 부르지 않는다.
 *
 * 게이트는 실제로 통과했을 수 있다. 그러나 이 프로젝트의 명제는 **"증거 없으면 완료가 아니다"**이고,
 * 통과의 근거가 지워진 실행은 그 명제 아래에서 완료가 아니다. 실패로 끝난 실행은 이미 실패이므로
 * 상태를 건드리지 않고 사실만 덧붙인다 — 없는 성공을 만들지 않듯, 실패의 사유도 바꾸지 않는다.
 */
function degradeOnEvidenceLoss(result: LoopResult, losses: EvidenceLoss[]): LoopResult {
  if (losses.length === 0) return result
  const evidenceLoss = [...losses]
  const what = losses.some(l => l.target === WHOLE_RUN)
    ? '실행 디렉토리가 통째로'
    : `증거 파일(${[...new Set(losses.map(l => l.target))].join(', ')})이`
  const note =
    `실행 도중 ${what} 사라졌습니다 — 작업하는 에이전트가 증거 저장소를 지울 수 있습니다.` +
    ' 되살려 이어갔지만 그 사이의 증거는 남아 있지 않습니다'
  if (result.status !== 'success')
    return { ...result, evidenceLoss, detail: result.detail ? `${result.detail} · ${note}` : note }
  return {
    ...result,
    status: 'evidence-lost',
    evidenceLoss,
    detail: `게이트는 전부 통과했으나 ${note}. 증거가 없으므로 완료로 보지 않습니다`,
  }
}

/**
 * 이어받은 라운드 이력에서 마지막 실패 요약을 되살린다.
 *
 * 성공으로 끝난 라운드가 마지막이면 실행이 끝났을 것이므로 여기 오는 마지막 라운드는
 * 대개 실패한 라운드다. 그래도 확인하고 만든다 — 없는 실패를 프롬프트에 싣지 않는다.
 */
/**
 * 런타임이 실제로 보고한 모델로 라벨을 고친다.
 *
 * 우리가 넘긴 라벨은 **지정한 것**이지 실제로 돈 것이 아니다. 모델은 `--model` 말고도
 * 환경변수·프로필·CLI 기본값으로 정해지고, 실측에서 `ANTHROPIC_MODEL=claude-opus-5`로
 * 띄운 실행이 `claude:default`로 기록됐다. 조합별 비교가 이 프로젝트 측정의 축인데
 * 그 축이 비어서 남은 것이다.
 *
 * 지정한 값과 보고된 값이 다르면 **보고된 쪽을 쓴다** — 실제로 돈 것이 사실이다.
 */
function withActualModel(label: string | undefined, reported?: string): string | undefined {
  if (label === undefined || reported === undefined) return label
  const agent = label.split(':')[0]
  return `${agent}:${reported}`
}

function resumeFeedback(rounds: Round[]): string | undefined {
  const last = rounds[rounds.length - 1]
  if (!last || last.evidence.every(e => e.outcome === 'pass')) return undefined
  return failureSummary(last.evidence, last.repeatOf !== undefined)
}

async function runLoopWith(
  opts: LoopOptions,
  usage: UsageSplit,
  ran: RanAxes,
): Promise<LoopResult> {
  const execAdapter = opts.execAdapter ?? opts.adapter
  const split = execAdapter !== opts.adapter
  // 복사해서 쓴다 — 아래에서 실제 보고된 모델로 고치는데, 호출자가 넘긴 객체를
  // 몰래 바꾸면 같은 객체를 다른 데 쓰는 호출자가 영문 모를 값을 보게 된다
  const runtime = opts.runtime ? { ...opts.runtime } : undefined

  const resumed = opts.resume
  // 저널의 첫 줄. 재개는 이 줄에서 "무엇을 하려던 실행인가"를 읽는다.
  // 이어가는 실행은 같은 저널에 계속 쓴다 — 새 파일로 갈라 두면 한 작업의 이력이
  // 두 곳에 나뉘고, "이 실행이 몇 라운드 돌았나"에 두 개의 답이 생긴다
  opts.store.appendJournal(resumed
    ? {
        type: 'run-resumed',
        fromRound: resumed.startRound,
        completedRounds: resumed.rounds.length,
        ...(runtime === undefined ? {} : { runtime }),
      }
    : {
    type: 'run-started',
    contractVersion: CONTRACT_VERSION,
    runId: opts.store.runId,
    intent: opts.intent,
    cwd: opts.cwd,
    budget: opts.budget,
    ...(runtime === undefined ? {} : { runtime }),
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
    ...(opts.maxCostUsd === undefined ? {} : { maxCostUsd: opts.maxCostUsd }),
    ...(opts.raceId === undefined ? {} : { raceId: opts.raceId }),
  })

  // 0. 사전점검 — 인증 만료처럼 실행 전에 알 수 있는 실패를 계획 비용 전에 잡는다.
  //    분리 실행이면 양쪽 다 본다. 실행 턴에 가서야 인증 실패를 발견하면 계획 비용이 날아간다
  for (const adapter of split ? [opts.adapter, execAdapter] : [opts.adapter]) {
    if (!adapter.preflight) continue
    const pre = await adapter.preflight()
    if (!pre.ok)
      return {
        status: 'agent-error',
        attempts: 0,
        rounds: [],
        runtime,
        usage,
        detail: `[${adapter.name}] ${pre.detail ?? '어댑터 사전점검 실패'}`,
      }
  }

  // 상한이 제 일을 하고 있는지는 실제로 돌려 봐야 안다 — 어댑터가 비용을 보고할지는
  // 계약이 아니라 관측이다. 그래서 매 검사마다 커버리지를 다시 보고, 말이 달라질 때만 알린다
  let coverageSaid: string | undefined
  /**
   * 지금까지의 지출을 저널에 적는다.
   *
   * 사용량 이벤트를 더하면 나오는 값이지만 따로 싣는 이유는, 소비자가 러너의 합산 규칙을
   * 다시 구현하게 만들면 그건 계약이 아니라 숙제이기 때문이다. 상한을 걸지 않은 실행에서도
   * 적는다 — 상한은 없어도 "얼마 쓰는 중인지"는 밖에서 보여야 한다.
   */
  const noteCost = () => {
    const spentUsd = reportedCost(usage, ran)
    opts.store.appendJournal({
      type: 'cost-updated',
      plan: usage.plan,
      exec: usage.exec,
      ...(spentUsd === undefined ? {} : { spentUsd }),
      coverage: costCoverage(usage, ran),
    })
  }

  // 1. PLAN — 에이전트는 계획과 게이트를 제안할 뿐, 판정하지 않는다.
  //    재개는 이 턴을 통째로 건너뛴다: 계획은 이미 있고 사람이 이미 승인했다.
  //    다시 계획하면 돈이 두 번 들 뿐 아니라 **승인받은 것과 다른 계획으로 이어가게 된다**
  let planText: string
  let planSessionId: string | undefined
  const shared = opts.sharedPlan
  if (shared) {
    // 계획 턴을 돌리지 않았으므로 usage도 세션도 없다 — 없는 것을 있다고 적지 않는다.
    // plan-finished는 남긴다: 재생하는 쪽에서 "계획 단계가 끝났다"는 사실은 같기 때문이다
    planText = shared.text
    opts.store.writePlan(shared.text)
    opts.store.appendJournal({ type: 'plan-finished', ok: true })
  } else if (resumed) {
    planText = resumed.planText
    planSessionId = resumed.sessionId
    opts.log(
      `재개: 완료된 라운드 ${resumed.rounds.length}개를 이어받아 라운드 ${resumed.startRound}부터 돕니다`,
    )
  } else {
    opts.log('계획 수립 중')
    const plan = await opts.adapter.run({ prompt: planPrompt(opts.intent), cwd: opts.cwd })
    ran.plan = true
    usage.plan = addUsage(usage.plan, plan.usage)
    for (const e of plan.events) opts.store.appendTranscript(e)
    opts.store.appendJournal({
      type: 'plan-finished',
      ok: plan.ok,
      ...(plan.usage === undefined ? {} : { usage: plan.usage }),
      ...(plan.sessionId === undefined ? {} : { sessionId: plan.sessionId }),
      // 실제로 돈 모델. run-started는 실행 **전에** 쓰이므로 지정값밖에 모른다 —
      // 이것을 안 싣으면 리포트는 아는데 저널은 모르는 상태가 된다
      ...(plan.model === undefined ? {} : { model: plan.model }),
    })
    noteCost()
    if (!plan.ok)
      return { status: 'agent-error', attempts: 0, rounds: [], runtime, usage, detail: plan.errorReason }
    opts.store.writePlan(plan.finalText)
    planText = plan.finalText
    planSessionId = plan.sessionId
    if (runtime) runtime.plan = withActualModel(runtime.plan, plan.model) ?? runtime.plan
  }

  /** 상한에 닿았으면 판정을 돌려준다. 상한이 없거나 여유가 있으면 undefined */
  const costStop = (): CostVerdict | undefined => {
    if (opts.maxCostUsd === undefined) return undefined
    const verdict = checkCost(usage, opts.maxCostUsd, ran)
    const warning = coverageWarning(verdict)
    if (warning && warning !== coverageSaid) {
      coverageSaid = warning
      opts.log(warning)
    }
    return verdict.exceeded ? verdict : undefined
  }
  /** 상한으로 멈출 때의 사유 한 줄. 무엇을 세어서 멈췄는지까지 적는다 */
  const costDetail = (v: CostVerdict): string =>
    `비용 상한 $${v.limitUsd}에 도달했습니다 (보고된 누적 $${(v.spentUsd ?? 0).toFixed(4)})` +
    (v.coverage === 'partial'
      ? ' — 이 금액은 지출의 일부입니다. 비용을 보고하지 않는 런타임이 섞여 실제 지출은 더 큽니다'
      : '')

  // 계획 턴만으로 상한에 닿을 수 있다 — 실측에서 계획이 $0.66~0.94를 썼고 조합에 따라 더 든다.
  // 여기서 멈추면 실행 턴을 한 번도 돌리지 않으므로 사람 승인을 구하지 않는다:
  // 승인은 "이 계획으로 진행할까"를 묻는 것인데 진행할 예산이 이미 없다
  const planStop = costStop()
  if (planStop)
    return {
      status: 'cost-exhausted',
      attempts: 0,
      rounds: [],
      runtime,
      usage,
      detail: `${costDetail(planStop)} — 계획 턴에서 이미 상한을 채워 실행에 들어가지 않았습니다`,
    }

  // 거부하더라도 일단 뽑는다 — 무엇을 거부했는지 남기려면 그것부터 알아야 한다
  const suggested = resumed || shared ? [] : (extractGates(planText) ?? [])
  if (opts.rejectSuggested) opts.log('제안 게이트를 받지 않습니다 — 사용자 게이트만 씁니다')
  // 게이트 타임아웃은 출처를 가리지 않고 걸린다. 제안 게이트만 무제한이면
  // 완료 기준을 에이전트가 정하면서 시간 한도까지 정하는 셈이 된다
  const withTimeout = (gate: Gate): Gate =>
    opts.gateTimeoutMs === undefined ? gate : { ...gate, timeoutMs: opts.gateTimeoutMs }
  const stallLimit = opts.stallLimit ?? DEFAULT_STALL_LIMIT
  const verifyRepeat = opts.verifyRepeat ?? DEFAULT_VERIFY_REPEAT
  // 감지가 이 조합에서 죽어 있으면 그 사실을 승인 전에 말한다. 사용자가 정한 조건을
  // 뒤에서 바꾸지 않는 대신, 조건이 뜻대로 작동하지 않는다는 것은 알려야 한다
  const stallDead = stallDetectionDead(stallLimit, opts.budget)
  if (stallDead)
    opts.log(
      `정체 감지가 이 조합에서는 작동하지 않습니다 — stall-limit ${stallLimit} >= budget ${opts.budget}. ` +
        `연속 ${stallLimit}라운드가 같아야 발동하는데 예산이 그 전에 끝납니다. ` +
        '예산을 늘리거나 --stall-limit을 낮추세요',
    )

  // 재개는 게이트를 다시 정하지 않는다 — 완료의 정의가 실행 도중에 바뀌면
  // 앞 라운드의 증거와 뒤 라운드의 증거가 서로 다른 기준을 본 것이 된다
  const merged = resumed
    ? { gates: resumed.gates, dropped: [] as DroppedGate[] }
    : shared
      ? { gates: shared.gates, dropped: shared.dropped ?? [] }
      : mergeGates(opts.userGates, suggested, { reject: opts.rejectSuggested })
  const dropped = merged.dropped
  const gates = merged.gates.map(withTimeout)
  if (gates.length === 0)
    return { status: 'no-gates', attempts: 0, rounds: [], runtime, usage, dropped, stallDead }

  // 재개는 승인을 다시 묻지 않는다 — **다시 묻는 것은 이어가는 것이 아니라 새 실행이다.**
  // 사전점검도 건너뛴다: 그 검사의 값은 "계획 비용을 날리기 전에 잡는 것"인데
  // 재개에는 계획 비용이 없고, 실행 불가한 게이트는 어차피 env-error로 정직하게 끝난다
  if (shared) {
    // 승인은 race 단계에서 사람이 한 번 했다. 각 조의 저널에도 그 사실이 남아야
    // 저널만으로 재생하는 쪽이 "승인 없이 돌았다"고 읽지 않는다
    opts.store.appendJournal({
      type: 'approval-requested',
      gates,
      warnings: [],
      ...(dropped.length > 0 ? { dropped } : {}),
    })
    opts.store.appendJournal({ type: 'approval-resolved', action: 'approve' })
  } else if (!resumed) {
    // 게이트가 이 환경에서 실행 가능한지만 본다. 통과/불통과 판정은 하지 않는다
    const warnings = [
      ...(await preflightGates(gates, { cwd: opts.cwd })),
      ...dropped.map(droppedWarning),
    ]
    for (const w of warnings) opts.log(`게이트 경고 [${w.gate}] ${w.reason}`)

    opts.store.appendJournal({
      type: 'approval-requested',
      gates,
      warnings: warnings.map(w => ({ gate: w.gate, cmd: w.cmd, reason: w.reason, kind: w.kind })),
      ...(dropped.length > 0 ? { dropped } : {}),
    })
    const decision = await opts.approve(planText, gates, warnings)
    opts.store.appendJournal({
      type: 'approval-resolved',
      action: decision.action,
      ...(decision.action === 'abort' && decision.reason !== undefined
        ? { reason: decision.reason }
        : {}),
    })
    if (decision.action === 'abort')
      return { status: 'aborted', attempts: 0, rounds: [], runtime, usage, dropped, stallDead, detail: decision.reason }
  }

  if (!resumed) opts.store.writeGoal({
    intent: opts.intent,
    gates,
    budget: opts.budget,
    runtime,
    droppedGates: dropped.length > 0 ? dropped : undefined,
    loop: {
      stallLimit,
      verifyRepeat,
      rejectSuggested: opts.rejectSuggested ?? false,
      profile: opts.profile,
    },
  })

  // 2~4. EXECUTE → VERIFY → 실패 증거와 함께 재시도
  const rounds: Round[] = resumed ? [...resumed.rounds] : []
  // 계획 세션은 계획 어댑터의 것이다 — 다른 런타임이 이어받을 수 없으므로 분리 실행이면 버린다.
  // 계획 내용 자체는 executePrompt에 통째로 들어가므로 맥락은 잃지 않는다
  let sessionId = resumed ? resumed.sessionId : split ? undefined : planSessionId
  // 이어받은 실행도 앞 라운드가 왜 실패했는지를 알아야 한다. 없으면 재개된 턴은 실패 증거 없이
  // 처음부터 다시 생각하게 되고, 재시도의 값(실패를 보고 고친다)이 사라진다
  let feedback = resumed ? resumeFeedback(rounds) : undefined

  for (let attempt = resumed ? resumed.startRound : 1; attempt <= opts.budget; attempt++) {
    // 라운드를 시작하기 전에 본다. 예산은 남았어도 돈이 없으면 그 라운드는 시작하지 않는다 —
    // 여기까지의 작업물은 워킹트리와 증거에 그대로 남으므로, 사람이 이어서 하거나
    // 상한을 올려 다시 돌릴 수 있다
    const stop = costStop()
    if (stop)
      return {
        status: 'cost-exhausted',
        attempts: attempt - 1,
        rounds,
        runtime,
        usage,
        dropped,
        stallDead,
        detail: `${costDetail(stop)} — 예산 ${opts.budget}라운드 중 ${attempt - 1}라운드를 돌고 멈췄습니다`,
      }
    opts.store.appendJournal({ type: 'round-started', round: attempt })
    opts.log(`시도 ${attempt}/${opts.budget}: 실행 중`)
    // 자기 확인용으로 여는 것은 **승인된 게이트의 명령뿐**이다. 제안 게이트도 승인을
    // 거쳤으므로 포함된다 — 승인되지 않은 것은 애초에 gates에 없다
    const selfCheck = opts.execShell === false ? undefined : gates.map(g => g.cmd)
    // **열 수 있는 것과 없는 것을 사전에 가른다.** 어댑터가 답하지 않으면 전부 열린다고 본다.
    // 실측에서 승인된 게이트 둘이 형태 때문에 거부됐는데(`!` 접두 · `$(…)`), 프롬프트는
    // 그것을 "정확히 베껴 쓰라"고 말하고 있었다 — 안내문이 거짓말이 된 자리다
    const open = selfCheck ? (execAdapter.openableCommands?.(selfCheck) ?? selfCheck) : []
    const closed = (selfCheck ?? []).filter(c => !open.includes(c.trim()))
    // 열어 놓고 말을 안 하면 에이전트는 계획서에 적힌 판을 베끼고, 그것이 원본과 다르면
    // 조용히 거부된다 — 실측에서 따옴표 하나로 13번이 전부 막혔다
    const prompt = executePrompt(planText, feedback, open, closed)
    let exec = await execAdapter.run({
      prompt, cwd: opts.cwd, resumeSessionId: sessionId, allowedCommands: selfCheck,
    })
    ran.exec = true
    usage.exec = addUsage(usage.exec, exec.usage)
    sessionId = exec.sessionId ?? sessionId
    for (const e of exec.events) opts.store.appendTranscript(e)

    // 크래시 복구(설계 §7): 이어갈 세션이 있으면 --resume으로 한 번만 다시 시도한다.
    // 재시도 예산은 게이트 불통과를 위한 것이므로 여기서 소모하지 않는다
    if (!exec.ok && sessionId) {
      opts.log('에이전트 실패 — 세션 복구 시도')
      exec = await execAdapter.run({
        prompt, cwd: opts.cwd, resumeSessionId: sessionId, allowedCommands: selfCheck,
      })
      usage.exec = addUsage(usage.exec, exec.usage)
      sessionId = exec.sessionId ?? sessionId
      for (const e of exec.events) opts.store.appendTranscript(e)
    }

    if (runtime) runtime.exec = withActualModel(runtime.exec, exec.model) ?? runtime.exec

    // 게이트를 돌리기 전에 적는다 — 검증 도중 죽어도 실행 턴의 지출과 세션은 이미 생겼고,
    // 라운드 단위로만 남기면 재개할 때 그 둘이 사라져 상한이 거짓말을 한다
    opts.store.appendJournal({
      type: 'exec-finished',
      round: attempt,
      ok: exec.ok,
      ...(exec.usage === undefined ? {} : { usage: exec.usage }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(exec.model === undefined ? {} : { model: exec.model }),
      ...(exec.selfChecks === undefined ? {} : { selfChecks: exec.selfChecks }),
    })
    noteCost()

    if (!exec.ok)
      return {
        status: 'agent-error', attempts: attempt, rounds, runtime, usage, dropped, stallDead, detail: exec.errorReason,
      }

    // 게이트를 돌리기 직전의 상태를 한 번 찍어 그 라운드의 모든 증거에 결박한다.
    // 게이트마다 다시 찍으면 포매터처럼 파일을 건드리는 게이트 때문에 같은 라운드 안에서도
    // 리비전이 갈리고, "이 증거들이 같은 상태를 봤다"는 주장이 깨진다
    const { diff, ...revision } = await captureRevision(opts.cwd)
    if (revision.tracked) opts.store.writeRoundDiff(attempt, diff)

    opts.log('검증 게이트 실행 중')
    const evidence: Evidence[] = []
    for (const gate of gates) {
      // 결과 전에 시작을 적는다 — 30분짜리 게이트가 도는 동안 밖에서 볼 수 있는 것이 이것뿐이다
      opts.store.appendJournal({
        type: 'gate-started', round: attempt, phase: 'verify', gate: gate.name, cmd: gate.cmd,
      })
      const one = await runGate(gate, { cwd: opts.cwd, revision })
      evidence.push(one)
      // 게이트 하나가 끝날 때마다 적는다. 라운드 끝에 몰아 쓰면 30분짜리 게이트를 도는 동안
      // 밖에서는 러너가 멈춘 것과 구분되지 않는다
      opts.store.appendJournal({ type: 'gate-result', round: attempt, phase: 'verify', evidence: one })
    }

    const signature = roundSignature(revision, evidence)
    const round: Round = { round: attempt, revision, evidence, repeatOf: repeatOf(rounds, signature) }
    rounds.push(round)
    opts.store.writeEvidence(rounds)
    opts.store.appendJournal({
      type: 'round-finished',
      round: attempt,
      revision,
      ...(round.repeatOf === undefined ? {} : { repeatOf: round.repeatOf }),
      allPass: evidence.every(e => e.outcome === 'pass'),
    })
    if (round.repeatOf !== undefined)
      opts.log(`라운드 ${attempt}: 변경분과 게이트 결과가 라운드 ${round.repeatOf}과 동일`)

    if (opts.afterRound)
      try {
        await opts.afterRound(round)
      } catch (err) {
        opts.log(`라운드 후처리 실패: ${err instanceof Error ? err.message : err}`)
      }

    const broken = evidence.filter(e => e.outcome === 'error')
    if (broken.length > 0)
      return {
        status: 'env-error',
        attempts: attempt,
        rounds,
        runtime,
        usage,
        dropped,
        stallDead,
        detail: broken.map(e => `[${e.gate}] ${e.cmd} → exit ${e.exitCode}`).join('; '),
      }
    if (evidence.every(e => e.outcome === 'pass')) {
      // 전부 통과했다 — 선언하기 전에 재현부터 확인한다. 한 번 통과한 게이트는
      // "통과했다"만 말할 뿐 "다시 해도 통과한다"는 말은 하지 않는다
      if (verifyRepeat > 1) {
        opts.log(`통과 재확인 중 (총 ${verifyRepeat}회)`)
        const recheck = await recheckGates(gates, verifyRepeat, async gate => {
          opts.store.appendJournal({
            type: 'gate-started', round: attempt, phase: 'recheck', gate: gate.name, cmd: gate.cmd,
          })
          const one = await runGate(gate, { cwd: opts.cwd, revision })
          opts.store.appendJournal({
            type: 'gate-result',
            round: attempt,
            phase: 'recheck',
            evidence: one,
          })
          return one
        })
        round.recheck = recheck.evidence
        if (recheck.unreproduced.length > 0) round.unreproduced = recheck.unreproduced
        // 결과가 갈리지 않았더라도 재확인이 실제로 다시 돌았는지는 별개 질문이다.
        // 명령어 문자열을 보는 사전 휴리스틱은 실측에서 오탐만 냈다. 캐시로 스킵됐는지는
        // 실제로 얼마나 걸렸는지로 판단한다
        // 콜드 컴파일이 첫 회에만 얹히는 것은 라운드 1뿐이다
        const coldFirstRun = opts.coldWorkspace === true && attempt === 1
        const suspects = recheckSuspects(evidence, recheck.evidence, { coldFirstRun })
        // 축을 껐다면 그 사실을 남긴다. 삼킨 게 없어도 남기는 이유는
        // `suppressedByCold`의 주석에 있다 — 경고 0건의 뜻이 저널에서 갈려야 한다
        if (coldFirstRun)
          opts.store.appendJournal({
            type: 'recheck-suppressed',
            round: attempt,
            cause: 'cold-first-run',
            suppressed: suppressedByCold(evidence, recheck.evidence),
          })
        if (suspects.length > 0) {
          round.recheckSuspects = suspects
          for (const s of suspects)
            opts.log(
              s.reason === 'clean-too-fast'
                ? `재확인 경고 [${s.gate}] 청소를 명시한 명령이 첫 회부터 ${s.firstMs}ms에 끝났습니다` +
                  ' — 시험이 한 번도 돌지 않은 초록일 수 있습니다(대상 저장소의 빌드 캐시를 보세요)'
                : `재확인 경고 [${s.gate}] 첫 회 ${s.firstMs}ms → 재확인 ${s.recheckMs}ms` +
                  ' — 두 번째 실행이 같은 일을 하지 않았을 수 있습니다',
            )
        }
        opts.store.writeEvidence(rounds)
        if (recheck.unreproduced.length > 0)
          return {
            status: 'unreproduced-pass',
            attempts: attempt,
            rounds,
            runtime,
            usage,
            dropped,
            stallDead,
            detail:
              `통과가 재현되지 않은 게이트: ${recheck.unreproduced.join(', ')}` +
              ' — 첫 회는 통과했으나 다시 돌리자 같은 결과가 나오지 않아 완료로 보지 않습니다',
          }
      }
      return { status: 'success', attempts: attempt, rounds, runtime, usage, dropped, stallDead }
    }

    // 같은 자리를 도는 중이면 남은 예산을 태우지 않는다. 예산은 진전을 사는 값이지
    // 같은 실패를 다시 확인하는 값이 아니다
    if (shouldStop(rounds, stallLimit))
      return {
        status: 'no-progress',
        attempts: attempt,
        rounds,
        runtime,
        usage,
        dropped,
        stallDead,
        detail: `${stallLimit}라운드 연속으로 변경분과 게이트 결과가 동일합니다 (diff ${revision.diffHash})`,
      }

    feedback = failureSummary(evidence, round.repeatOf !== undefined)
  }
  return {
    status: 'budget-exhausted',
    attempts: opts.budget,
    rounds,
    runtime,
    usage,
    dropped,
    stallDead,
    detail: userGateSummary(rounds),
  }
}
