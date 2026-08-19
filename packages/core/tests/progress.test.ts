import { test, expect } from 'bun:test'
import type { Evidence, Revision, Round } from '../src/goal'
import { roundSignature, repeatOf, shouldStop } from '../src/progress'

const rev = (diffHash: string | null, tracked = true): Revision => ({
  tracked,
  head: 'c0ffee',
  diffHash,
})
const ev = (outcome: Evidence['outcome'], exitCode: number | null = 1): Evidence => ({
  gate: 'g',
  cmd: 'x',
  source: 'suggested',
  outcome,
  exitCode,
  stdoutTail: '',
  stderrTail: '',
  durationMs: 1,
  timestamp: '',
})
const round = (n: number, diffHash: string | null, outcome: Evidence['outcome'] = 'fail'): Round => ({
  round: n,
  revision: rev(diffHash),
  evidence: [ev(outcome)],
})

test('게이트 결과가 같아도 diff가 달라지면 반복이 아니다', () => {
  const prev = [round(1, 'aaa')]
  const sig = roundSignature(rev('bbb'), [ev('fail')])
  expect(repeatOf(prev, sig)).toBeUndefined()
})

test('diff와 게이트 결과가 모두 같으면 가장 이른 동일 라운드를 가리킨다', () => {
  const prev = [round(1, 'aaa'), round(2, 'aaa'), round(3, 'aaa')]
  const sig = roundSignature(rev('aaa'), [ev('fail')])
  expect(repeatOf(prev, sig)).toBe(1)
})

test('사이에 다른 라운드가 끼면 연속 꼬리만 센다', () => {
  const prev = [round(1, 'aaa'), round(2, 'bbb')]
  const sig = roundSignature(rev('aaa'), [ev('fail')])
  expect(repeatOf(prev, sig)).toBeUndefined()
})

test('실측 반례: 동일한 2라운드는 한계 3에서 중단하지 않는다 (B2)', () => {
  expect(shouldStop([round(1, 'aaa'), round(2, 'aaa')], 3)).toBe(false)
})

test('완전 동일한 3라운드는 중단한다 (C2)', () => {
  expect(shouldStop([round(1, 'aaa'), round(2, 'aaa'), round(3, 'aaa')], 3)).toBe(true)
})

test('리비전을 못 읽으면 감지를 끈다 — 게이트 결과만으로는 판정하지 않는다', () => {
  const untracked = (n: number): Round => ({
    round: n,
    revision: { tracked: false, head: null, diffHash: null },
    evidence: [ev('fail')],
  })
  expect(shouldStop([untracked(1), untracked(2), untracked(3)], 3)).toBe(false)
})

test('한계 0이면 감지를 끈다', () => {
  expect(shouldStop([round(1, 'aaa'), round(2, 'aaa'), round(3, 'aaa')], 0)).toBe(false)
})
