import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop } from '../src/loop'
import { loopOptions, type PartialOptions } from './_fixture'
import { RunStore } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'
import { JOURNAL_FILENAME, parseJournal, CONTRACT_VERSION, type JournalEvent } from '../src/journal'

const planText = (cmd: string) =>
  `계획: 한다.\n\`\`\`json\n{"gates":[{"name":"g","cmd":"${cmd}"}]}\n\`\`\``

const options = (p: PartialOptions) => loopOptions('journal', p)

function readJournal(store: RunStore): JournalEvent[] {
  return parseJournal(readFileSync(join(store.dir, JOURNAL_FILENAME), 'utf-8'))
}

test('깨진 마지막 줄은 앞의 멀쩡한 줄을 못 읽게 만들지 않는다', () => {
  // kill -9는 줄 중간에서 끊는다 — 그것 때문에 앞의 수백 줄이 버려지면 재개가 불가능하다
  const good = JSON.stringify({ type: 'round-started', at: '2026-08-21T00:00:00.000Z', round: 1 })
  const events = parseJournal(`${good}\n{"type":"round-fini`)
  expect(events).toHaveLength(1)
  expect(events[0].type).toBe('round-started')
})

test('모르는 type과 빈 줄은 건너뛴다 — 나중 판이 쓴 파일도 읽힌다', () => {
  const good = JSON.stringify({ type: 'round-started', at: '2026-08-21T00:00:00.000Z', round: 2 })
  const events = parseJournal(`\n{"type":"저-먼-미래-이벤트","at":"x"}\n${good}\n\n`)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: 'round-started', round: 2 })
})

test('성공한 실행의 저널이 어휘 순서대로 쌓인다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const opts = options({ adapter })
  const result = await runLoop(opts)
  expect(result.status).toBe('success')

  const events = readJournal(opts.store)
  const types = events.map(e => e.type)
  expect(types.filter(t => t !== 'cost-updated')).toEqual([
    'run-started',
    'plan-finished',
    'approval-requested',
    'approval-resolved',
    'round-started',
    'exec-finished',
    // 실행 턴 직후, 게이트 전에 신고를 받는다 — 게이트 결과를 보고 나서 적으면
    // 통과한 실행의 신고와 실패한 실행의 신고가 다른 조건에서 나온 것이 된다
    'claims-reported',
    'gate-started',
    'gate-result',
    'round-finished',
    'run-finished',
  ])

  const started = events[0]
  expect(started).toMatchObject({
    type: 'run-started',
    contractVersion: CONTRACT_VERSION,
    runId: opts.store.runId,
    intent: '테스트 작업',
    budget: 3,
  })
  // 모든 줄에 시각이 있다 — 없으면 tail하는 쪽이 진행 속도를 알 수 없다
  expect(events.every(e => typeof e.at === 'string' && e.at.length > 0)).toBe(true)
})

test('run-finished는 언제나 마지막 줄이고 최종 판정을 말한다', async () => {
  // 승인 거부: 반환 지점이 루프 중간이라, 각 자리에서 쓰는 설계였다면 빠졌을 경로다
  const adapter = new FakeAdapter([fakeResult(planText('true'))])
  const opts = options({ adapter, approve: async () => ({ action: 'abort', reason: '아니오' }) })
  const result = await runLoop(opts)

  const events = readJournal(opts.store)
  const last = events[events.length - 1]
  expect(last).toMatchObject({ type: 'run-finished', status: 'aborted', attempts: 0 })
  expect(result.status).toBe('aborted')
  expect(events.some(e => e.type === 'approval-resolved' && e.action === 'abort')).toBe(true)
})

test('증거가 사라진 실행은 저널의 마지막 줄도 evidence-lost를 말한다', async () => {
  // 강등은 runLoopWith가 끝난 **뒤에** 일어난다. 각 반환 지점에서 run-finished를 썼다면
  // 저널은 success라 하고 리포트는 evidence-lost라 하는, 두 입이 다른 실행이 된다
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-journal-loss-'))
  const store = new RunStore(cwd, '증거 삭제')
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')], (_r, i) => {
    if (i === 1) rmSync(store.dir, { recursive: true, force: true })
  })
  const result = await runLoop(options({ adapter, cwd, store }))
  expect(result.status).toBe('evidence-lost')

  const events = readJournal(store)
  expect(events.some(e => e.type === 'evidence-lost')).toBe(true)
  expect(events[events.length - 1]).toMatchObject({ type: 'run-finished', status: 'evidence-lost' })
})

test('저널 파일만 지워져도 손실로 기록되고, 그 기록이 자기를 다시 부르지 않는다', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-journal-self-'))
  const store = new RunStore(cwd, '저널 삭제')
  store.appendJournal({ type: 'round-started', round: 1 })
  rmSync(join(store.dir, JOURNAL_FILENAME))

  store.appendJournal({ type: 'round-started', round: 2 })

  expect(store.losses.map(l => l.target)).toEqual([JOURNAL_FILENAME])
  const events = readJournal(store)
  // 손실 한 줄 + 새 줄. 재진입을 막지 않으면 여기서 무한히 자기를 부른다
  expect(events.map(e => e.type)).toEqual(['evidence-lost', 'round-started'])
  expect(existsSync(join(store.dir, JOURNAL_FILENAME))).toBe(true)
})

test('실행 턴의 비용과 세션은 라운드가 끝나기 전에 이미 저널에 있다', async () => {
  // 게이트를 돌다 죽어도 실행 턴의 지출은 이미 발생했다. 라운드 단위로만 적으면
  // 재개할 때 그 지출이 사라져 비용 상한이 거짓말을 한다
  const exec = {
    ok: true as const,
    sessionId: 'sess-2',
    finalText: '했음',
    events: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5, turns: 1 },
  }
  const adapter = new FakeAdapter([fakeResult(planText('false')), exec, exec, exec])
  const opts = options({ adapter, budget: 1 })
  await runLoop(opts)

  const events = readJournal(opts.store)
  const execFinished = events.find(e => e.type === 'exec-finished')
  expect(execFinished).toMatchObject({ round: 1, ok: true, sessionId: 'sess-2' })
  const roundFinishedAt = events.findIndex(e => e.type === 'round-finished')
  expect(events.indexOf(execFinished!)).toBeLessThan(roundFinishedAt)

  const cost = events.filter(e => e.type === 'cost-updated')
  expect(cost[cost.length - 1]).toMatchObject({ spentUsd: 0.5, coverage: 'partial' })
})

test('재확인 결과는 첫 검증과 다른 phase로 남는다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const opts = options({ adapter, verifyRepeat: 2 })
  await runLoop(opts)

  const gateResults = readJournal(opts.store).filter(e => e.type === 'gate-result')
  expect(gateResults.map(e => (e as Extract<JournalEvent, { type: 'gate-result' }>).phase)).toEqual([
    'verify',
    'recheck',
  ])
})

test('라운드마다 round-started가 있어 밖에서 진행을 셀 수 있다', async () => {
  const adapter = new FakeAdapter([
    fakeResult(planText('false')),
    fakeResult('1차'),
    fakeResult('2차'),
  ])
  const opts = options({ adapter, budget: 2 })
  const result = await runLoop(opts)
  expect(result.status).toBe('budget-exhausted')

  const events = readJournal(opts.store)
  expect(events.filter(e => e.type === 'round-started').map(e => (e as { round: number }).round))
    .toEqual([1, 2])
  expect(events[events.length - 1]).toMatchObject({ type: 'run-finished', attempts: 2 })
})
