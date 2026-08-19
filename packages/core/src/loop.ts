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
  adapter: AgentAdapter
  store: RunStore
  approve(plan: string, gates: Gate[], warnings: GateWarning[]): Promise<ApprovalDecision>
  log(message: string): void
}

export interface LoopResult {
  status: 'success' | 'budget-exhausted' | 'aborted' | 'env-error' | 'agent-error' | 'no-gates'
  attempts: number
  evidence: Evidence[][]
  /** 실패 사유 한 줄. report.md에 실려 transcript를 뒤지지 않아도 되게 한다 */
  detail?: string
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  // 0. 사전점검 — 인증 만료처럼 실행 전에 알 수 있는 실패를 계획 비용 전에 잡는다
  if (opts.adapter.preflight) {
    const pre = await opts.adapter.preflight()
    if (!pre.ok)
      return { status: 'agent-error', attempts: 0, evidence: [], detail: pre.detail ?? '어댑터 사전점검 실패' }
  }

  // 1. PLAN — 에이전트는 계획과 게이트를 제안할 뿐, 판정하지 않는다
  opts.log('계획 수립 중')
  const plan = await opts.adapter.run({ prompt: planPrompt(opts.intent), cwd: opts.cwd })
  for (const e of plan.events) opts.store.appendTranscript(e)
  if (!plan.ok)
    return { status: 'agent-error', attempts: 0, evidence: [], detail: plan.errorReason }
  opts.store.writePlan(plan.finalText)

  const suggested = extractGates(plan.finalText) ?? []
  const gates = [
    ...opts.userGates,
    ...suggested.filter(s => !opts.userGates.some(u => u.name === s.name)),
  ]
  if (gates.length === 0) return { status: 'no-gates', attempts: 0, evidence: [] }

  // 게이트가 이 환경에서 실행 가능한지만 본다. 통과/불통과 판정은 하지 않는다
  const warnings = await preflightGates(gates, { cwd: opts.cwd })
  for (const w of warnings) opts.log(`게이트 경고 [${w.gate}] ${w.reason}`)

  const decision = await opts.approve(plan.finalText, gates, warnings)
  if (decision.action === 'abort')
    return { status: 'aborted', attempts: 0, evidence: [], detail: decision.reason }

  opts.store.writeGoal({ intent: opts.intent, gates, budget: opts.budget })

  // 2~4. EXECUTE → VERIFY → 실패 증거와 함께 재시도
  const rounds: Evidence[][] = []
  let sessionId = plan.sessionId
  let feedback: string | undefined

  for (let attempt = 1; attempt <= opts.budget; attempt++) {
    opts.log(`시도 ${attempt}/${opts.budget}: 실행 중`)
    const exec = await opts.adapter.run({
      prompt: executePrompt(plan.finalText, feedback),
      cwd: opts.cwd,
      resumeSessionId: sessionId,
    })
    sessionId = exec.sessionId ?? sessionId
    for (const e of exec.events) opts.store.appendTranscript(e)
    if (!exec.ok)
      return { status: 'agent-error', attempts: attempt, evidence: rounds, detail: exec.errorReason }

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
        detail: broken.map(e => `[${e.gate}] ${e.cmd} → exit ${e.exitCode}`).join('; '),
      }
    if (evidence.every(e => e.outcome === 'pass'))
      return { status: 'success', attempts: attempt, evidence: rounds }
    feedback = failureSummary(evidence)
  }
  return { status: 'budget-exhausted', attempts: opts.budget, evidence: rounds }
}
