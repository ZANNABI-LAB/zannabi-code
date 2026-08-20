import { test, expect } from 'bun:test'
import type { Evidence } from '../src/goal'
import { recheckSuspects } from '../src/recheck'

const ev = (gate: string, durationMs: number, outcome: 'pass' | 'fail' = 'pass'): Evidence => ({
  gate,
  cmd: './gradlew build',
  source: 'user',
  outcome,
  exitCode: outcome === 'pass' ? 0 : 1,
  stdoutTail: '',
  stderrTail: '',
  durationMs,
  timestamp: '2026-08-20T00:00:00.000Z',
})

test('재확인이 첫 회보다 극단적으로 짧으면 짚는다 — 실측 54.9s → 14.8s', () => {
  expect(recheckSuspects([ev('build', 54_900)], [ev('build', 14_800)])).toEqual([
    { gate: 'build', firstMs: 54_900, recheckMs: 14_800 },
  ])
})

test('정직하게 두 배 빨라진 정도는 짚지 않는다 — 데몬은 실제로 덥혀진다', () => {
  expect(recheckSuspects([ev('build', 20_000)], [ev('build', 11_000)])).toEqual([])
})

test('첫 회가 짧으면 판단하지 않는다 — 기동 편차가 비율을 지배한다', () => {
  expect(recheckSuspects([ev('unit', 400)], [ev('unit', 20)])).toEqual([])
})

test('가장 짧았던 재확인 회차를 근거로 삼는다 — 스킵 신호가 가장 강한 쪽', () => {
  const suspects = recheckSuspects([ev('build', 60_000)], [ev('build', 55_000), ev('build', 9_000)])
  expect(suspects[0].recheckMs).toBe(9_000)
})

test('통과하지 않은 게이트는 대상이 아니다 — 재확인은 통과에만 붙는다', () => {
  expect(recheckSuspects([ev('build', 60_000, 'fail')], [ev('build', 100)])).toEqual([])
})
