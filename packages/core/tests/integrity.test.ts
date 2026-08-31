/**
 * 증거 무결성 (Phase 13).
 *
 * 삭제는 이미 감지하고 있었는데(`store.ts`) **수정은 못 잡았다.** 증거가 대상 저장소 안에
 * 있어 작업하는 에이전트가 쓸 수 있고, 경쟁 도구도 자기 문서에 "verifier can plant evidence"
 * 라고 적어 둔 자리다.
 */
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop } from '../src/loop'
import { RunStore, readJournalText } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'
import { auditJournal, chainHash, JOURNAL_FILENAME } from '../src/journal'

async function runOnce(): Promise<{ dir: string; path: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'integrity-'))
  const store = new RunStore(cwd, '무결성 시험')
  await runLoop({
    intent: '무결성 시험',
    userGates: [{ name: 'test', cmd: 'true', timeoutMs: 60_000, source: 'user' }],
    budget: 1,
    cwd,
    store,
    adapter: new FakeAdapter([fakeResult('계획: 한다.'), fakeResult('했음')]),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  })
  return { dir: store.dir, path: join(store.dir, JOURNAL_FILENAME) }
}

test('손대지 않은 저널은 통과한다', async () => {
  const { dir } = await runOnce()
  const audit = auditJournal(readJournalText(dir))
  expect(audit.ok).toBe(true)
  if (audit.ok) expect(audit.verified).toBeGreaterThan(5)
}, 30_000)

test('게이트 결과를 고치면 잡는다 — 가장 값진 위조의 모양이다', async () => {
  // "테스트를 통과시켜라"는 지시를 받은 에이전트가 할 만한 일이 정확히 이것이다
  const { dir, path } = await runOnce()
  const lines = readJournalText(dir).split('\n').filter(Boolean)
  const i = lines.findIndex(l => l.includes('gate-result'))
  writeFileSync(
    path,
    [...lines.slice(0, i), lines[i].replace('"outcome":"pass"', '"outcome":"fail"'), ...lines.slice(i + 1)].join('\n') + '\n',
  )
  const audit = auditJournal(readJournalText(dir))
  expect(audit.ok).toBe(false)
  if (!audit.ok) {
    expect(audit.kind).toBe('modified')
    expect(audit.detail).toContain('gate-result')
  }
}, 30_000)

test('중간 줄을 지우면 잡는다 — 실패한 라운드를 없던 일로 만드는 모양이다', async () => {
  const { dir, path } = await runOnce()
  const lines = readJournalText(dir).split('\n').filter(Boolean)
  const i = lines.findIndex(l => l.includes('gate-result'))
  writeFileSync(path, [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n') + '\n')
  const audit = auditJournal(readJournalText(dir))
  expect(audit.ok).toBe(false)
  if (!audit.ok) expect(audit.kind).toBe('missing')
}, 30_000)

test('끝에서 잘린 것은 변조가 아니다 — kill -9가 그 모양이다', async () => {
  // 이것을 변조라 부르면 정상적인 크래시가 매번 경고를 내고, 그러면 아무도 안 믿는다
  const { dir, path } = await runOnce()
  const lines = readJournalText(dir).split('\n').filter(Boolean)
  writeFileSync(path, lines.slice(0, -1).join('\n') + '\n{"type":"gate-re')
  expect(auditJournal(readJournalText(dir)).ok).toBe(true)
}, 30_000)

test('체인이 없는 옛 저널은 "확인할 수 없음"이지 "변조됨"이 아니다', () => {
  const audit = auditJournal(
    '{"type":"run-started","at":"t0","contractVersion":1,"runId":"r","intent":"i","cwd":"/x","budget":3}\n',
  )
  expect(audit.ok).toBe(true)
  if (audit.ok) expect('unverifiable' in audit && audit.unverifiable).toBe(true)
})

test('체인을 다시 계산하면 통과한다 — 탐지이지 방지가 아니다', () => {
  // **이 시험은 한계를 못박기 위해 있다.** 통과하는 것이 정상이고, 언젠가 이것이 실패하면
  // 그때는 신고를 올릴 수 있다는 뜻이다. 계약 문서가 이 한계를 명시하는 근거이기도 하다
  const forged = [
    { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
    { type: 'run-finished', at: 't1', status: 'success', attempts: 1 },
  ]
  let prev = ''
  const lines = forged.map((e, i) => {
    const withSeq = { ...e, seq: i + 1 }
    const chain = chainHash(prev, withSeq)
    prev = chain
    return JSON.stringify({ ...withSeq, chain })
  })
  expect(auditJournal(lines.join('\n') + '\n').ok).toBe(true)
})

test('재개가 체인을 이어받는다 — 정상적인 재개가 변조로 보이면 안 된다', async () => {
  // 이것이 깨지면 재개한 실행마다 변조 경고가 뜨고, 그 경고는 한 번만 틀려도 아무도 안 믿는다
  const { dir } = await runOnce()
  const runId = dir.split('/').pop()!
  const projectDir = join(dir, '..', '..', '..')
  const reopened = RunStore.open(projectDir, runId)
  reopened.appendJournal({ type: 'run-resumed', fromRound: 2, completedRounds: 1 })
  const audit = auditJournal(readJournalText(dir))
  expect(audit.ok).toBe(true)
}, 30_000)
