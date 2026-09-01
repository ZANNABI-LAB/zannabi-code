import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop } from '../src/loop'
import { loopOptions, type PartialOptions } from './_fixture'
import { RunStore } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'
import { JOURNAL_FILENAME, parseJournal } from '../src/journal'
import { replay, resumability } from '../src/replay'

const planText = (cmd: string) =>
  `계획: 한다.\n\`\`\`json\n{"gates":[{"name":"g","cmd":"${cmd}"}]}\n\`\`\``

const options = (p: PartialOptions) => loopOptions('replay', p)

/** 실제 실행의 저널을 그대로 읽는다 — 합성 이벤트로만 테스트하면 어휘가 실물과 갈린다 */
function journalOf(store: RunStore): string {
  return readFileSync(join(store.dir, JOURNAL_FILENAME), 'utf-8')
}

/** kill -9를 흉내낸다: 저널을 n번째 줄까지만 남기고, 마지막 줄은 반쯤 자른다 */
function truncate(text: string, lines: number, half = false): string {
  const kept = text.split('\n').filter(Boolean).slice(0, lines)
  const body = kept.join('\n')
  return half ? body.slice(0, body.length - 12) : body + '\n'
}

test('끝난 실행을 재생하면 판정과 라운드가 그대로 나온다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const opts = options({ adapter })
  const result = await runLoop(opts)

  const state = replay(parseJournal(journalOf(opts.store)))
  expect(state.phase).toBe('finished')
  expect(state.status).toBe('success')
  expect(state.attempts).toBe(result.attempts)
  expect(state.runId).toBe(opts.store.runId)
  expect(state.intent).toBe('테스트 작업')
  expect(state.rounds).toHaveLength(1)
  expect(state.rounds[0].allPass).toBe(true)
  expect(state.rounds[0].evidence[0].gate).toBe('g')
  expect(state.gates.map(g => g.name)).toEqual(['g'])
})

test('승인 대기 중 끊긴 저널은 멈춰 죽은 것과 구분된다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const opts = options({ adapter })
  await runLoop(opts)

  const all = parseJournal(journalOf(opts.store))
  const upToRequest = all.slice(0, all.findIndex(e => e.type === 'approval-requested') + 1)
  const state = replay(upToRequest)

  expect(state.phase).toBe('awaiting-approval')
  // 이 구분이 없으면 승인을 기다리는 실행과 죽은 실행이 둘 다 "이벤트 끊김"으로만 보인다
  expect(state.gates).toHaveLength(1)
  expect(resumability(state).ok).toBe(false)
})

test('게이트 도중 끊긴 라운드는 완료로 치지 않되, 진행 상태를 덮지 않는다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const opts = options({ adapter })
  await runLoop(opts)

  const all = parseJournal(journalOf(opts.store))
  const cut = all.slice(0, all.findIndex(e => e.type === 'round-finished'))
  const state = replay(cut)

  // 예전에는 여기서 phase를 interrupted로 덮었는데, open은 정상 실행 중에도 언제나 참이라
  // 살아 있는 실행이 전부 "끊김"으로 보였다. 아는 것(어디까지 왔는가)만 말한다
  expect(state.phase).not.toBe('interrupted')
  expect(state.partialRound).toBe(1)
  // 절반만 검증된 라운드를 완료로 치면 돌지 않은 게이트가 판정에서 빠진다 = 거짓 초록
  expect(state.rounds).toHaveLength(0)
  const can = resumability(state)
  expect(can).toEqual({ ok: true, nextRound: 1 })
})

test('실행 턴의 지출은 라운드가 끊겨도 재생에 남는다 — 상한이 리셋되지 않는다', async () => {
  const exec = {
    ok: true as const,
    sessionId: 'sess-9',
    finalText: '했음',
    events: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 1.25, turns: 1 },
  }
  const adapter = new FakeAdapter([fakeResult(planText('true')), exec])
  const opts = options({ adapter })
  await runLoop(opts)

  const all = parseJournal(journalOf(opts.store))
  // 실행 턴 직후 · 게이트 결과가 나오기 전에서 자른다
  const cut = all.slice(0, all.findIndex(e => e.type === 'gate-result'))
  const state = replay(cut)

  expect(state.spentUsd).toBe(1.25)
  expect(state.usage.exec.costUsd).toBe(1.25)
  expect(state.sessionId).toBe('sess-9')
})

test('마지막 줄이 반쯤 잘려도 앞의 상태는 온전히 재생된다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const opts = options({ adapter })
  await runLoop(opts)

  const text = journalOf(opts.store)
  const lines = text.split('\n').filter(Boolean).length
  const state = replay(parseJournal(truncate(text, lines - 1, true)))

  // 잘린 줄 하나를 잃을 뿐 실행이 통째로 못 읽히지는 않는다
  expect(state.runId).toBe(opts.store.runId)
  expect(state.phase).not.toBe('finished')
})

test('cost-updated는 누적값이므로 재생해도 지출이 불어나지 않는다', async () => {
  const exec = {
    ok: true as const,
    finalText: '했음',
    events: [],
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.4, turns: 1 },
  }
  const adapter = new FakeAdapter([fakeResult(planText('false')), exec, exec])
  const opts = options({ adapter, budget: 2 })
  await runLoop(opts)

  const events = parseJournal(journalOf(opts.store))
  const state = replay(events)
  // cost-updated가 여러 줄 있어도 마지막 누적값 하나만 남아야 한다
  expect(events.filter(e => e.type === 'cost-updated').length).toBeGreaterThan(1)
  expect(state.spentUsd).toBeCloseTo(0.8, 5)
})

test('이미 끝난 실행과 예산을 다 쓴 실행은 재개 거부 사유가 다르다', async () => {
  const adapter = new FakeAdapter([fakeResult(planText('true')), fakeResult('했음')])
  const opts = options({ adapter })
  await runLoop(opts)
  const done = replay(parseJournal(journalOf(opts.store)))

  const finished = resumability(done)
  expect(finished.ok).toBe(false)
  if (!finished.ok) expect(finished.reason).toContain('success')

  const exhausted = resumability({ ...done, phase: 'interrupted', status: undefined })
  expect(exhausted.ok).toBe(true) // 예산 3에 라운드 1 — 아직 남았다

  const noBudget = resumability({ ...done, phase: 'interrupted', status: undefined, budget: 1 })
  expect(noBudget.ok).toBe(false)
  if (!noBudget.ok) expect(noBudget.reason).toContain('예산')
})

test('저널이 아닌 파일을 읽으면 그렇다고 말한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zannabi-notjournal-'))
  const path = join(dir, 'x.jsonl')
  writeFileSync(path, '{"hello":"world"}\nplain text\n')
  const state = replay(parseJournal(readFileSync(path, 'utf-8')))

  expect(state.runId).toBeUndefined()
  const can = resumability(state)
  expect(can.ok).toBe(false)
  if (!can.ok) expect(can.reason).toContain('run-started')
})
