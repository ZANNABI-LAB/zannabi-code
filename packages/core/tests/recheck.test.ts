import { test, expect } from 'bun:test'
import type { Evidence } from '../src/goal'
import { recheckSuspects, suppressedByCold } from '../src/recheck'

const ev = (
  gate: string,
  durationMs: number,
  outcome: 'pass' | 'fail' = 'pass',
  cmd = './gradlew build',
): Evidence => ({
  gate,
  cmd,
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
    { gate: 'build', firstMs: 54_900, recheckMs: 14_800, reason: 'ratio' },
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

test('청소를 명시한 명령이 첫 회부터 몇 초에 끝나면 비율과 무관하게 짚는다', () => {
  // 실측: `:csms:cleanTest build` 2075ms → 1159ms. 비율 0.56이라 임계를 안 넘었고
  // 첫 회가 5초 미만이라 비율 축에서도 걸러졌는데, 시험이 한 번도 돈 적 없는 초록이었다.
  // 비율은 "두 번째가 더 빨랐는가"만 묻는다 — 첫 회부터 헛돌면 둘 다 빠르고 비율은 1에 가깝다
  const suspects = recheckSuspects(
    [ev('build', 2_075, 'pass', './gradlew :csms:cleanTest build')],
    [ev('build', 1_159, 'pass', './gradlew :csms:cleanTest build')],
  )
  expect(suspects).toEqual([
    { gate: 'build', firstMs: 2_075, recheckMs: 1_159, reason: 'clean-too-fast' },
  ])
})

test('청소를 명시했어도 실제로 오래 걸렸으면 짚지 않는다 — 일이 일어난 것이다', () => {
  // 이번 실측의 정탐 사례: cleanTest를 붙인 뒤 build가 21.3초로 늘었다
  expect(
    recheckSuspects(
      [ev('build', 21_300, 'pass', './gradlew :csms:cleanTest build')],
      [ev('build', 20_100, 'pass', './gradlew :csms:cleanTest build')],
    ),
  ).toEqual([])
})

test('청소를 명시하지 않은 짧은 명령은 그대로 판단하지 않는다', () => {
  // 링트처럼 원래 빠른 게이트를 이 축으로 잡으면 오탐만 는다
  expect(recheckSuspects([ev('lint', 800, 'pass', 'bun run lint')], [ev('lint', 700)])).toEqual([])
})

test('두 축이 겹치면 비율을 먼저 말한다 — 더 직접적인 신호다', () => {
  const suspects = recheckSuspects(
    [ev('build', 60_000, 'pass', './gradlew clean build')],
    [ev('build', 3_000, 'pass', './gradlew clean build')],
  )
  expect(suspects).toHaveLength(1)
  expect(suspects[0].reason).toBe('ratio')
})

test('재확인이 더 느렸으면 청소 축으로 짚지 않는다 — 일이 일어난 것이다', () => {
  // 2차 실측 오탐: api-auth 첫 회 9769ms → 재확인 11030ms(113%). 첫 회가 임계를 밑돌았지만
  // 재확인이 더 느렸다 = 시험이 실제로 돌았다. 캐시로 스킵됐다면 그럴 수 없다
  expect(
    recheckSuspects(
      [ev('api-auth', 4_000, 'pass', './gradlew :csms:cleanTest test')],
      [ev('api-auth', 4_500, 'pass', './gradlew :csms:cleanTest test')],
    ),
  ).toEqual([])
})

test('정직한 게이트 소요시간대(9~13초)는 청소 축에 걸리지 않는다', () => {
  // 임계가 10초였을 때 그 저장소의 정직한 게이트 한가운데에 있었다. 5초로 내렸다
  expect(
    recheckSuspects(
      [ev('api-auth', 9_769, 'pass', './gradlew :csms:cleanTest test')],
      [ev('api-auth', 9_000, 'pass', './gradlew :csms:cleanTest test')],
    ),
  ).toEqual([])
})

test('차가운 작업 공간의 첫 회는 비율 판정에서 뺀다', () => {
  // 2차 실측 오탐: 워크트리 첫 라운드 build가 콜드 컴파일 포함 52.6s → 재확인 19.7s(37%).
  // 정직하게 빨라진 것이고, 워크트리의 라운드 1은 언제나 이 모양이라 구조적 오탐이다
  const first = [ev('build', 52_635, 'pass', './gradlew build')]
  const again = [ev('build', 19_737, 'pass', './gradlew build')]
  expect(recheckSuspects(first, again, { coldFirstRun: true })).toEqual([])
  // 콜드가 아니면 그대로 짚는다 — 축 자체를 없앤 것이 아니다
  expect(recheckSuspects(first, again)).toHaveLength(1)
})

test('억제가 삼킨 것을 따로 센다 — 경고 0건의 뜻이 갈려야 한다', () => {
  // 2차 실측의 모양: 억제가 실제로 일했다
  const swallowed = suppressedByCold(
    [ev('build', 52_635, 'pass', './gradlew build')],
    [ev('build', 19_737, 'pass', './gradlew build')],
  )
  expect(swallowed).toEqual([
    { gate: 'build', firstMs: 52_635, recheckMs: 19_737, reason: 'ratio' },
  ])

  // 3차 실측의 모양: 워크트리로 돌았지만 비율 0.57이라 애초에 걸릴 자리가 아니었다.
  // 둘 다 "경고 0건"으로 끝나지만 저널에서는 갈린다
  expect(
    suppressedByCold(
      [ev('build', 36_245, 'pass', './gradlew build')],
      [ev('build', 20_649, 'pass', './gradlew build')],
    ),
  ).toEqual([])
})

test('억제와 무관한 축은 삼킨 것으로 세지 않는다', () => {
  // clean-too-fast는 콜드와 무관하게 유효하므로 억제가 끄지 않는다.
  // 그것까지 "삼켰다"고 세면 저널이 없던 억제를 보고하게 된다
  const first = [ev('unit', 2_000, 'pass', './gradlew cleanTest test')]
  const again = [ev('unit', 900, 'pass', './gradlew cleanTest test')]
  expect(recheckSuspects(first, again, { coldFirstRun: true })).toHaveLength(1)
  expect(suppressedByCold(first, again)).toEqual([])
})
