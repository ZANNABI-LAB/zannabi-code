import { addUsage, emptyUsage, type AgentAdapter, type Usage } from './adapter'
import type { Gate, Evidence, Round } from './goal'
import { extractGates } from './goal'
import { runGate, preflightGates, type GateWarning } from './gates'
import { planPrompt, executePrompt, failureSummary } from './prompts'
import { captureRevision } from './revision'
import { roundSignature, repeatOf, shouldStop, DEFAULT_STALL_LIMIT } from './progress'
import { recheckGates, DEFAULT_VERIFY_REPEAT } from './flaky'
import type { RunStore } from './store'

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
}

export interface RuntimeLabels {
  plan: string
  exec: string
}

export interface LoopResult {
  status:
    | 'success'
    | 'budget-exhausted'
    | 'aborted'
    | 'env-error'
    | 'agent-error'
    | 'no-gates'
    | 'no-progress'
    | 'flaky-gate'
  attempts: number
  /** 라운드별 기록. 각 라운드가 어떤 리비전을 검사했고 앞 라운드의 반복인지까지 담는다 */
  rounds: Round[]
  /** 계획 턴과 실행 턴이 각각 쓴 자원. Phase 4 라우팅이 딛고 설 유일한 실측 축이다 */
  usage?: { plan: Usage; exec: Usage }
  /** 실패 사유 한 줄. report.md에 실려 transcript를 뒤지지 않아도 되게 한다 */
  detail?: string
  /** 어떤 조합으로 돌았는지 — 가설 측정의 기본 축이라 결과에 함께 남긴다 */
  runtime?: RuntimeLabels
}

/**
 * 마지막 라운드에서 사용자 게이트와 제안 게이트가 각각 어떻게 끝났는지.
 *
 * 예산 소진은 "아무것도 안 됐다"처럼 읽히지만, 실제로는 완료 기준(사용자 게이트)을 전부
 * 통과하고 에이전트가 스스로 건 게이트에서만 막힌 실행이 있었다. 그 차이를 사유 한 줄에 담는다.
 */
export function userGateSummary(rounds: Round[]): string | undefined {
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

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const execAdapter = opts.execAdapter ?? opts.adapter
  const split = execAdapter !== opts.adapter
  const runtime = opts.runtime
  // 계획과 실행을 나눠 센다 — "강한 계획 + 약한 실행"의 값을 재려면 두 축이 분리돼야 한다
  const usage = { plan: emptyUsage(), exec: emptyUsage() }

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

  // 1. PLAN — 에이전트는 계획과 게이트를 제안할 뿐, 판정하지 않는다
  opts.log('계획 수립 중')
  const plan = await opts.adapter.run({ prompt: planPrompt(opts.intent), cwd: opts.cwd })
  usage.plan = addUsage(usage.plan, plan.usage)
  for (const e of plan.events) opts.store.appendTranscript(e)
  if (!plan.ok)
    return { status: 'agent-error', attempts: 0, rounds: [], runtime, usage, detail: plan.errorReason }
  opts.store.writePlan(plan.finalText)

  const suggested = opts.rejectSuggested ? [] : (extractGates(plan.finalText) ?? [])
  if (opts.rejectSuggested) opts.log('제안 게이트를 받지 않습니다 — 사용자 게이트만 씁니다')
  // 게이트 타임아웃은 출처를 가리지 않고 걸린다. 제안 게이트만 무제한이면
  // 완료 기준을 에이전트가 정하면서 시간 한도까지 정하는 셈이 된다
  const withTimeout = (gate: Gate): Gate =>
    opts.gateTimeoutMs === undefined ? gate : { ...gate, timeoutMs: opts.gateTimeoutMs }
  const stallLimit = opts.stallLimit ?? DEFAULT_STALL_LIMIT
  const verifyRepeat = opts.verifyRepeat ?? DEFAULT_VERIFY_REPEAT
  const gates = [
    ...opts.userGates,
    ...suggested.filter(s => !opts.userGates.some(u => u.name === s.name)),
  ].map(withTimeout)
  if (gates.length === 0) return { status: 'no-gates', attempts: 0, rounds: [], runtime, usage }

  // 게이트가 이 환경에서 실행 가능한지만 본다. 통과/불통과 판정은 하지 않는다
  const warnings = await preflightGates(gates, { cwd: opts.cwd })
  for (const w of warnings) opts.log(`게이트 경고 [${w.gate}] ${w.reason}`)

  const decision = await opts.approve(plan.finalText, gates, warnings)
  if (decision.action === 'abort')
    return { status: 'aborted', attempts: 0, rounds: [], runtime, usage, detail: decision.reason }

  opts.store.writeGoal({
    intent: opts.intent,
    gates,
    budget: opts.budget,
    runtime,
    loop: { stallLimit, verifyRepeat, rejectSuggested: opts.rejectSuggested ?? false },
  })

  // 2~4. EXECUTE → VERIFY → 실패 증거와 함께 재시도
  const rounds: Round[] = []
  // 계획 세션은 계획 어댑터의 것이다 — 다른 런타임이 이어받을 수 없으므로 분리 실행이면 버린다.
  // 계획 내용 자체는 executePrompt에 통째로 들어가므로 맥락은 잃지 않는다
  let sessionId = split ? undefined : plan.sessionId
  let feedback: string | undefined

  for (let attempt = 1; attempt <= opts.budget; attempt++) {
    opts.log(`시도 ${attempt}/${opts.budget}: 실행 중`)
    const prompt = executePrompt(plan.finalText, feedback)
    let exec = await execAdapter.run({ prompt, cwd: opts.cwd, resumeSessionId: sessionId })
    usage.exec = addUsage(usage.exec, exec.usage)
    sessionId = exec.sessionId ?? sessionId
    for (const e of exec.events) opts.store.appendTranscript(e)

    // 크래시 복구(설계 §7): 이어갈 세션이 있으면 --resume으로 한 번만 다시 시도한다.
    // 재시도 예산은 게이트 불통과를 위한 것이므로 여기서 소모하지 않는다
    if (!exec.ok && sessionId) {
      opts.log('에이전트 실패 — 세션 복구 시도')
      exec = await execAdapter.run({ prompt, cwd: opts.cwd, resumeSessionId: sessionId })
      usage.exec = addUsage(usage.exec, exec.usage)
      sessionId = exec.sessionId ?? sessionId
      for (const e of exec.events) opts.store.appendTranscript(e)
    }

    if (!exec.ok)
      return {
        status: 'agent-error', attempts: attempt, rounds, runtime, usage, detail: exec.errorReason,
      }

    // 게이트를 돌리기 직전의 상태를 한 번 찍어 그 라운드의 모든 증거에 결박한다.
    // 게이트마다 다시 찍으면 포매터처럼 파일을 건드리는 게이트 때문에 같은 라운드 안에서도
    // 리비전이 갈리고, "이 증거들이 같은 상태를 봤다"는 주장이 깨진다
    const { diff, ...revision } = await captureRevision(opts.cwd)
    if (revision.tracked) opts.store.writeRoundDiff(attempt, diff)

    opts.log('검증 게이트 실행 중')
    const evidence: Evidence[] = []
    for (const gate of gates) evidence.push(await runGate(gate, { cwd: opts.cwd, revision }))

    const signature = roundSignature(revision, evidence)
    const round: Round = { round: attempt, revision, evidence, repeatOf: repeatOf(rounds, signature) }
    rounds.push(round)
    opts.store.writeEvidence(rounds)
    if (round.repeatOf !== undefined)
      opts.log(`라운드 ${attempt}: 변경분과 게이트 결과가 라운드 ${round.repeatOf}과 동일`)

    const broken = evidence.filter(e => e.outcome === 'error')
    if (broken.length > 0)
      return {
        status: 'env-error',
        attempts: attempt,
        rounds,
        runtime,
        usage,
        detail: broken.map(e => `[${e.gate}] ${e.cmd} → exit ${e.exitCode}`).join('; '),
      }
    if (evidence.every(e => e.outcome === 'pass')) {
      // 전부 통과했다 — 선언하기 전에 재현부터 확인한다. 한 번 통과한 게이트는
      // "통과했다"만 말할 뿐 "다시 해도 통과한다"는 말은 하지 않는다
      if (verifyRepeat > 1) {
        opts.log(`통과 재확인 중 (총 ${verifyRepeat}회)`)
        const recheck = await recheckGates(gates, verifyRepeat, gate =>
          runGate(gate, { cwd: opts.cwd, revision }),
        )
        round.recheck = recheck.evidence
        if (recheck.flaky.length > 0) round.flaky = recheck.flaky
        opts.store.writeEvidence(rounds)
        if (recheck.flaky.length > 0)
          return {
            status: 'flaky-gate',
            attempts: attempt,
            rounds,
            runtime,
            usage,
            detail:
              `재확인에서 결과가 갈린 게이트: ${recheck.flaky.join(', ')}` +
              ' — 통과가 재현되지 않아 완료로 보지 않습니다',
          }
      }
      return { status: 'success', attempts: attempt, rounds, runtime, usage }
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
        detail: `${stallLimit}라운드 연속으로 변경분과 게이트 결과가 동일합니다 (diff ${revision.diffHash})`,
      }

    feedback = failureSummary(evidence, round.repeatOf !== undefined)
  }
  return { status: 'budget-exhausted', attempts: opts.budget, rounds, runtime, usage, detail: userGateSummary(rounds) }
}
