#!/usr/bin/env bun
// packages/cli/src/index.ts
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import {
  RunStore, runLoop, FakeAdapter, fakeResult, GateSchema,
  type Gate, type GateWarning, type AgentAdapter, type ApprovalDecision,
} from '@zannabi-lab/core'
import { ClaudeAdapter } from '@zannabi-lab/adapter-claude'
import { CodexAdapter } from '@zannabi-lab/adapter-codex'

const AGENTS = ['claude', 'codex'] as const
type AgentName = (typeof AGENTS)[number]

function parseGateFlag(value: string): Gate {
  const idx = value.indexOf(':')
  if (idx < 1) throw new Error(`--gate 형식은 "name:cmd" 입니다: ${value}`)
  return GateSchema.parse({ name: value.slice(0, idx), cmd: value.slice(idx + 1) })
}

interface RuntimeChoice {
  agent: AgentName
  model?: string
}

function pickAdapter({ agent, model }: RuntimeChoice): AgentAdapter {
  if (process.env.ZANNABI_ADAPTER === 'fake') {
    // E2E용: 계획(게이트 true 제안) + 실행 응답
    return new FakeAdapter([
      fakeResult('계획: 한다.\n```json\n{"gates":[{"name":"ok","cmd":"true"}]}\n```'),
      fakeResult('실행했습니다.'),
    ])
  }
  return agent === 'codex' ? new CodexAdapter({ model }) : new ClaudeAdapter({ model })
}

/** 증거에 남길 표기. 모델을 지정 안 했으면 CLI 기본값이라는 뜻으로 default를 적는다 */
function label({ agent, model }: RuntimeChoice): string {
  return `${agent}:${model ?? 'default'}`
}

function printPlan(plan: string, gates: Gate[], warnings: GateWarning[]) {
  console.log('\n===== 계획 =====\n')
  console.log(plan)
  console.log('\n===== 게이트 =====\n')
  for (const g of gates) console.log(`  - ${g.name}: ${g.cmd}`)
  if (warnings.length > 0) {
    console.log('\n===== 경고 =====\n')
    for (const w of warnings) console.log(`  ⚠️  ${w.gate}: ${w.reason}`)
  }
}

async function approveViaTerminal(
  plan: string, gates: Gate[], warnings: GateWarning[],
): Promise<ApprovalDecision> {
  printPlan(plan, gates, warnings)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('\n이 계획과 게이트로 진행할까요? [y/N] ')).trim().toLowerCase()
  rl.close()
  return answer === 'y' ? { action: 'approve' } : { action: 'abort', reason: '사람이 승인하지 않음' }
}

/**
 * --yes: 사람 승인을 건너뛴다. 대신 게이트 경고가 하나라도 있으면 거부한다 —
 * 사람이 안 보는 만큼 기계가 최소한의 검사를 대신한다.
 */
async function approveAutomatically(
  plan: string, gates: Gate[], warnings: GateWarning[],
): Promise<ApprovalDecision> {
  printPlan(plan, gates, warnings)
  if (warnings.length > 0)
    return {
      action: 'abort',
      reason: `--yes 모드에서 실행 불가한 게이트를 거부했습니다: ${warnings
        .map(w => `[${w.gate}] ${w.reason}`)
        .join('; ')}`,
    }
  console.log('\n[zannabi] --yes: 승인 없이 진행합니다.')
  return { action: 'approve' }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string', default: '.' },
      budget: { type: 'string', default: '3' },
      gate: { type: 'string', multiple: true, default: [] },
      model: { type: 'string' },
      agent: { type: 'string', default: 'claude' },
      'plan-agent': { type: 'string' },
      'plan-model': { type: 'string' },
      'exec-agent': { type: 'string' },
      'exec-model': { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
  })
  const [command, intent] = positionals
  if (command !== 'run' || !intent) {
    console.error(
      '사용법: zannabi run "<작업 설명>" [--cwd .] [--budget 3] [--gate "name:cmd"]' +
      ` [--agent ${AGENTS.join('|')}] [--model <이름>] [--yes]\n` +
      '  생성-검증 분리: [--plan-agent/--plan-model] [--exec-agent/--exec-model]',
    )
    process.exit(1)
  }

  // 사용자가 실제로 쓴 플래그를 짚어야 고칠 자리를 안다
  for (const flag of ['agent', 'plan-agent', 'exec-agent'] as const) {
    const given = values[flag]
    if (given === undefined || AGENTS.includes(given as AgentName)) continue
    console.error(`[zannabi] --${flag}는 ${AGENTS.join(' | ')} 중 하나여야 합니다: ${given}`)
    process.exit(1)
  }

  // --agent/--model이 기본값이고, plan/exec 쪽이 지정되면 그 턴만 덮어쓴다
  const plan: RuntimeChoice = {
    agent: (values['plan-agent'] ?? values.agent) as AgentName,
    model: values['plan-model'] ?? values.model,
  }
  const exec: RuntimeChoice = {
    agent: (values['exec-agent'] ?? values.agent) as AgentName,
    model: values['exec-model'] ?? values.model,
  }

  const budget = Number(values.budget)
  if (!Number.isInteger(budget) || budget < 1) {
    console.error(`[zannabi] --budget은 1 이상의 정수여야 합니다: ${values.budget}`)
    process.exit(1)
  }

  let userGates: Gate[]
  try {
    userGates = (values.gate as string[]).map(parseGateFlag)
  } catch (err) {
    console.error(`[zannabi] ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const cwd = resolve(values.cwd)
  const store = new RunStore(cwd, intent)
  const { buildReport, captureDiff } = await import('./report')

  const result = await runLoop({
    intent,
    userGates,
    budget,
    cwd,
    adapter: pickAdapter(plan),
    // 조합이 같으면 어댑터 하나만 쓴다 — 같은 런타임인데 세션이 끊기면 손해다
    execAdapter: label(plan) === label(exec) ? undefined : pickAdapter(exec),
    runtime: { plan: label(plan), exec: label(exec) },
    store,
    approve: values.yes ? approveAutomatically : approveViaTerminal,
    log: message => console.log(`[zannabi] ${message}`),
  })

  const diff = await captureDiff(cwd)
  if (diff) store.writeDiff(diff)
  const report = buildReport(result, intent)
  store.writeReport(report)

  console.log(`\n${report}\n`)
  console.log(`[zannabi] 증거: ${store.dir}`)
  if (result.status === 'no-gates')
    console.error('[zannabi] 게이트가 없어 실행을 거부했습니다. --gate "name:cmd"로 지정하세요.')
  if (result.status === 'env-error')
    console.error('[zannabi] 게이트 환경 오류 — 명령이 이 환경에서 실행 가능한지 확인하세요.')
  if (result.status === 'agent-error')
    console.error('[zannabi] 에이전트 실행 실패 — 아래 사유를 확인하세요.')
  if (result.detail) console.error(`[zannabi] 사유: ${result.detail}`)
  process.exit(result.status === 'success' ? 0 : 1)
}

main().catch(err => {
  // 처리되지 않은 예외가 조용한 비정상 종료로 새지 않게 한다
  console.error(`[zannabi] 예기치 못한 오류: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
  process.exit(1)
})
