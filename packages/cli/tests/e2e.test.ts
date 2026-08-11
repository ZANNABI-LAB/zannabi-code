import { test, expect } from 'bun:test'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cliPath = join(import.meta.dir, '../src/index.ts')

test('E2E: fake 어댑터로 전체 루프 — 승인 → 실행 → 검증 → 증거', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-'))
  const proc = Bun.spawn(
    ['bun', cliPath, 'run', '테스트 작업', '--cwd', project],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdin: new Response('y\n').body!, // 승인
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(exitCode).toBe(0)
  expect(out).toContain('success')
  const runs = readdirSync(join(project, '.zannabi', 'runs'))
  expect(runs).toHaveLength(1)
  const runDir = join(project, '.zannabi', 'runs', runs[0])
  expect(existsSync(join(runDir, 'plan.md'))).toBe(true)
  expect(existsSync(join(runDir, 'evidence.json'))).toBe(true)
  expect(existsSync(join(runDir, 'report.md'))).toBe(true)
})

test('E2E: 승인 거부 → 종료 코드 1, 실행 없음', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-abort-'))
  const proc = Bun.spawn(
    ['bun', cliPath, 'run', '테스트 작업', '--cwd', project],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdin: new Response('n\n').body!,
      stdout: 'pipe',
    },
  )
  expect(await proc.exited).toBe(1)
})
