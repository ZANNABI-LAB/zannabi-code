import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns, readJournal, replay } from '@zannabi-lab/core'
import { runRace, RACES_DIR } from '../src/race'
import { FakeAdapter, fakeResult, type AgentAdapter } from '@zannabi-lab/core'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zannabi-race-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.name', 'test'], { cwd: dir })
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
  Bun.spawnSync(['git', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const PLAN = '계획: 한다.\n```json\n{"gates":[{"name":"suggested","cmd":"true"}]}\n```'

function git(args: string[], cwd: string): string {
  return Bun.spawnSync(['git', ...args], { cwd }).stdout.toString().trim()
}

test('계획은 한 번만 세우고 모든 조가 공유한다', async () => {
  // race의 설계 전체가 여기 걸려 있다: 조마다 계획을 세우면 무엇 때문에 이겼는지 알 수 없고,
  // 계획 비용을 N번 내며, 승인이 N번 뜨는 도구는 쓸 수 없다
  const cwd = repo()
  let planCalls = 0
  const planAdapter: AgentAdapter = {
    name: 'plan',
    async run() {
      planCalls++
      return fakeResult(PLAN)
    },
  }
  let approvals = 0

  const summary = await runRace({
    intent: '계획 공유 시험',
    cwd,
    arms: [
      { name: 'a', agent: 'claude' },
      { name: 'b', agent: 'claude' },
      { name: 'c', agent: 'claude' },
    ],
    userGates: [],
    budget: 2,
    concurrency: 3,
    planAdapter,
    planLabel: 'claude:default',
    adapterFor: () => new FakeAdapter([fakeResult('했음'), fakeResult('했음')]),
    approve: async () => {
      approvals++
      return { action: 'approve' }
    },
    log: () => {},
  })

  expect(planCalls).toBe(1)
  expect(approvals).toBe(1)
  expect(summary?.arms).toHaveLength(3)

  // 각 조의 저널은 계획 턴을 돌리지 않았으므로 계획 사용량이 없다.
  // 그래도 plan-finished와 승인 이벤트는 남는다 — 저널만 재생하는 쪽이
  // "승인 없이 돌았다"고 읽으면 안 되기 때문이다
  for (const runId of listRuns(cwd)) {
    const events = readJournal(join(cwd, '.zannabi', 'runs', runId))
    const state = replay(events)
    expect(state.approved).toBe(true)
    expect(state.usage.plan.turns).toBe(0)
    const planFinished = events.find(e => e.type === 'plan-finished')
    expect(planFinished).toBeDefined()
    if (planFinished && planFinished.type === 'plan-finished')
      expect(planFinished.usage).toBeUndefined()
  }
}, 30_000)

test('세 조가 동시에 돌아도 각자의 증거와 브랜치가 따로 남는다', async () => {
  const cwd = repo()
  const marks = ['alpha', 'beta', 'gamma']

  const summary = await runRace({
    intent: '동시 실행',
    cwd,
    arms: marks.map(m => ({ name: m, agent: 'claude' })),
    // 조마다 자기 이름의 파일을 만들고, 게이트는 그 파일이 있는지 본다
    userGates: [{ name: 'mine', cmd: 'ls . > /dev/null', timeoutMs: 30_000, source: 'user' }],
    budget: 2,
    concurrency: 3,
    planAdapter: { name: 'plan', async run() { return fakeResult(PLAN) } },
    planLabel: 'claude:default',
    adapterFor: arm =>
      new FakeAdapter([fakeResult('했음'), fakeResult('했음')], req => {
        writeFileSync(join(req.cwd, `${arm.name}.txt`), arm.name)
      }),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  })

  expect(summary?.passed).toHaveLength(3)
  expect(listRuns(cwd)).toHaveLength(3)

  // 각 브랜치에는 자기 파일만 있다 — 공유 워킹트리였다면 서로의 파일이 섞였을 것이다
  for (const o of summary!.arms) {
    const files = git(['ls-tree', '--name-only', o.branch!], cwd).split('\n')
    expect(files).toContain(`${o.arm.name}.txt`)
    for (const other of marks.filter(m => m !== o.arm.name))
      expect(files).not.toContain(`${other}.txt`)
  }

  // 원본 워킹트리에는 아무것도 생기지 않았다
  for (const m of marks) expect(existsSync(join(cwd, `${m}.txt`))).toBe(false)
  // 워크트리는 전부 치워졌다
  expect(git(['worktree', 'list'], cwd).split('\n').filter(Boolean)).toHaveLength(1)
}, 30_000)

test('조들의 저널이 같은 raceId를 달아 서로 묶인다', async () => {
  // 없으면 같은 작업의 조 셋이 서로 무관한 실행 셋으로 보인다 —
  // race를 여러 번 돌린 저장소에서 어느 실행이 어느 비교에 속했는지 알 수 없다
  const cwd = repo()
  const summary = await runRace({
    intent: '묶임 확인',
    cwd,
    arms: [
      { name: 'a', agent: 'claude' },
      { name: 'b', agent: 'claude' },
    ],
    userGates: [],
    budget: 1,
    concurrency: 2,
    planAdapter: { name: 'plan', async run() { return fakeResult(PLAN) } },
    planLabel: 'claude:default',
    adapterFor: () => new FakeAdapter([fakeResult('했음')]),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  })

  const raceIds = listRuns(cwd).map(
    runId => replay(readJournal(join(cwd, '.zannabi', 'runs', runId))).raceId,
  )
  expect(raceIds).toEqual([summary!.raceId, summary!.raceId])
}, 30_000)

test('집계가 파일로 남고, 개별 실행의 판정과 같은 말을 한다', async () => {
  const cwd = repo()
  const summary = await runRace({
    intent: '집계 확인',
    cwd,
    arms: [
      { name: 'pass', agent: 'claude' },
      { name: 'fail', agent: 'claude' },
    ],
    userGates: [],
    budget: 1,
    concurrency: 2,
    planAdapter: { name: 'plan', async run() { return fakeResult(PLAN) } },
    planLabel: 'claude:default',
    // fail 조는 게이트를 깨뜨린다 — 제안 게이트 `true`를 실패시킬 수 없으니
    // 이 조만 별도 게이트를 실패하도록 파일을 지운다
    adapterFor: arm =>
      new FakeAdapter([fakeResult('했음')], req => {
        if (arm.name === 'fail') writeFileSync(join(req.cwd, 'x.txt'), 'x')
      }),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  })

  const dir = join(cwd, RACES_DIR, summary!.raceId)
  expect(existsSync(join(dir, 'summary.json'))).toBe(true)
  const saved = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf-8'))
  expect(saved.arms).toHaveLength(2)

  // 집계의 판정은 각 실행의 저널이 말하는 것과 같아야 한다 — 다르면 둘 중 하나가 거짓이다
  for (const arm of saved.arms) {
    const state = replay(readJournal(join(cwd, '.zannabi', 'runs', arm.runId)))
    expect(state.status).toBe(arm.result.status)
  }
  expect(readdirSync(dir)).toContain('summary.md')
}, 30_000)

test('계획이 실패하면 조를 하나도 돌리지 않는다', async () => {
  // 계획 없이 도는 실행은 완료 기준이 없다. 실패를 알면서 N배의 돈을 쓰지 않는다
  const cwd = repo()
  const summary = await runRace({
    intent: '계획 실패',
    cwd,
    arms: [
      { name: 'a', agent: 'claude' },
      { name: 'b', agent: 'claude' },
    ],
    userGates: [],
    budget: 1,
    concurrency: 2,
    planAdapter: {
      name: 'plan',
      async run() {
        return { ok: false, finalText: '', events: [], errorReason: '인증 만료' }
      },
    },
    planLabel: 'claude:default',
    adapterFor: () => new FakeAdapter([]),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  })

  expect(summary).toBeUndefined()
  expect(listRuns(cwd)).toHaveLength(0)
  expect(git(['worktree', 'list'], cwd).split('\n').filter(Boolean)).toHaveLength(1)
}, 30_000)

test('승인하지 않으면 조를 돌리지 않는다', async () => {
  const cwd = repo()
  const summary = await runRace({
    intent: '승인 거부',
    cwd,
    arms: [
      { name: 'a', agent: 'claude' },
      { name: 'b', agent: 'claude' },
    ],
    userGates: [],
    budget: 1,
    concurrency: 2,
    planAdapter: { name: 'plan', async run() { return fakeResult(PLAN) } },
    planLabel: 'claude:default',
    adapterFor: () => new FakeAdapter([]),
    approve: async () => ({ action: 'abort', reason: '사람이 승인하지 않음' }),
    log: () => {},
  })

  expect(summary).toBeUndefined()
  expect(listRuns(cwd)).toHaveLength(0)
}, 30_000)
