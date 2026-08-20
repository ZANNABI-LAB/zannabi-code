import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Round } from '@zannabi-lab/core'
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
    { status: 'agent-error', attempts: 1, rounds: [], detail: 'exit 1 | result=error_auth' },
    '작업',
  )
  expect(report).toContain('**detail**: exit 1 | result=error_auth')
})

test('사유가 없으면 detail 줄도 없다', () => {
  const report = buildReport(
    { status: 'success', attempts: 1, rounds: [round(1, 'aaa')] },
    '작업',
  )
  expect(report).not.toContain('detail')
})

const round = (n: number, diffHash: string, repeatOf?: number): Round => ({
  round: n,
  revision: { tracked: true, head: 'c0ffee', diffHash },
  evidence: [],
  repeatOf,
})

test('라운드가 여럿이면 라운드별 diff 해시와 반복 여부가 실린다', () => {
  const report = buildReport(
    {
      status: 'no-progress',
      attempts: 3,
      rounds: [round(1, 'aaa'), round(2, 'bbb'), round(3, 'bbb', 2)],
    },
    '작업',
  )
  expect(report).toContain('- **head**: `c0ffee`')
  expect(report).toContain('1: diff `aaa`')
  expect(report).toContain('3: diff `bbb`, gates 0/0 pass — 라운드 2과 동일')
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

test('사용량은 계획/실행으로 나뉘고, 비용을 안 주는 러너는 0원이 아니라 -로 남는다', () => {
  const report = buildReport(
    {
      status: 'success',
      attempts: 1,
      rounds: [round(1, 'aaa')],
      usage: {
        plan: { inputTokens: 1000, outputTokens: 200, costUsd: 0.25, turns: 1 },
        exec: { inputTokens: 500, outputTokens: 100, turns: 2 },
      },
    },
    '작업',
  )
  expect(report).toContain('| plan | 1 | 1,000 | 0 | 200 | $0.2500 |')
  expect(report).toContain('| exec | 2 | 500 | 0 | 100 | - |')
  // 한쪽만 비용을 알면 합계도 아는 만큼만 적는다
  expect(report).toContain('| 합계 | 3 | 1,500 | 0 | 300 | $0.2500 |')
})

test('게이트 줄에 출처와 flaky 표시가 붙는다', () => {
  const evidence = [
    {
      gate: 'u', cmd: 'true', source: 'user' as const, outcome: 'pass' as const, exitCode: 0,
      stdoutTail: '', stderrTail: '', durationMs: 1, timestamp: '',
    },
  ]
  const report = buildReport(
    {
      status: 'flaky-gate',
      attempts: 1,
      rounds: [{ ...round(1, 'aaa'), evidence, flaky: ['u'] }],
    },
    '작업',
  )
  expect(report).toContain('사용자')
  expect(report).toContain('🎲 flaky')
})

test('밀려난 제안 게이트가 리포트에 남는다 — 실행된 명령과 나란히', () => {
  const report = buildReport(
    {
      status: 'success',
      attempts: 1,
      rounds: [],
      dropped: [
        {
          name: 'build',
          cmd: './gradlew :csms:cleanTest build',
          reason: 'name-collision',
          keptCmd: './gradlew build',
        },
        { name: 'lint', cmd: 'bun lint', reason: 'rejected' },
      ],
    },
    '테스트',
  )
  expect(report).toContain('## 반영되지 않은 제안 게이트')
  expect(report).toContain('cleanTest build')
  expect(report).toContain('실제 실행: `./gradlew build`')
  expect(report).toContain('--reject-suggested로 받지 않음')
})

test('버려진 제안이 없으면 그 절은 아예 나오지 않는다', () => {
  const report = buildReport({ status: 'success', attempts: 1, rounds: [], dropped: [] }, '테스트')
  expect(report).not.toContain('반영되지 않은 제안 게이트')
})

test('in 열이 캐시와 겹치지 않는다는 사실을 표에 밝힌다', () => {
  const report = buildReport(
    {
      status: 'success',
      attempts: 1,
      rounds: [round(1, 'aaa')],
      usage: {
        plan: { inputTokens: 61_454, cachedInputTokens: 504_576, outputTokens: 100, turns: 1 },
        exec: { inputTokens: 15, cachedInputTokens: 307_180, outputTokens: 50, turns: 1 },
      },
    },
    '작업',
  )
  expect(report).toContain('| 턴 | 횟수 | in(new) | cached | out | cost |')
  // 정규화된 값끼리라 합계 행이 뜻을 가진다
  expect(report).toContain('| 합계 | 2 | 61,469 | 811,756 | 150 | - |')
  expect(report).toContain('총 입력은 둘의 합이다')
})

test('재확인이 헛돌았을 정황이 리포트에 숫자로 남는다', () => {
  const suspect = { gate: 'build', firstMs: 54_900, recheckMs: 14_800 }
  const report = buildReport(
    {
      status: 'success',
      attempts: 1,
      rounds: [{ ...round(1, 'aaa'), recheckSuspects: [suspect] }],
    },
    '작업',
  )
  expect(report).toContain('## 재확인이 헛돌았을 수 있는 게이트')
  expect(report).toContain('첫 회 54900ms → 재확인 14800ms (27%)')
  expect(report).toContain('판정은 사람이 한다')
})

test('실행 중 게이트가 사라지면 리포트가 그것을 세운다', () => {
  const report = buildReport({ status: 'success', attempts: 1, rounds: [round(1, 'aaa')] }, '작업', {
    removed: false,
    created: false,
    droppedGates: ['recovery'],
    addedGates: ['basic-auth'],
    rewrittenGates: [],
  })
  expect(report).toContain('## 실행 중 .zannabi.json이 바뀌었다')
  expect(report).toContain('게이트 `recovery`가 사라졌다')
  expect(report).toContain('게이트 `basic-auth`가 추가됐다')
  expect(report).toContain('작업하는 쪽이 합격선을 낮출 수 있다면 그것은 합격선이 아니다')
})

test('설정이 안 바뀌면 그 절은 나오지 않는다', () => {
  const report = buildReport({ status: 'success', attempts: 1, rounds: [round(1, 'aaa')] }, '작업')
  expect(report).not.toContain('.zannabi.json이 바뀌었다')
})
