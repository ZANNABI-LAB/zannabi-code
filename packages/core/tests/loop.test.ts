import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentResult, AgentAdapter } from '../src/adapter'
import type { GateWarning } from '../src/gates'
import { runLoop, type LoopOptions } from '../src/loop'
import { RunStore, readJournal } from '../src/store'
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
  expect(result.rounds[0].evidence[0].outcome).toBe('pass')
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

test('실행 단계 어댑터 실패 → 복구 시도 후에도 실패하면 agent-error, 게이트 실행 안 함', async () => {
  const failed = { ok: false, finalText: '', events: [] } as AgentResult
  const adapter = new FakeAdapter([fakeResult(planText('true')), failed, failed])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('agent-error')
  expect(result.attempts).toBe(1)
  expect(result.rounds).toHaveLength(0) // 게이트 실행 안 됨
})

test('사용자 게이트가 제안 게이트보다 우선됨 → success', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-user-gate-'))
  const marker = join(cwd, 'user.marker')
  writeFileSync(marker, 'ok') // 사용자 게이트는 통과하도록 미리 설정
  const userGate = { name: 'g', cmd: `test -f ${marker}`, timeoutMs: 300000, source: 'user' } as const
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
  expect(result.rounds[0].evidence[0].cmd).toBe(`test -f ${marker}`) // 실행된 게이트의 cmd가 사용자 것인지 확인
  // goal.json에서도 사용자 게이트만 포함되었는지 확인
  const goal = JSON.parse(readFileSync(join(store.dir, 'goal.json'), 'utf-8'))
  expect(goal.gates).toHaveLength(1)
  expect(goal.gates[0].cmd).toBe(`test -f ${marker}`)
})

test('어댑터 사전점검 실패 → 계획 호출 없이 agent-error + 사유', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true'))])
  ;(adapter as AgentAdapter).preflight = async () => ({ ok: false, detail: '로그인 필요' })
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('agent-error')
  expect(result.detail).toBe('[fake] 로그인 필요') // 어느 어댑터인지 함께 남긴다
  expect(adapter.requests).toHaveLength(0) // 계획 비용조차 쓰지 않음
})

test('어댑터 실패 사유가 LoopResult.detail로 전달된다', async () => {
  const adapter = new FakeAdapter([
    { ok: false, finalText: '', events: [], errorReason: 'exit 1 | result=error_auth' },
  ])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('agent-error')
  expect(result.detail).toBe('exit 1 | result=error_auth')
})

test('실행 불가 게이트의 경고가 approve로 전달된다', async () => {
  let seen: GateWarning[] = []
  const adapter = new FakeAdapter([fakeResult(planText('definitely-not-a-command-xyz'))])
  const result = await runLoop(options({
    adapter,
    approve: async (_p, _g, warnings) => {
      seen = warnings
      return { action: 'abort', reason: '경고 때문에 거부' }
    },
  }))
  expect(seen).toHaveLength(1)
  expect(seen[0].gate).toBe('g')
  expect(result.status).toBe('aborted')
  expect(result.detail).toBe('경고 때문에 거부')
})

test('env-error는 어느 게이트가 깨졌는지 detail에 남긴다', async () => {
  const adapter = new FakeAdapter([
    fakeResult(planText('definitely-not-a-command-xyz')), fakeResult('1'),
  ])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('env-error')
  expect(result.detail).toContain('definitely-not-a-command-xyz')
})

test('실행 크래시 → --resume으로 한 번 복구 시도, 성공하면 예산 소모 없음', async () => {
  const adapter = new FakeAdapter([
    fakeResult(planText('true')),
    { ok: false, finalText: '', events: [], sessionId: 's1', errorReason: '끊김' },
    fakeResult('복구 후 실행'),
  ])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('success')
  expect(result.attempts).toBe(1) // 복구는 재시도 예산을 쓰지 않는다
  expect(adapter.requests[2].resumeSessionId).toBe('s1')
})

test('복구도 실패하면 agent-error — 무한 재시도하지 않는다', async () => {
  const failed = { ok: false, finalText: '', events: [], sessionId: 's1', errorReason: '끊김' }
  const adapter = new FakeAdapter([fakeResult(planText('true')), failed, failed])
  const result = await runLoop(options({ adapter }))
  expect(result.status).toBe('agent-error')
  expect(result.detail).toBe('끊김')
  expect(adapter.requests).toHaveLength(3) // 계획 + 실행 + 복구 1회
})

test('생성-검증 분리: 계획은 plan 어댑터, 실행은 exec 어댑터가 맡는다', async () => {
  const planner = new FakeAdapter([fakeResult(planText('true'))])
  const executor = new FakeAdapter([fakeResult('실행했음', 'exec-session')])
  const result = await runLoop(options({ adapter: planner, execAdapter: executor }))

  expect(result.status).toBe('success')
  expect(planner.requests).toHaveLength(1) // 계획만
  expect(executor.requests).toHaveLength(1) // 실행만
  expect(planner.requests[0].prompt).toContain('Do NOT modify any files')
  expect(executor.requests[0].prompt).toContain('Execute this plan')
})

test('분리 실행이면 계획 세션을 실행 턴으로 넘기지 않는다', async () => {
  // 계획 세션 's1'은 계획 런타임의 것이라 다른 런타임이 이어받을 수 없다
  const planner = new FakeAdapter([fakeResult(planText('true'), 's1')])
  const executor = new FakeAdapter([fakeResult('실행', 'exec-1')])
  await runLoop(options({ adapter: planner, execAdapter: executor }))

  expect(executor.requests[0].resumeSessionId).toBeUndefined()
})

test('분리 실행에서도 실행 턴끼리는 세션을 이어간다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-split-'))
  const marker = join(cwd, 'done.marker')
  const planner = new FakeAdapter([fakeResult(planText(`test -f ${marker}`))])
  const executor = new FakeAdapter(
    [fakeResult('1차', 'exec-1'), fakeResult('2차', 'exec-1')],
    (_req, i) => { if (i === 1) writeFileSync(marker, 'ok') },
  )
  const result = await runLoop(options({
    adapter: planner, execAdapter: executor, cwd, store: new RunStore(cwd, 'split'),
  }))

  expect(result.status).toBe('success')
  expect(executor.requests[1].resumeSessionId).toBe('exec-1') // 실행 런타임 자신의 세션
})

test('분리 실행이면 양쪽 어댑터를 모두 사전점검한다', async () => {
  const planner = new FakeAdapter([fakeResult(planText('true'))])
  const executor = new FakeAdapter([fakeResult('실행')])
  ;(executor as AgentAdapter).preflight = async () => ({ ok: false, detail: 'codex 로그인 필요' })

  const result = await runLoop(options({ adapter: planner, execAdapter: executor }))
  expect(result.status).toBe('agent-error')
  expect(result.detail).toContain('codex 로그인 필요')
  expect(planner.requests).toHaveLength(0) // 계획 비용을 쓰기 전에 막는다
})

test('runtime 표기가 결과와 goal.json에 남는다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-runtime-'))
  const store = new RunStore(cwd, 'runtime')
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const runtime = { plan: 'claude:opus-5', exec: 'codex:gpt-5.4' }
  const result = await runLoop(options({ adapter, cwd, store, runtime }))

  expect(result.runtime).toEqual(runtime)
  const goal = JSON.parse(readFileSync(join(store.dir, 'goal.json'), 'utf-8'))
  expect(goal.runtime).toEqual(runtime)
})

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

test('증거에 리비전이 결박된다', async () => {
  const cwd = await gitRepo('zannabi-bind-')
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const result = await runLoop(options({ adapter, cwd, store: new RunStore(cwd, 'bind') }))

  const round = result.rounds[0]
  expect(round.revision.tracked).toBe(true)
  expect(round.revision.head).toMatch(/^[0-9a-f]{40}$/)
  // 증거 한 줄만 떼어 봐도 대상이 특정돼야 한다 (설계 §5)
  expect(round.evidence[0].revision).toEqual(round.revision)
})

test('라운드마다 diff가 저장된다', async () => {
  const cwd = await gitRepo('zannabi-rounddiff-')
  const store = new RunStore(cwd, 'rounddiff')
  const adapter = new FakeAdapter(
    [fakeResult(planText('test -f done.marker')), fakeResult('1차'), fakeResult('2차')],
    (_req, i) => { if (i === 2) writeFileSync(join(cwd, 'done.marker'), 'ok') },
  )
  const result = await runLoop(options({ adapter, cwd, store }))

  expect(result.status).toBe('success')
  expect(readFileSync(join(store.dir, 'rounds', 'round-1.patch'), 'utf-8')).toBe('')
  // 2라운드에서 파일이 생겼으니 diff가 비어 있지 않아야 사후 검증이 가능하다
  expect(readFileSync(join(store.dir, 'rounds', 'round-2.patch'), 'utf-8')).toContain('done.marker')
  expect(result.rounds[0].revision.diffHash).not.toBe(result.rounds[1].revision.diffHash)
  expect(result.rounds[1].repeatOf).toBeUndefined()
})

test('변경도 결과도 그대로면 예산을 남기고 no-progress로 끊는다', async () => {
  const cwd = await gitRepo('zannabi-stall-')
  const adapter = new FakeAdapter([
    fakeResult(planText('false')),
    fakeResult('1'), fakeResult('2'), fakeResult('3'), fakeResult('4'), fakeResult('5'),
  ])
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'stall'), budget: 5, stallLimit: 3,
  }))

  expect(result.status).toBe('no-progress')
  expect(result.attempts).toBe(3) // 예산 5 중 2를 아꼈다
  expect(result.rounds[2].repeatOf).toBe(1)
  // 3라운드째 프롬프트에는 반복 중이라는 경고가 실린다
  expect(adapter.requests[3].prompt).toContain('changed no files')
})

test('중간에 파일이 바뀌면 정체로 보지 않는다', async () => {
  const cwd = await gitRepo('zannabi-nostall-')
  const adapter = new FakeAdapter(
    [fakeResult(planText('false')), fakeResult('1'), fakeResult('2'), fakeResult('3')],
    (_req, i) => { if (i === 2) writeFileSync(join(cwd, 'touched.txt'), 'x') },
  )
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'nostall'), budget: 3, stallLimit: 3,
  }))

  // 게이트는 3라운드 내내 같은 실패였지만 2라운드에서 파일이 달라졌다 — 실측의 B2 반례
  expect(result.status).toBe('budget-exhausted')
  expect(result.attempts).toBe(3)
})

test('git 저장소가 아니면 정체 감지가 스스로 꺼진다', async () => {
  const adapter = new FakeAdapter([
    fakeResult(planText('false')), fakeResult('1'), fakeResult('2'), fakeResult('3'),
  ])
  const result = await runLoop(options({ adapter, budget: 3, stallLimit: 3 }))
  expect(result.status).toBe('budget-exhausted')
  expect(result.rounds[2].revision.tracked).toBe(false)
})

test('통과 재확인에서 결과가 갈리면 unreproduced-pass — 재현 안 되는 통과는 증거가 아니다', async () => {
  const cwd = await gitRepo('zannabi-unreproduced-')
  // 첫 실행만 통과하고 다음부터 실패하는 게이트 — 간헐 실패의 최소 재현
  const marker = join(cwd, 'flag')
  writeFileSync(marker, 'x')
  const adapter = new FakeAdapter([
    fakeResult(planText(`test -f flag && rm flag`)), fakeResult('했음'),
  ])
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'unreproduced'), verifyRepeat: 3,
  }))

  expect(result.status).toBe('unreproduced-pass')
  expect(result.rounds[0].unreproduced).toEqual(['g'])
  expect(result.rounds[0].evidence[0].outcome).toBe('pass') // 원본 증거는 그대로 남는다
  expect(result.rounds[0].recheck?.[0].outcome).toBe('fail')
})

test('재확인이 모두 통과하면 success이고 recheck 증거가 남는다', async () => {
  const cwd = await gitRepo('zannabi-stable-')
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'stable'), verifyRepeat: 3,
  }))

  expect(result.status).toBe('success')
  expect(result.rounds[0].unreproduced).toBeUndefined()
  expect(result.rounds[0].recheck).toHaveLength(2) // 총 3회 중 추가 2회
})

test('--no-suggest면 제안 게이트를 받지 않는다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-nosuggest-'))
  const userGate = { name: 'u', cmd: 'true', timeoutMs: 300000, source: 'user' } as const
  const adapter = new FakeAdapter([fakeResult(planText('false')), fakeResult('했음')])
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'nosuggest'),
    userGates: [userGate], rejectSuggested: true,
  }))

  // 제안된 'g'(false)가 들어왔다면 실패했을 것이다
  expect(result.status).toBe('success')
  expect(result.rounds[0].evidence.map(e => e.gate)).toEqual(['u'])
})

test('게이트 타임아웃은 제안 게이트에도 걸린다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-timeout-'))
  const adapter = new FakeAdapter([fakeResult(planText('sleep 5')), fakeResult('했음')])
  const started = Date.now()
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'timeout'), budget: 1, gateTimeoutMs: 100,
  }))

  expect(result.status).toBe('env-error') // 타임아웃은 게이트 판정이 아니라 환경 오류다
  expect(Date.now() - started).toBeLessThan(4000) // 5초를 기다리지 않았다
})

test('사용자 게이트만 통과한 예산 소진은 그 사실을 사유에 밝힌다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-summary-'))
  const userGate = { name: 'u', cmd: 'true', timeoutMs: 300000, source: 'user' } as const
  const adapter = new FakeAdapter([
    fakeResult(planText('false')), fakeResult('1'), fakeResult('2'),
  ])
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'summary'), userGates: [userGate], budget: 2,
  }))

  expect(result.status).toBe('budget-exhausted')
  expect(result.detail).toContain('사용자 게이트 1/1 통과')
  expect(result.detail).toContain('완료 기준은 모두 충족')
})

test('계획 턴과 실행 턴의 사용량을 나눠 집계한다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-usage-'))
  const withUsage = (text: string, inputTokens: number, costUsd?: number) => ({
    ...fakeResult(text),
    usage: { inputTokens, outputTokens: 1, turns: 1, ...(costUsd === undefined ? {} : { costUsd }) },
  })
  const adapter = new FakeAdapter([
    withUsage(planText('true'), 100, 0.5), withUsage('했음', 30),
  ])
  const result = await runLoop(options({ adapter, cwd, store: new RunStore(cwd, 'usage') }))

  expect(result.usage?.plan).toEqual({ inputTokens: 100, outputTokens: 1, costUsd: 0.5, turns: 1 })
  // 실행 턴은 비용을 보고하지 않았다 — 0원이 아니라 "모름"으로 남아야 한다
  expect(result.usage?.exec.costUsd).toBeUndefined()
  expect(result.usage?.exec.inputTokens).toBe(30)
})

test('이름 충돌로 밀린 제안 게이트는 경고로 뜨고 결과와 goal.json에 남는다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-dropped-'))
  let seen: GateWarning[] = []
  const store = new RunStore(cwd, 'dropped')
  // 제안은 'g' 이름으로 cleanTest를 붙여 오지만, 같은 이름의 사용자 게이트가 이긴다
  const adapter = new FakeAdapter([fakeResult(planText('true # cleanTest')), fakeResult('했음')])
  const result = await runLoop(options({
    adapter, cwd, store,
    userGates: [{ name: 'g', cmd: 'true', timeoutMs: 300000, source: 'user' }],
    approve: async (_p, _g, warnings) => {
      seen = warnings
      return { action: 'approve' }
    },
  }))

  expect(result.status).toBe('success')
  expect(result.rounds[0].evidence.map(e => e.cmd)).toEqual(['true']) // 사용자 게이트가 실행됐다
  expect(result.dropped).toEqual([
    { name: 'g', cmd: 'true # cleanTest', reason: 'name-collision', keptCmd: 'true' },
  ])
  // 침묵하지 않는다 — 승인 화면에도, 증거에도 남는다
  expect(seen.map(w => w.kind)).toEqual(['advisory'])
  expect(seen[0].reason).toContain('같은 이름의 사용자 게이트')
  const goal = JSON.parse(readFileSync(join(store.dir, 'goal.json'), 'utf-8'))
  expect(goal.droppedGates).toHaveLength(1)
})

test('--no-suggest로 버린 제안도 무엇을 버렸는지 남긴다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-dropped-reject-'))
  const adapter = new FakeAdapter([fakeResult(planText('false')), fakeResult('했음')])
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'dropped-reject'),
    userGates: [{ name: 'u', cmd: 'true', timeoutMs: 300000, source: 'user' }],
    rejectSuggested: true,
  }))

  expect(result.status).toBe('success')
  expect(result.dropped).toEqual([{ name: 'g', cmd: 'false', reason: 'rejected' }])
})

// 첫 회만 오래 걸리고 두 번째부터 즉시 끝나는 게이트 — 빌드 캐시 스킵의 축소판이다.
// 5초를 실제로 기다린다(RECHECK_MIN_MS 아래는 판단하지 않으므로 줄일 수 없다)
test('재확인이 첫 회보다 극단적으로 짧으면 통과시키되 정황을 남긴다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-skip-'))
  const marker = join(cwd, 'built.marker')
  const logs: string[] = []
  const adapter = new FakeAdapter([
    fakeResult(planText(`test -f ${marker} || sleep 5.2; touch ${marker}`)),
    fakeResult('했음'),
  ])
  const result = await runLoop(options({
    adapter, cwd, store: new RunStore(cwd, 'skip'),
    budget: 1, verifyRepeat: 2, gateTimeoutMs: 30_000,
    log: m => logs.push(m),
  }))

  // 통과는 통과다 — 정황만으로 완료를 무르지 않는다
  expect(result.status).toBe('success')
  const suspects = result.rounds[0].recheckSuspects ?? []
  expect(suspects).toHaveLength(1)
  expect(suspects[0].recheckMs).toBeLessThan(suspects[0].firstMs * 0.4)
  expect(logs.some(m => m.includes('재확인 경고'))).toBe(true)
}, 30_000) // 게이트가 실제로 5.2초를 쓰므로 기본 타임아웃(5s)으로는 모자란다

// 같은 게이트를 콜드 첫 회로 돌린다 — 경고는 없어야 하지만, 억제가 일했다는 사실은
// 저널에 남아야 한다. 3차 실측이 막힌 지점이 정확히 여기였다
test('콜드 첫 회 억제는 짚지 않되 무엇을 삼켰는지 저널에 남긴다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-cold-'))
  const marker = join(cwd, 'built.marker')
  const logs: string[] = []
  const store = new RunStore(cwd, 'cold')
  const adapter = new FakeAdapter([
    fakeResult(planText(`test -f ${marker} || sleep 5.2; touch ${marker}`)),
    fakeResult('했음'),
  ])
  const result = await runLoop(options({
    adapter, cwd, store,
    budget: 1, verifyRepeat: 2, gateTimeoutMs: 30_000,
    coldWorkspace: true,
    log: m => logs.push(m),
  }))

  expect(result.status).toBe('success')
  // 억제가 일했다 — 사람에게는 아무 말도 하지 않는다
  expect(result.rounds[0].recheckSuspects ?? []).toEqual([])
  expect(logs.some(m => m.includes('재확인 경고'))).toBe(false)

  // 그러나 저널은 무엇을 삼켰는지 안다
  const events = readJournal(store.dir)
  const suppressed = events.filter(e => e.type === 'recheck-suppressed')
  expect(suppressed).toHaveLength(1)
  expect(suppressed[0]).toMatchObject({ round: 1, cause: 'cold-first-run' })
  expect(suppressed[0].suppressed).toHaveLength(1)
  expect(suppressed[0].suppressed[0].gate).toBe('g')
}, 30_000)

test('정체 감지가 예산에 눌려 죽는 조합이면 승인 전에 말한다', async () => {
  const logs: string[] = []
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  // 실측에서 걸린 조합: 기본 stallLimit 3 · balanced 프리셋 예산 3
  const result = await runLoop(options({ adapter, budget: 3, stallLimit: 3, log: m => logs.push(m) }))

  expect(result.stallDead).toBe(true)
  expect(logs.some(m => m.includes('정체 감지가 이 조합에서는 작동하지 않습니다'))).toBe(true)
})

test('예산이 한계보다 크면 그런 경고를 하지 않는다', async () => {
  const logs: string[] = []
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const result = await runLoop(options({ adapter, budget: 4, stallLimit: 3, log: m => logs.push(m) }))

  expect(result.stallDead).toBe(false)
  expect(logs.some(m => m.includes('정체 감지'))).toBe(false)
})

test('실행 턴에 승인된 게이트 명령만 열어 준다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  await runLoop(options({
    adapter,
    userGates: [{ name: 'u', cmd: 'echo ok', timeoutMs: 300000, source: 'user' }],
  }))

  // 계획 턴에는 열지 않는다 — 계획은 코드를 안 만지므로 확인할 것이 없다
  expect(adapter.requests[0].allowedCommands).toBeUndefined()
  // 실행 턴에는 사용자 게이트와 승인된 제안 게이트가 함께 실린다
  expect(adapter.requests[1].allowedCommands).toEqual(['echo ok', 'true'])
})

test('--no-exec-shell이면 아무것도 열지 않는다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  await runLoop(options({ adapter, execShell: false }))

  // 빈 배열이 아니라 undefined다 — 어댑터가 "열 것이 없다"와 "열지 말라"를 같게 다루면
  // 나중에 빈 배열의 뜻이 바뀔 때 조용히 넓어진다
  expect(adapter.requests[1].allowedCommands).toBeUndefined()
})

test('에이전트가 스스로 돌린 명령이 저널에 남는다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-selfcheck-'))
  const store = new RunStore(cwd, 'selfcheck')
  const adapter = new FakeAdapter([
    fakeResult(planText('true')),
    { ...fakeResult('했음'), selfChecks: [{ cmd: 'bun test' }, { cmd: 'bun test' }] },
  ])
  await runLoop(options({ adapter, cwd, store }))

  const exec = readJournal(store.dir).filter(e => e.type === 'exec-finished')
  expect(exec).toHaveLength(1)
  // 같은 명령을 두 번 돌린 것도 두 건이다 — 몇 번 확인했는지가 물음이다
  expect(exec[0].selfChecks).toEqual([{ cmd: 'bun test' }, { cmd: 'bun test' }])
})
