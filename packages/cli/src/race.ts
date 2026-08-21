/**
 * `zannabi race` — 같은 작업을 여러 조합으로 동시에 돌리고 게이트로 고른다.
 *
 * 흐름이 `run`과 다른 지점은 하나다: **계획을 한 번만 세우고 모든 조가 공유한다.**
 * 조마다 계획까지 다르면 무엇 때문에 이겼는지 알 수 없고, 계획 비용을 N번 내며,
 * 승인이 N번 뜨는 도구는 쓸 수 없다.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RunStore, runLoop, planPrompt, extractGates, mergeGates, preflightGates,
  createWorktree, removeWorktree, commitRound, commitCount, branchDiff,
  summarizeRace, runConcurrent,
  type Gate, type GateWarning, type AgentAdapter, type ApprovalDecision,
  type RaceArm, type ArmOutcome, type RaceSummary, type Round,
} from '@zannabi-lab/core'

export interface RaceOptions {
  intent: string
  cwd: string
  arms: RaceArm[]
  userGates: Gate[]
  budget: number
  maxCostUsd?: number
  gateTimeoutMs?: number
  verifyRepeat?: number
  stallLimit?: number
  rejectSuggested?: boolean
  concurrency: number
  /** 계획 턴을 돌릴 런타임. 조들은 실행 턴만 가른다 */
  planAdapter: AgentAdapter
  planLabel: string
  /** 조 하나의 실행 어댑터를 만든다 */
  adapterFor(arm: RaceArm): AgentAdapter
  approve(plan: string, gates: Gate[], warnings: GateWarning[]): Promise<ApprovalDecision>
  log(message: string): void
}

export const RACES_DIR = join('.zannabi', 'races')

export async function runRace(opts: RaceOptions): Promise<RaceSummary | undefined> {
  const started = new Date()
  const raceId = `${started.toISOString().replace(/[:.]/g, '-')}-race`

  // 1. 계획 — 한 번만. 이 턴의 비용도 한 번만 든다
  opts.log(`계획 수립 중 (${opts.planLabel}) — 조 ${opts.arms.length}개가 이 계획을 공유합니다`)
  const plan = await opts.planAdapter.run({ prompt: planPrompt(opts.intent), cwd: opts.cwd })
  if (!plan.ok) {
    opts.log(`계획 실패: ${plan.errorReason ?? '알 수 없음'}`)
    return undefined
  }

  const suggested = opts.rejectSuggested ? [] : (extractGates(plan.finalText) ?? [])
  const merged = mergeGates(opts.userGates, suggested, { reject: opts.rejectSuggested })
  const gates = merged.gates.map(g =>
    opts.gateTimeoutMs === undefined ? g : { ...g, timeoutMs: opts.gateTimeoutMs },
  )
  if (gates.length === 0) {
    opts.log('게이트가 없어 실행을 거부했습니다')
    return undefined
  }

  // 2. 승인 — 한 번만. 조가 셋이라고 사람에게 세 번 묻지 않는다
  const warnings = await preflightGates(gates, { cwd: opts.cwd })
  const decision = await opts.approve(plan.finalText, gates, warnings)
  if (decision.action === 'abort') {
    opts.log(`중단: ${decision.reason ?? '승인하지 않음'}`)
    return undefined
  }

  // 3. 조마다 워크트리 하나. 격리 없이는 동시 실행 자체가 성립하지 않는다 —
  //    워킹트리를 공유하면 조들이 서로의 변경을 자기 것으로 본다
  const outcomes: ArmOutcome[] = []
  const jobs = opts.arms.map((arm, index) => async (): Promise<ArmOutcome> => {
    const store = new RunStore(opts.cwd, `${opts.intent}-${arm.name}`, new Date(started.getTime() + index))
    const worktree = await createWorktree(opts.cwd, store.runId)
    opts.log(`[${arm.name}] 시작 — ${worktree.branch}`)
    const armStarted = Date.now()

    const result = await runLoop({
      intent: opts.intent,
      userGates: opts.userGates,
      budget: opts.budget,
      ...(opts.maxCostUsd === undefined ? {} : { maxCostUsd: opts.maxCostUsd }),
      cwd: worktree.path,
      adapter: opts.adapterFor(arm),
      runtime: { plan: opts.planLabel, exec: arm.name },
      ...(opts.stallLimit === undefined ? {} : { stallLimit: opts.stallLimit }),
      ...(opts.verifyRepeat === undefined ? {} : { verifyRepeat: opts.verifyRepeat }),
      ...(opts.gateTimeoutMs === undefined ? {} : { gateTimeoutMs: opts.gateTimeoutMs }),
      store,
      sharedPlan: { text: plan.finalText, gates },
      raceId,
      coldWorkspace: true, // 조마다 새 워크트리다
      approve: async () => ({ action: 'approve' }),
      log: message => opts.log(`[${arm.name}] ${message}`),
      afterRound: async (round: Round) => {
        const pass = round.evidence.filter(e => e.outcome === 'pass').length
        await commitRound(worktree.path, round.round, `게이트 ${pass}/${round.evidence.length} 통과`)
      },
    })

    const elapsedMs = Date.now() - armStarted
    const commits = await commitCount(opts.cwd, worktree)
    const diff = await branchDiff(opts.cwd, worktree)
    if (diff) store.writeDiff(diff)
    await removeWorktree(opts.cwd, worktree)
    opts.log(`[${arm.name}] ${result.status} · ${result.attempts}R · ${(elapsedMs / 1000).toFixed(1)}s`)

    return { arm, runId: store.runId, result, elapsedMs, branch: worktree.branch, commits }
  })

  outcomes.push(...(await runConcurrent(jobs, opts.concurrency)))

  // 계획 턴은 조가 아니라 race가 한 번 낸다 — 그 비용이 총액에서 빠지면 집계가 거짓이 된다
  const summary = summarizeRace(raceId, opts.intent, outcomes, plan.usage?.costUsd)
  const dir = join(opts.cwd, RACES_DIR, raceId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(dir, 'summary.md'), renderRace(summary))
  return summary
}

/** 사람이 읽는 집계. 비교할 수 없는 축은 비교하지 않는다 */
export function renderRace(summary: RaceSummary): string {
  const lines: string[] = [`# race — ${summary.intent}`, '']
  lines.push(`조 ${summary.arms.length}개 · 통과 ${summary.passed.length}개`, '')
  lines.push('| 조 | 판정 | 라운드 | 실행 비용 | 시간 | 커밋 | 브랜치 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const o of summary.arms) {
    const mark = o.result.status === 'success' ? '✅' : '❌'
    // 미보고는 0이 아니라 `-`다. 0으로 적으면 공짜라는 거짓이 된다
    const cost = o.result.usage?.exec.costUsd
    lines.push(
      `| ${o.arm.name} | ${mark} ${o.result.status} | ${o.result.attempts} | ` +
        `${cost === undefined ? '-' : '$' + cost.toFixed(4)} | ${(o.elapsedMs / 1000).toFixed(1)}s | ` +
        `${o.commits ?? 0} | \`${o.branch ?? '-'}\` |`,
    )
  }
  lines.push('')
  const total =
    summary.totalCostUsd === undefined
      ? '보고되지 않음'
      : `$${summary.totalCostUsd.toFixed(4)} (${summary.costCoverage})`
  if (summary.planCostUsd !== undefined)
    lines.push(`**공유 계획 턴**: $${summary.planCostUsd.toFixed(4)} (조 수와 무관하게 한 번)`)
  lines.push(`**보고된 총 비용**: ${total}${summary.planCostUsd === undefined ? '' : ' — 계획 + 실행'}`)
  if (summary.costCoverage === 'partial')
    lines.push('', '> 일부 조가 비용을 보고하지 않아 합계는 지출의 일부입니다.')
  lines.push('', `**판정**: ${summary.verdict}`)
  if (summary.winner)
    lines.push('', `가져가려면: \`git merge ${summary.winner.branch}\``)
  for (const o of summary.failed)
    if (o.result.detail) lines.push('', `- ${o.arm.name} 실패 사유: ${o.result.detail}`)
  return lines.join('\n')
}
