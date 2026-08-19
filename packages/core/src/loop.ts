import type { AgentAdapter } from './adapter'
import type { Gate, Evidence } from './goal'
import { extractGates } from './goal'
import { runGate, preflightGates, type GateWarning } from './gates'
import { planPrompt, executePrompt, failureSummary } from './prompts'
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
}

export interface RuntimeLabels {
  plan: string
  exec: string
}

export interface LoopResult {
  status: 'success' | 'budget-exhausted' | 'aborted' | 'env-error' | 'agent-error' | 'no-gates'
  attempts: number
  evidence: Evidence[][]
  /** 실패 사유 한 줄. report.md에 실려 transcript를 뒤지지 않아도 되게 한다 */
  detail?: string
  /** 어떤 조합으로 돌았는지 — 가설 측정의 기본 축이라 결과에 함께 남긴다 */
  runtime?: RuntimeLabels
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const execAdapter = opts.execAdapter ?? opts.adapter
  const split = execAdapter !== opts.adapter
  const runtime = opts.runtime

  // 0. 사전점검 — 인증 만료처럼 실행 전에 알 수 있는 실패를 계획 비용 전에 잡는다.
  //    분리 실행이면 양쪽 다 본다. 실행 턴에 가서야 인증 실패를 발견하면 계획 비용이 날아간다
  for (const adapter of split ? [opts.adapter, execAdapter] : [opts.adapter]) {
    if (!adapter.preflight) continue
    const pre = await adapter.preflight()
    if (!pre.ok)
      return {
        status: 'agent-error',
        attempts: 0,
        evidence: [],
        runtime,
        detail: `[${adapter.name}] ${pre.detail ?? '어댑터 사전점검 실패'}`,
      }
  }

  // 1. PLAN — 에이전트는 계획과 게이트를 제안할 뿐, 판정하지 않는다
  opts.log('계획 수립 중')
  const plan = await opts.adapter.run({ prompt: planPrompt(opts.intent), cwd: opts.cwd })
  for (const e of plan.events) opts.store.appendTranscript(e)
  if (!plan.ok)
    return { status: 'agent-error', attempts: 0, evidence: [], runtime, detail: plan.errorReason }
  opts.store.writePlan(plan.finalText)

  const suggested = extractGates(plan.finalText) ?? []
  const gates = [
    ...opts.userGates,
    ...suggested.filter(s => !opts.userGates.some(u => u.name === s.name)),
  ]
  if (gates.length === 0) return { status: 'no-gates', attempts: 0, evidence: [], runtime }

  // 게이트가 이 환경에서 실행 가능한지만 본다. 통과/불통과 판정은 하지 않는다
  const warnings = await preflightGates(gates, { cwd: opts.cwd })
  for (const w of warnings) opts.log(`게이트 경고 [${w.gate}] ${w.reason}`)

  const decision = await opts.approve(plan.finalText, gates, warnings)
  if (decision.action === 'abort')
    return { status: 'aborted', attempts: 0, evidence: [], runtime, detail: decision.reason }

  opts.store.writeGoal({ intent: opts.intent, gates, budget: opts.budget, runtime })

  // 2~4. EXECUTE → VERIFY → 실패 증거와 함께 재시도
  const rounds: Evidence[][] = []
  // 계획 세션은 계획 어댑터의 것이다 — 다른 런타임이 이어받을 수 없으므로 분리 실행이면 버린다.
  // 계획 내용 자체는 executePrompt에 통째로 들어가므로 맥락은 잃지 않는다
  let sessionId = split ? undefined : plan.sessionId
  let feedback: string | undefined

  for (let attempt = 1; attempt <= opts.budget; attempt++) {
    opts.log(`시도 ${attempt}/${opts.budget}: 실행 중`)
    const prompt = executePrompt(plan.finalText, feedback)
    let exec = await execAdapter.run({ prompt, cwd: opts.cwd, resumeSessionId: sessionId })
    sessionId = exec.sessionId ?? sessionId
    for (const e of exec.events) opts.store.appendTranscript(e)

    // 크래시 복구(설계 §7): 이어갈 세션이 있으면 --resume으로 한 번만 다시 시도한다.
    // 재시도 예산은 게이트 불통과를 위한 것이므로 여기서 소모하지 않는다
    if (!exec.ok && sessionId) {
      opts.log('에이전트 실패 — 세션 복구 시도')
      exec = await execAdapter.run({ prompt, cwd: opts.cwd, resumeSessionId: sessionId })
      sessionId = exec.sessionId ?? sessionId
      for (const e of exec.events) opts.store.appendTranscript(e)
    }

    if (!exec.ok)
      return {
        status: 'agent-error', attempts: attempt, evidence: rounds, runtime, detail: exec.errorReason,
      }

    opts.log('검증 게이트 실행 중')
    const evidence: Evidence[] = []
    for (const gate of gates) evidence.push(await runGate(gate, { cwd: opts.cwd }))
    rounds.push(evidence)
    opts.store.writeEvidence(rounds)

    const broken = evidence.filter(e => e.outcome === 'error')
    if (broken.length > 0)
      return {
        status: 'env-error',
        attempts: attempt,
        evidence: rounds,
        runtime,
        detail: broken.map(e => `[${e.gate}] ${e.cmd} → exit ${e.exitCode}`).join('; '),
      }
    if (evidence.every(e => e.outcome === 'pass'))
      return { status: 'success', attempts: attempt, evidence: rounds, runtime }
    feedback = failureSummary(evidence)
  }
  return { status: 'budget-exhausted', attempts: opts.budget, evidence: rounds, runtime }
}
