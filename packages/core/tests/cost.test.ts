import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentResult, Usage } from '../src/adapter'
import { checkCost, costCoverage, reportedCost, coverageWarning } from '../src/cost'
import { runLoop, type LoopOptions } from '../src/loop'
import { RunStore } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'

const usage = (costUsd?: number, turns = 1): Usage => ({
  inputTokens: 10,
  outputTokens: 5,
  turns,
  ...(costUsd === undefined ? {} : { costUsd }),
})
const idle: Usage = { inputTokens: 0, outputTokens: 0, turns: 0 }

test('보고된 비용만 합산한다 — 미보고 축은 0이 아니라 없는 것이다', () => {
  expect(reportedCost({ plan: usage(1.5), exec: usage(0.5) })).toBe(2)
  expect(reportedCost({ plan: usage(1.5), exec: usage(undefined) })).toBe(1.5)
  expect(reportedCost({ plan: usage(undefined), exec: usage(undefined) })).toBeUndefined()
})

test('아직 돌지 않은 턴은 미보고가 아니라 해당 없음이다', () => {
  // 계획만 끝난 시점: exec은 아직 안 돌았을 뿐이므로 커버리지를 깎지 않는다
  expect(costCoverage({ plan: usage(0.9), exec: idle }, { plan: true, exec: false })).toBe('full')
})

test('사용량을 통째로 침묵한 축이 "안 돈 축"으로 위장되지 않는다', () => {
  // turns까지 0인데 실제로는 돌았다 — 이 구분을 놓치면 partial이 full로 보고된다
  const silent = { plan: usage(0.9), exec: idle }
  expect(costCoverage(silent)).toBe('full') // turns만 보면 속는다
  expect(costCoverage(silent, { plan: true, exec: true })).toBe('partial')
})

test('커버리지: 한 축이라도 침묵하면 partial, 전부 침묵이면 none', () => {
  expect(costCoverage({ plan: usage(0.9), exec: usage(0.1) })).toBe('full')
  expect(costCoverage({ plan: usage(0.9), exec: usage(undefined) })).toBe('partial')
  expect(costCoverage({ plan: usage(undefined), exec: usage(undefined) })).toBe('none')
})

test('한 턴도 돌지 않았으면 런타임에 대해 아무 말도 하지 않는다', () => {
  // 실측에서 사전점검이 죽은 실행이 "이 런타임은 비용을 보고하지 않는다"고 리포트했다 — 오보였다
  const verdict = checkCost({ plan: idle, exec: idle }, 1.5, { plan: false, exec: false })
  expect(verdict.coverage).toBe('not-run')
  expect(verdict.exceeded).toBe(false)
  expect(coverageWarning(verdict)).toBeUndefined()
})

test('돈을 쓴 턴이 있는데 아무도 보고하지 않은 것은 not-run과 다르다', () => {
  const verdict = checkCost({ plan: usage(undefined), exec: usage(undefined) }, 1.5, {
    plan: true, exec: true,
  })
  expect(verdict.coverage).toBe('none')
  expect(coverageWarning(verdict)).toContain('보고하지 않습니다')
})

test('상한은 "여기까지 써도 된다"가 아니라 "여기서 멈춘다"는 선이다 — 같으면 초과', () => {
  expect(checkCost({ plan: usage(2.99), exec: idle }, 3).exceeded).toBe(false)
  expect(checkCost({ plan: usage(3), exec: idle }, 3).exceeded).toBe(true)
})

test('미보고면 상한은 절대 걸리지 않는다 — 모른다는 것을 초과로 읽지 않는다', () => {
  const verdict = checkCost({ plan: usage(undefined), exec: usage(undefined) }, 0.01)
  expect(verdict.exceeded).toBe(false)
  expect(verdict.spentUsd).toBeUndefined()
  expect(coverageWarning(verdict)).toContain('보고하지 않습니다')
})

test('커버리지가 온전하면 할 말이 없다', () => {
  expect(coverageWarning(checkCost({ plan: usage(1), exec: usage(1) }, 5))).toBeUndefined()
})

// ---- 루프 통합 ----

const planText = (cmd: string) =>
  `계획: 한다.\n\`\`\`json\n{"gates":[{"name":"g","cmd":"${cmd}"}]}\n\`\`\``

function withUsage(result: AgentResult, u: Usage): AgentResult {
  return { ...result, usage: u }
}

function options(partial: Partial<LoopOptions> & { adapter: LoopOptions['adapter'] }): LoopOptions {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-cost-'))
  return {
    intent: '비용 상한 테스트',
    userGates: [],
    budget: 4,
    cwd,
    store: new RunStore(cwd, '비용 상한 테스트'),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
    ...partial,
  }
}

test('상한에 닿으면 예산이 남아도 다음 라운드를 시작하지 않는다', async () => {
  // 계획 $0.4 + 실행 $0.4씩. 상한 $1.0 → 2라운드까지 돌고(누적 $1.2) 3라운드는 시작 못 한다
  const adapter = new FakeAdapter([
    withUsage(fakeResult(planText('false')), usage(0.4)),
    withUsage(fakeResult('1'), usage(0.4)),
    withUsage(fakeResult('2'), usage(0.4)),
    withUsage(fakeResult('3'), usage(0.4)),
  ])
  const result = await runLoop(options({ adapter, budget: 4, maxCostUsd: 1.0 }))
  expect(result.status).toBe('cost-exhausted')
  expect(result.attempts).toBe(2) // 예산 4가 남았는데 돈으로 멈췄다
  expect(result.rounds).toHaveLength(2) // 여기까지의 증거는 남는다
  expect(result.cost?.exceeded).toBe(true)
  expect(result.cost?.coverage).toBe('full')
  expect(result.detail).toContain('비용 상한')
})

test('계획 턴만으로 상한을 채우면 승인도 실행도 없이 끝난다', async () => {
  let approved = false
  const adapter = new FakeAdapter([withUsage(fakeResult(planText('true')), usage(5))])
  const result = await runLoop(
    options({
      adapter,
      maxCostUsd: 3,
      approve: async () => {
        approved = true
        return { action: 'approve' }
      },
    }),
  )
  expect(result.status).toBe('cost-exhausted')
  expect(result.attempts).toBe(0)
  expect(approved).toBe(false) // 진행할 예산이 없는 계획에 승인을 묻지 않는다
  expect(result.detail).toContain('실행에 들어가지 않았습니다')
})

test('비용을 보고하지 않는 런타임에서는 상한이 걸리지 않고, 그 사실이 결과에 남는다', async () => {
  const said: string[] = []
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('1')])
  const result = await runLoop(
    options({ adapter, maxCostUsd: 0.0001, log: m => said.push(m) }),
  )
  expect(result.status).toBe('success') // 상한이 성공을 막지 못한다
  expect(result.cost?.coverage).toBe('none')
  expect(result.cost?.exceeded).toBe(false)
  expect(said.some(m => m.includes('보고하지 않습니다'))).toBe(true)
})

test('한쪽만 보고하면 partial로 남는다 — 상한 안이라는 말이 지출 전체를 뜻하지 않는다', async () => {
  const plan = new FakeAdapter([withUsage(fakeResult(planText('true')), usage(0.5))])
  const exec = new FakeAdapter([fakeResult('1')]) // 실행은 비용을 안 준다
  const result = await runLoop(options({ adapter: plan, execAdapter: exec, maxCostUsd: 10 }))
  expect(result.status).toBe('success')
  expect(result.cost?.coverage).toBe('partial')
  expect(result.cost?.spentUsd).toBe(0.5)
})

test('상한을 걸지 않으면 비용 판정 자체가 없다 — 안 물은 질문에 답하지 않는다', async () => {
  const adapter = new FakeAdapter([
    withUsage(fakeResult(planText('true')), usage(99)),
    withUsage(fakeResult('1'), usage(99)),
  ])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('success')
  expect(result.cost).toBeUndefined()
})
