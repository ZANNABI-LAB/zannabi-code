import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureRevision, hashDiff } from '../src/revision'

async function sh(cmd: string, cwd: string) {
  const proc = Bun.spawn(['sh', '-c', cmd], { cwd, stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
}

async function repoWithCommit(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-rev-'))
  await sh(
    'git init -q && git config user.email t@t && git config user.name t && ' +
      'echo hello > a.txt && git add -A && git commit -qm init',
    cwd,
  )
  return cwd
}

test('커밋 위의 워킹트리는 HEAD와 diff 해시로 결박된다', async () => {
  const cwd = await repoWithCommit()
  const clean = await captureRevision(cwd)
  expect(clean.tracked).toBe(true)
  expect(clean.head).toMatch(/^[0-9a-f]{40}$/)
  expect(clean.diffHash).toBe(hashDiff('')) // 변경 없음도 값이 있는 상태다

  writeFileSync(join(cwd, 'a.txt'), 'changed\n')
  const dirty = await captureRevision(cwd)
  expect(dirty.head).toBe(clean.head) // 커밋은 그대로
  expect(dirty.diffHash).not.toBe(clean.diffHash) // 변경분만 달라진다
})

test('같은 내용으로 되돌리면 해시도 되돌아온다 — 정체 판정의 전제', async () => {
  const cwd = await repoWithCommit()
  writeFileSync(join(cwd, 'a.txt'), 'changed\n')
  const first = await captureRevision(cwd)
  writeFileSync(join(cwd, 'a.txt'), 'other\n')
  writeFileSync(join(cwd, 'a.txt'), 'changed\n')
  expect((await captureRevision(cwd)).diffHash).toBe(first.diffHash)
})

test('미추적 신규 파일도 해시에 반영된다', async () => {
  const cwd = await repoWithCommit()
  const before = await captureRevision(cwd)
  writeFileSync(join(cwd, 'new.txt'), 'brand new\n')
  expect((await captureRevision(cwd)).diffHash).not.toBe(before.diffHash)
})

test('git 저장소가 아니면 tracked=false — 없는 것을 "변경 없음"으로 위장하지 않는다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-nogit-'))
  const rev = await captureRevision(cwd)
  expect(rev.tracked).toBe(false)
  expect(rev.diffHash).toBeNull()
  expect(rev.head).toBeNull()
})
