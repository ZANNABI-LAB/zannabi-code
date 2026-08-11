import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentResult } from '../src/adapter'
import { runLoop, type LoopOptions } from '../src/loop'
import { RunStore } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'

const planText = (cmd: string) =>
  `계획: 한다.\n\`\`\`json\n{"gates":[{"name":"g","cmd":"${cmd}"}]}\n\`\`\``

function options(partial: Partial<LoopOptions> & { adapter: LoopOptions['adapter'] }): LoopOptions {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-loop-'))
  return {
    intent: '테스트 작업',
    userGates: [],
    budget: 3,
    cwd,
    store: new RunStore(cwd, '테스트 작업'),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
    ...partial,
  }
}

test('첫 시도에 게이트 통과 → success', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('success')
  expect(result.attempts).toBe(1)
  expect(result.evidence[0][0].outcome).toBe('pass')
})

test('실패 후 재시도에 실패 증거가 프롬프트로 전달되고, 2차 성공', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-retry-'))
  const marker = join(cwd, 'done.marker')
  const adapter = new FakeAdapter(
    [fakeResult(planText(`test -f ${marker}`)), fakeResult('1차'), fakeResult('2차')],
    (_req, i) => { if (i === 2) writeFileSync(marker, 'ok') }, // 2차 실행에서만 "고침"
  )
  const result = await runLoop(options({ adapter, cwd, store: new RunStore(cwd, 'retry') }))
  expect(result.status).toBe('success')
  expect(result.attempts).toBe(2)
  expect(adapter.requests[2].prompt).toContain('exit 1') // 실패 증거 포함
  expect(adapter.requests[2].resumeSessionId).toBe('s1') // 세션 이어가기
})

test('예산 소진 → budget-exhausted', async () => {
  const adapter = new FakeAdapter([
    fakeResult(planText('false')), fakeResult('1'), fakeResult('2'),
  ])
  const result = await runLoop(options({ adapter, budget: 2 }))
  expect(result.status).toBe('budget-exhausted')
  expect(result.attempts).toBe(2)
})

test('환경 오류 게이트 → 재시도 없이 env-error', async () => {
  const adapter = new FakeAdapter([
    fakeResult(planText('definitely-not-a-command-xyz')), fakeResult('1'),
  ])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('env-error')
  expect(result.attempts).toBe(1)
})

test('승인 거부 → aborted, 실행 안 함', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true'))])
  const result = await runLoop(options({ adapter, approve: async () => ({ action: 'abort' }) }))
  expect(result.status).toBe('aborted')
  expect(adapter.requests).toHaveLength(1) // PLAN만 호출됨
})

test('게이트 0개 → no-gates, 실행 거부', async () => {
  const adapter = new FakeAdapter([fakeResult('JSON 블록 없는 계획')])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('no-gates')
})

test('계획 단계 어댑터 실패 → env-error, 승인 호출 안 함', async () => {
  let approveCalled = false
  const adapter = new FakeAdapter([
    { ok: false, finalText: '', events: [] } as AgentResult,
  ])
  const result = await runLoop(options({
    adapter,
    approve: async () => { approveCalled = true; return { action: 'approve' } },
  }))
  expect(result.status).toBe('agent-error')
  expect(result.attempts).toBe(0)
  expect(approveCalled).toBe(false)
})

test('실행 단계 어댑터 실패 → env-error, 게이트 실행 안 함', async () => {
  const adapter = new FakeAdapter([
    fakeResult(planText('true')),
    { ok: false, finalText: '', events: [] } as AgentResult,
  ])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('agent-error')
  expect(result.attempts).toBe(1)
  expect(result.evidence).toHaveLength(0) // 게이트 실행 안 됨
})

test('사용자 게이트가 제안 게이트보다 우선됨 → success', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-user-gate-'))
  const marker = join(cwd, 'user.marker')
  writeFileSync(marker, 'ok') // 사용자 게이트는 통과하도록 미리 설정
  const userGate = { name: 'g', cmd: `test -f ${marker}`, timeoutMs: 300000 }
  // 제안 게이트는 실패하는 cmd
  const adapter = new FakeAdapter([
    fakeResult(planText('false')),
    fakeResult('실행 완료'),
  ])
  const store = new RunStore(cwd, 'user-gate-test')
  const result = await runLoop(options({
    adapter,
    cwd,
    userGates: [userGate],
    store,
  }))
  expect(result.status).toBe('success') // 사용자 게이트(true)가 실행됨, 제안 게이트(false)는 무시됨
  expect(result.evidence[0][0].cmd).toBe(`test -f ${marker}`) // 실행된 게이트의 cmd가 사용자 것인지 확인
  // goal.json에서도 사용자 게이트만 포함되었는지 확인
  const goal = JSON.parse(readFileSync(join(store.dir, 'goal.json'), 'utf-8'))
  expect(goal.gates).toHaveLength(1)
  expect(goal.gates[0].cmd).toBe(`test -f ${marker}`)
})
