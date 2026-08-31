import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGate, preflightGates, signalLines, checkableWords } from '../src/gates'
import { GateSchema } from '../src/goal'

const cwd = process.cwd()
const gate = (cmd: string, timeoutMs = 300_000) =>
  ({ name: 'g', cmd, timeoutMs, source: 'suggested' }) as const

// 유예값을 줄여 상한을 명확히 한다. 기본값(1000/500)으로 절대 시간을 단언하면
// bun test가 파일을 동시 실행할 때 타이머가 밀려 플레이키해진다
const fast = { cwd, killGraceMs: 100, ioGraceMs: 50 }
/** 설계상 상한 = timeoutMs + killGraceMs + ioGraceMs. 경합을 감안해 넉넉히 잡는다 */
const upperBound = (timeoutMs: number) => timeoutMs + 100 + 50 + 2000

test('exit 0 → pass', async () => {
  const e = await runGate(gate('true'), { cwd })
  expect(e.outcome).toBe('pass')
  expect(e.exitCode).toBe(0)
})

test('exit 1 → fail (재시도 대상)', async () => {
  const e = await runGate(gate('false'), { cwd })
  expect(e.outcome).toBe('fail')
})

test('명령 없음(exit 127) → error (환경 오류)', async () => {
  const e = await runGate(gate('definitely-not-a-command-xyz'), { cwd })
  expect(e.outcome).toBe('error')
  expect(e.exitCode).toBe(127)
})

test('타임아웃 → error', async () => {
  const e = await runGate(gate('sleep 5', 100), fast)
  expect(e.outcome).toBe('error')
  expect(e.durationMs).toBeLessThan(upperBound(100))
})

test('stdout tail 채증', async () => {
  const e = await runGate(gate('echo hello-evidence'), { cwd })
  expect(e.stdoutTail).toContain('hello-evidence')
  expect(e.durationMs).toBeGreaterThanOrEqual(0)
})

test('타임아웃 시에도 이미 출력된 stdout을 증거로 보존', async () => {
  const e = await runGate(gate('echo progress-line; sleep 5', 200), fast)
  expect(e.outcome).toBe('error')
  expect(e.stdoutTail).toContain('progress-line')
  expect(e.durationMs).toBeLessThan(upperBound(200))
})

test('SIGTERM 무시하는 프로세스 → SIGKILL 에스컬레이션', async () => {
  const e = await runGate(gate("trap '' TERM; sleep 30", 300), fast)
  expect(e.outcome).toBe('error')
  expect(e.exitCode).toBe(137) // 128 + SIGKILL(9) — 실제로 SIGKILL로 죽었음을 확인
  expect(e.durationMs).toBeLessThan(upperBound(300))
})

test('사전점검: 없는 명령 → 경고', async () => {
  const w = await preflightGates([gate('definitely-not-a-command-xyz --flag')], { cwd })
  expect(w).toHaveLength(1)
  expect(w[0].reason).toContain('definitely-not-a-command-xyz')
})

test('사전점검: 있는 명령 → 경고 없음', async () => {
  expect(await preflightGates([gate('echo hi'), gate('sh -c true')], { cwd })).toHaveLength(0)
})

test('사전점검: 통과/불통과는 판정하지 않는다 (실패하는 게이트도 경고 없음)', async () => {
  // TDD에서 작업 전 실패하는 게이트는 정상이다
  expect(await preflightGates([gate('false')], { cwd })).toHaveLength(0)
})

test('사전점검: 정말로 판정 불가한 형태(서브셸)만 건너뛴다', async () => {
  // 무엇이 실행될지 알 수 없는 것만 넘긴다. 모르는 것을 "없다"고 말하면 정상 게이트가
  // --yes에서 거부되고, 사용자는 경고를 읽는 대신 검사 자체를 끄는 쪽으로 간다
  expect(await preflightGates([gate('$(echo nonexistent-xyz)')], { cwd })).toHaveLength(0)
})

test('사전점검: 환경변수 대입 뒤의 명령은 판정한다', async () => {
  // 한때 이것을 "판정 불가"로 넘겼다. 넘길 이유가 없다 — 대입을 벗기면 명령이 보인다.
  // 넘기던 시절에는 --yes가 이 형태를 무검사로 통과시켰다
  const warnings = await preflightGates([gate('FOO=1 nonexistent-xyz')], { cwd })
  expect(warnings).toHaveLength(1)
  expect(warnings[0].kind).toBe('blocking')
})

test('통과 로그에 파묻힌 실패 줄을 추려낸다 — tail을 늘려서는 안 되는 자리다', () => {
  // 실측 상황의 축소판: 통과 로그가 꼬리를 채우고 FAILED가 그 위로 밀린다
  const output = [
    'SwapStationTest > 정상_교환 PASSED',
    'ChargeTest > csms.security.profile=NONE PASSED',
    'LoadAuditTest > 감사로그_적재 FAILED',
    '    org.opentest4j.AssertionFailedError: expected: <3> but was: <5>',
    ...Array.from({ length: 300 }, (_, i) => `OtherTest > case${i} PASSED`),
    'Shutting down ExecutorService',
  ].join('\n')

  const signals = signalLines(output)
  expect(signals).toContain('LoadAuditTest > 감사로그_적재 FAILED')
  expect(signals.some(l => l.includes('AssertionFailedError'))).toBe(true)
  expect(signals.some(l => l.includes('PASSED') && !l.includes('FAILED'))).toBe(false)
})

test('같은 줄이 반복되면 한 번만 싣는다 — 회차마다 같은 스택이 쌓인다', () => {
  const repeated = Array.from({ length: 20 }, () => 'e: Unresolved reference: foo').join('\n')
  expect(signalLines(repeated)).toEqual(['e: Unresolved reference: foo'])
})

test('신호가 없으면 빈 배열 — 못 알아본 형식은 tail에 그대로 남는다', () => {
  expect(signalLines('all good\nnothing to see')).toEqual([])
})

test('통과한 게이트에는 신호를 달지 않는다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-signal-pass-'))
  const gate = GateSchema.parse({ name: 'ok', cmd: 'echo "0 ERROR found"' })
  expect((await runGate(gate, { cwd })).signals).toBeUndefined()
})

test('실패한 게이트의 증거에 신호가 실린다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-signal-fail-'))
  const gate = GateSchema.parse({ name: 'ng', cmd: 'echo "SwapTest FAILED"; exit 1' })
  expect((await runGate(gate, { cwd })).signals).toEqual(['SwapTest FAILED'])
})

test('복합 명령에서 실제로 실행될 명령을 검사한다', () => {
  // **회귀 방지**: 첫 낱말만 보던 시절 `cd x && y`의 검사 대상이 `cd`였고,
  // `command -v cd`는 언제나 성공해서 이 형태가 통째로 통과했다.
  // --yes는 blocking 경고에만 기대므로 그 모드에서 사전점검이 사실상 없었다
  expect(checkableWords('cd frontend && npm test')).toEqual(['npm'])
  expect(checkableWords('NODE_ENV=test bun test')).toEqual(['bun'])
  expect(checkableWords('env FOO=1 ./gradlew check')).toEqual(['./gradlew'])
  expect(checkableWords('bun test | tee out.log')).toEqual(['bun', 'tee'])
})

test('판정할 수 없는 형태는 조용히 넘긴다 — 사전점검이 오탐을 내면 안 된다', () => {
  // 무엇이 실행될지 이 검사로는 알 수 없다. 모르는 것을 "없다"고 말하면
  // 정상 게이트가 --yes에서 거부되고, 사용자는 경고를 읽는 대신 검사를 끈다
  expect(checkableWords('$(echo bun) test')).toEqual([])
  expect(checkableWords('sh -c "a && b"')).toEqual(['sh'])
  expect(checkableWords('true')).toEqual([])
})
