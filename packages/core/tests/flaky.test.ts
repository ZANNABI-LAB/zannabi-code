import { test, expect } from 'bun:test'
import { GateSchema, type Evidence } from '../src/goal'
import { recheckWarnings, recheckSuspects } from '../src/flaky'

const gate = (name: string, cmd: string) => GateSchema.parse({ name, cmd })

test('재확인을 끄면 경고하지 않는다', () => {
  expect(recheckWarnings([gate('build', './gradlew build')], 1)).toEqual([])
})

test('캐시를 쓰는 빌드 도구에 clean이 없으면 재확인이 헛돌 수 있다고 짚는다', () => {
  const warnings = recheckWarnings([gate('build', './gradlew build')], 2)
  expect(warnings).toHaveLength(1)
  expect(warnings[0].kind).toBe('advisory') // 실행을 막지는 않는다
  expect(warnings[0].reason).toContain('clean')
})

test('clean 단계가 있으면 경고하지 않는다 — 실전에서 사용자가 이렇게 우회했다', () => {
  // swapve의 실제 게이트. 재확인이 헛도는 것을 겪고 cleanTest를 직접 박았다
  expect(recheckWarnings([gate('build', './gradlew :csms:cleanTest build')], 2)).toEqual([])
  expect(recheckWarnings([gate('t', 'mvn clean verify')], 2)).toEqual([])
  expect(recheckWarnings([gate('t', './gradlew test --rerun-tasks')], 2)).toEqual([])
})

test('캐시를 쓰지 않는 러너는 경고 대상이 아니다', () => {
  expect(recheckWarnings([gate('t', 'bun test')], 2)).toEqual([])
  expect(recheckWarnings([gate('t', 'pytest -q')], 2)).toEqual([])
  expect(recheckWarnings([gate('t', 'cargo test')], 2)).toEqual([])
})

test('도구 이름이 다른 낱말에 섞여 있으면 잡지 않는다', () => {
  // "make"가 경로나 단어 일부로 들어간 경우까지 경고하면 소음이 된다
  expect(recheckWarnings([gate('t', './scripts/makefile-lint.sh')], 2)).toEqual([])
  expect(recheckWarnings([gate('t', 'node tools/nxt-check.js')], 2)).toEqual([])
})

test('여러 게이트 중 해당하는 것만 짚는다', () => {
  const warnings = recheckWarnings(
    [
      gate('build', './gradlew :csms:cleanTest build'),
      gate('conformance', './gradlew conformanceTest'),
      gate('unit', 'bun test'),
    ],
    2,
  )
  expect(warnings.map(w => w.gate)).toEqual(['conformance'])
})

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
