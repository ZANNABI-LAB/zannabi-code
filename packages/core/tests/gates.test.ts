import { test, expect } from 'bun:test'
import { runGate, preflightGates } from '../src/gates'

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

test('사전점검: 판정 불가한 형태(환경변수 대입·서브셸)는 건너뛴다', async () => {
  const gates = [gate('FOO=1 nonexistent-xyz'), gate('$(echo nonexistent-xyz)')]
  expect(await preflightGates(gates, { cwd })).toHaveLength(0)
})
