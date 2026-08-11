import { test, expect } from 'bun:test'
import { runGate } from '../src/gates'

const cwd = process.cwd()
const gate = (cmd: string, timeoutMs = 300_000) => ({ name: 'g', cmd, timeoutMs })

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
  const e = await runGate(gate('sleep 5', 100), { cwd })
  expect(e.outcome).toBe('error')
})

test('stdout tail 채증', async () => {
  const e = await runGate(gate('echo hello-evidence'), { cwd })
  expect(e.stdoutTail).toContain('hello-evidence')
  expect(e.durationMs).toBeGreaterThanOrEqual(0)
})
