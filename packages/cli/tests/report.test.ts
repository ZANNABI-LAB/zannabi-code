import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureDiff, buildReport } from '../src/report'

async function sh(cmd: string, cwd: string) {
  const proc = Bun.spawn(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

async function repoWithCommit(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-diff-'))
  await sh('git init -q && git config user.email t@t && git config user.name t', cwd)
  writeFileSync(join(cwd, 'tracked.txt'), 'original\n')
  await sh('git add -A && git commit -qm init', cwd)
  return cwd
}

test('신규(미추적) 파일이 diff에 포함된다', async () => {
  const cwd = await repoWithCommit()
  writeFileSync(join(cwd, 'brand-new.ts'), 'export const added = 1\n')

  const diff = await captureDiff(cwd)
  expect(diff).toContain('brand-new.ts')
  expect(diff).toContain('export const added = 1')
})

test('추적 파일의 수정도 함께 담긴다', async () => {
  const cwd = await repoWithCommit()
  writeFileSync(join(cwd, 'tracked.txt'), 'changed\n')
  writeFileSync(join(cwd, 'brand-new.ts'), 'export const added = 1\n')

  const diff = await captureDiff(cwd)
  expect(diff).toContain('tracked.txt')
  expect(diff).toContain('brand-new.ts')
})

test('대상 저장소의 인덱스를 건드리지 않는다', async () => {
  const cwd = await repoWithCommit()
  writeFileSync(join(cwd, 'brand-new.ts'), 'export const added = 1\n')
  writeFileSync(join(cwd, 'staged.txt'), 'staged\n')
  await sh('git add staged.txt', cwd) // 사용자가 일부러 스테이징해 둔 상태

  const before = await sh('git status --porcelain', cwd)
  await captureDiff(cwd)
  const after = await sh('git status --porcelain', cwd)

  expect(after).toBe(before)
  expect(after).toContain('?? brand-new.ts') // 여전히 미추적 — add되지 않았다
  expect(after).toContain('A  staged.txt') // 사용자의 스테이징도 그대로
})

test('.gitignore된 파일은 증거에 들어가지 않는다', async () => {
  const cwd = await repoWithCommit()
  writeFileSync(join(cwd, '.gitignore'), 'build/\n')
  await sh('mkdir -p build && echo junk > build/out.o', cwd)

  const diff = await captureDiff(cwd)
  expect(diff).not.toContain('build/out.o')
})

test('git 저장소가 아니면 조용히 빈 문자열', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-nogit-'))
  writeFileSync(join(cwd, 'a.txt'), 'x')
  expect(await captureDiff(cwd)).toBe('')
})

test('실패 사유가 report.md에 실린다', () => {
  const report = buildReport(
    { status: 'agent-error', attempts: 1, evidence: [], detail: 'exit 1 | result=error_auth' },
    '작업',
  )
  expect(report).toContain('**detail**: exit 1 | result=error_auth')
})

test('사유가 없으면 detail 줄도 없다', () => {
  const report = buildReport({ status: 'success', attempts: 1, evidence: [[]] }, '작업')
  expect(report).not.toContain('detail')
})

test('증거 디렉토리(.zannabi)는 diff에 섞이지 않는다', async () => {
  const cwd = await repoWithCommit()
  writeFileSync(join(cwd, 'brand-new.ts'), 'export const added = 1\n')
  await sh('mkdir -p .zannabi/runs/x && echo evidence > .zannabi/runs/x/report.md', cwd)

  const diff = await captureDiff(cwd)
  expect(diff).toContain('brand-new.ts')
  expect(diff).not.toContain('.zannabi')
})

test('저장소 하위 디렉토리를 cwd로 줘도 저장소 전체를 담는다', async () => {
  const cwd = await repoWithCommit()
  await sh('mkdir -p sub', cwd)
  writeFileSync(join(cwd, 'root-new.ts'), 'export const r = 1\n')

  const diff = await captureDiff(join(cwd, 'sub'))
  expect(diff).toContain('root-new.ts')
})
