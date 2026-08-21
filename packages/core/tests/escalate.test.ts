import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escalationBlocked } from '../src/escalate'
import { runLoop, type LoopOptions } from '../src/loop'
import { RunStore } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'

const planText = (cmd: string) =>
  `계획: 한다.\n\`\`\`json\n{"gates":[{"name":"g","cmd":"${cmd}"}]}\n\`\`\``

async function gitRepo(prefix: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), prefix))
  const proc = Bun.spawn(
    ['sh', '-c',
      'git init -q && git config user.email t@t && git config user.name t && ' +
      'echo hello > a.txt && git add -A && git commit -qm init'],
    { cwd, stdout: 'ignore', stderr: 'ignore' },
  )
  await proc.exited
  return cwd
}

function options(partial: Partial<LoopOptions> & { adapter: LoopOptions['adapter'] }): LoopOptions {
  return {
    intent: '승격 테스트',
    userGates: [],
    budget: 5,
    stallLimit: 3,
    escalate: true,
    runtime: { plan: 'claude:opus-5', exec: 'claude:haiku-4-5' },
    cwd: '.',
    store: new RunStore('.', 'x'),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
    ...partial,
  }
}

/** 계획 어댑터: 계획 1회 + 승격 후 실행 몇 회 */
const planner = (cmd: string, execTurns: number, onRun?: (i: number) => void) =>
  new FakeAdapter(
    [fakeResult(planText(cmd)), ...Array.from({ length: execTurns }, (_, i) => fakeResult(`승격실행${i}`))],
    (_req, i) => onRun?.(i),
  )

test('정체하면 중단 대신 실행 턴을 계획 런타임으로 올리고, 그 뒤 통과한다', async () => {
  const cwd = await gitRepo('zannabi-esc-')
  const marker = join(cwd, 'done.marker')
  // 계획 어댑터는 승격된 실행에서 파일을 만든다 (index 1 = 계획 다음의 첫 실행 턴)
  const plan = planner(`test -f ${marker}`, 2, i => { if (i === 1) writeFileSync(marker, 'ok') })
  // 저가 실행 어댑터는 아무것도 하지 못한다 — 세 라운드가 완전히 같은 자리를 돈다
  const exec = new FakeAdapter([fakeResult('1'), fakeResult('2'), fakeResult('3')])

  const result = await runLoop(options({
    adapter: plan, execAdapter: exec, cwd, store: new RunStore(cwd, 'esc'), budget: 6,
  }))

  expect(result.status).toBe('success')
  expect(result.escalation).toEqual({
    round: 4, from: 'claude:haiku-4-5', to: 'claude:opus-5', reason: 'no-progress',
  })
  expect(result.attempts).toBe(4) // 정체 3라운드 + 승격 후 1라운드
  expect(exec.requests).toHaveLength(3) // 저가 실행은 승격 뒤로 더 불리지 않는다
})

test('승격된 실행은 앞 런타임의 세션을 이어받지 않는다', async () => {
  const cwd = await gitRepo('zannabi-escsession-')
  const marker = join(cwd, 'done.marker')
  const plan = planner(`test -f ${marker}`, 2, i => { if (i === 1) writeFileSync(marker, 'ok') })
  const exec = new FakeAdapter([fakeResult('1'), fakeResult('2'), fakeResult('3')])

  await runLoop(options({
    adapter: plan, execAdapter: exec, cwd, store: new RunStore(cwd, 'escsession'), budget: 6,
  }))

  // 계획 어댑터의 두 번째 호출 = 승격된 첫 실행. 다른 런타임의 세션 id가 실려서는 안 된다
  expect(plan.requests[1].resumeSessionId).toBeUndefined()
  expect(plan.requests[1].prompt).toContain('exit 1') // 맥락은 실패 증거로 전달된다
})

test('승격하고도 같은 자리면 no-progress로 끊고, 승격했다는 사실을 남긴다', async () => {
  const cwd = await gitRepo('zannabi-escfail-')
  const plan = planner('false', 4)
  const exec = new FakeAdapter([fakeResult('1'), fakeResult('2'), fakeResult('3')])

  const result = await runLoop(options({
    adapter: plan, execAdapter: exec, cwd, store: new RunStore(cwd, 'escfail'), budget: 8,
  }))

  expect(result.status).toBe('no-progress')
  expect(result.escalation?.round).toBe(4)
  expect(result.attempts).toBe(6) // 승격 후 정체를 다시 3라운드 세고 끊는다
  expect(result.detail).toContain('승격한 뒤에도')
})

test('승격은 한 번뿐이다 — 올라갈 데가 하나뿐이라 두 번째는 정의되지 않는다', async () => {
  const cwd = await gitRepo('zannabi-escone-')
  const plan = planner('false', 6)
  const exec = new FakeAdapter([fakeResult('1'), fakeResult('2'), fakeResult('3')])

  const result = await runLoop(options({
    adapter: plan, execAdapter: exec, cwd, store: new RunStore(cwd, 'escone'), budget: 9,
  }))

  expect(result.status).toBe('no-progress')
  expect(result.attempts).toBe(6) // 두 번째 승격 없이 6라운드에서 끊긴다
})

test('기본은 꺼져 있다 — 켜지 않으면 정체에서 그냥 중단한다', async () => {
  const cwd = await gitRepo('zannabi-escoff-')
  const plan = planner('false', 0)
  const exec = new FakeAdapter([fakeResult('1'), fakeResult('2'), fakeResult('3')])

  const result = await runLoop(options({
    adapter: plan, execAdapter: exec, cwd, store: new RunStore(cwd, 'escoff'),
    budget: 6, escalate: undefined,
  }))

  expect(result.status).toBe('no-progress')
  expect(result.escalation).toBeUndefined()
  expect(result.attempts).toBe(3)
})

test('계획과 실행이 같은 런타임이면 승격할 곳이 없고, 그 사실을 승인 전에 말한다', async () => {
  const cwd = await gitRepo('zannabi-escsame-')
  const said: string[] = []
  const adapter = new FakeAdapter([
    fakeResult(planText('false')), fakeResult('1'), fakeResult('2'), fakeResult('3'),
  ])

  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'escsame'), budget: 6,
    runtime: { plan: 'claude:opus-5', exec: 'claude:opus-5' },
    log: m => said.push(m),
  }))

  expect(result.status).toBe('no-progress')
  expect(result.escalation).toBeUndefined()
  expect(said.some(m => m.includes('올릴 곳이 없습니다'))).toBe(true)
})

test('승격할 예산이 남지 않으면 승격하지 않고, 사유에 그 이유를 적는다', async () => {
  const cwd = await gitRepo('zannabi-escbudget-')
  const plan = planner('false', 0)
  const exec = new FakeAdapter([fakeResult('1'), fakeResult('2'), fakeResult('3')])

  const result = await runLoop(options({
    adapter: plan, execAdapter: exec, cwd, store: new RunStore(cwd, 'escbudget'), budget: 3,
  }))

  expect(result.status).toBe('no-progress')
  expect(result.escalation).toBeUndefined()
  expect(result.detail).toContain('승격할 예산이 남지 않아')
})

test('승격을 켰다는 사실이 goal.json에 남아 같은 조건을 다시 세울 수 있다', async () => {
  const cwd = await gitRepo('zannabi-escgoal-')
  const store = new RunStore(cwd, 'escgoal')
  const plan = planner('true', 1)
  const exec = new FakeAdapter([fakeResult('1')])

  await runLoop(options({ adapter: plan, execAdapter: exec, cwd, store }))
  const goal = JSON.parse(readFileSync(join(store.dir, 'goal.json'), 'utf-8'))
  expect(goal.loop.escalate).toBe(true)
})

test('런타임 표기가 없으면 승격 대상을 알 수 없다', () => {
  expect(escalationBlocked(undefined)).toContain('알 수 없습니다')
  expect(escalationBlocked({ plan: 'a', exec: 'a' })).toContain('올릴 곳이 없습니다')
  expect(escalationBlocked({ plan: 'a', exec: 'b' })).toBeUndefined()
})
