#!/usr/bin/env bun
// packages/cli/src/index.ts
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import {
  RunStore, runLoop, FakeAdapter, fakeResult, GateSchema,
  type Gate, type AgentAdapter, type ApprovalDecision,
} from '@zannabi-lab/core'
import { ClaudeAdapter } from '@zannabi-lab/adapter-claude'

function parseGateFlag(value: string): Gate {
  const idx = value.indexOf(':')
  if (idx < 1) throw new Error(`--gate 형식은 "name:cmd" 입니다: ${value}`)
  return GateSchema.parse({ name: value.slice(0, idx), cmd: value.slice(idx + 1) })
}

function pickAdapter(): AgentAdapter {
  if (process.env.ZANNABI_ADAPTER === 'fake') {
    // E2E용: 계획(게이트 true 제안) + 실행 응답
    return new FakeAdapter([
      fakeResult('계획: 한다.\n```json\n{"gates":[{"name":"ok","cmd":"true"}]}\n```'),
      fakeResult('실행했습니다.'),
    ])
  }
  return new ClaudeAdapter()
}

async function approveViaTerminal(plan: string, gates: Gate[]): Promise<ApprovalDecision> {
  console.log('\n===== 계획 =====\n')
  console.log(plan)
  console.log('\n===== 게이트 =====\n')
  for (const g of gates) console.log(`  - ${g.name}: ${g.cmd}`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('\n이 계획과 게이트로 진행할까요? [y/N] ')).trim().toLowerCase()
  rl.close()
  return answer === 'y' ? { action: 'approve' } : { action: 'abort' }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string', default: '.' },
      budget: { type: 'string', default: '3' },
      gate: { type: 'string', multiple: true, default: [] },
    },
  })
  const [command, intent] = positionals
  if (command !== 'run' || !intent) {
    console.error('사용법: zannabi run "<작업 설명>" [--cwd .] [--budget 3] [--gate "name:cmd"]')
    process.exit(1)
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
    adapter: pickAdapter(),
    store,
    approve: approveViaTerminal,
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
    console.error('[zannabi] 에이전트 실행 실패 — claude 설치/로그인 상태와 transcript.jsonl의 stderr 이벤트를 확인하세요.')
  process.exit(result.status === 'success' ? 0 : 1)
}

main()
