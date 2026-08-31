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

test('게이트 줄에 출처와 재현 실패 표시가 붙는다', () => {
  const evidence = [
    {
      gate: 'u', cmd: 'true', source: 'user' as const, outcome: 'pass' as const, exitCode: 0,
      stdoutTail: '', stderrTail: '', durationMs: 1, timestamp: '',
    },
  ]
  const report = buildReport(
    {
      status: 'unreproduced-pass',
      attempts: 1,
      rounds: [{ ...round(1, 'aaa'), evidence, unreproduced: ['u'] }],
    },
    '작업',
  )
  expect(report).toContain('사용자')
  expect(report).toContain('🔁 재현 안 됨')
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
  const suspect = { gate: 'build', firstMs: 54_900, recheckMs: 14_800, reason: 'ratio' as const }
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

test('두 사유를 섞지 않는다 — 재확인이 더 느린 행에 "빨리 끝났다"고 적지 않는다', () => {
  // 2차 실측에서 113% 행(재확인이 더 느림)에 "훨씬 빨리 끝났다"가 붙었다.
  // 데이터에 reason이 있는데 화면이 안 쓴 결과다
  const report = buildReport(
    {
      status: 'success',
      attempts: 1,
      rounds: [
        {
          ...round(1, 'aaa'),
          recheckSuspects: [
            { gate: 'build', firstMs: 2_075, recheckMs: 1_159, reason: 'clean-too-fast' as const },
          ],
        },
      ],
    },
    '작업',
  )
  expect(report).toContain('청소를 명시했는데 첫 회가 2075ms에 끝났다')
  expect(report).toContain('**처음부터** 일이 일어나지 않았을 수 있다')
  // 비율 축의 설명문은 이 행에 붙지 않는다
  expect(report).not.toContain('훨씬 빨리 끝났다')
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

test('실패한 게이트의 신호 줄이 리포트에 딸려 나온다', () => {
  const evidence = [
    {
      gate: 'build', cmd: './gradlew build', source: 'user' as const,
      outcome: 'fail' as const, exitCode: 1,
      stdoutTail: '', stderrTail: '', durationMs: 10, timestamp: 't',
      signals: ['LoadAuditTest > 감사로그_적재 FAILED'],
    },
  ]
  const report = buildReport(
    { status: 'budget-exhausted', attempts: 1, rounds: [{ ...round(1, 'aaa'), evidence }] },
    '작업',
  )
  expect(report).toContain('LoadAuditTest > 감사로그_적재 FAILED')
})

test('재확인에서 갈린 게이트는 회차별 결과가 남는다 — 간헐인지 결정론인지 갈린다', () => {
  const base = {
    gate: 'build', cmd: './gradlew build', source: 'user' as const,
    stdoutTail: '', stderrTail: '', durationMs: 10, timestamp: 't',
  }
  const report = buildReport(
    {
      status: 'unreproduced-pass',
      attempts: 1,
      rounds: [{
        ...round(1, 'aaa'),
        evidence: [{ ...base, outcome: 'pass' as const, exitCode: 0 }],
        unreproduced: ['build'],
        recheck: [
          { ...base, outcome: 'fail' as const, exitCode: 1, signals: ['SwapMetricsTest FAILED'] },
          { ...base, outcome: 'fail' as const, exitCode: 1 },
        ],
      }],
    },
    '작업',
  )
  expect(report).toContain('## 재확인 회차별 결과')
  expect(report).toContain('첫 회 ✅ → 재확인 ❌ ❌')
  expect(report).toContain('SwapMetricsTest FAILED')
  expect(report).toContain('이전 실행이 남긴 상태를 의심한다')
})

test('정체 감지가 죽은 조합이면 리포트 머리에 세운다', () => {
  const report = buildReport(
    { status: 'budget-exhausted', attempts: 3, rounds: [round(1, 'aaa')], stallDead: true },
    '작업',
  )
  expect(report).toContain('정체 감지 꺼짐')
})

test('재개한 실행은 그 사실과 비용의 한계를 함께 적는다', () => {
  // attempts만으로는 한 번에 돈 실행과 갈리지 않는다. 그리고 죽은 턴이 쓴 토큰은
  // 어댑터가 턴 완료 시점에 보고하므로 어디에도 안 잡힌다 — 비용이 실제보다 적다
  const report = buildReport(
    { status: 'success', attempts: 1, rounds: [round(1, 'aaa')] },
    '작업',
    undefined,
    undefined,
    { resumeCount: 1 },
  )
  expect(report).toContain('**resumed**: 1회 이어받음')
  expect(report).toContain('빠져 있다')

  // 한 번에 돈 실행에는 붙지 않는다 — 없는 경고를 다는 것도 거짓이다
  const once = buildReport(
    { status: 'success', attempts: 1, rounds: [round(1, 'aaa')] },
    '작업',
  )
  expect(once).not.toContain('resumed')
})

test('리포트가 소요시간을 적는다 — 조합 비교의 축 셋 중 하나다', () => {
  const report = buildReport(
    { status: 'success', attempts: 1, rounds: [round(1, 'aaa')] },
    '작업',
    undefined,
    undefined,
    { elapsedMs: 372_000 },
  )
  expect(report).toContain('**elapsed**: 6분')
  expect(report).not.toContain('멎어 있던')

  // 재개한 실행에서는 죽어 있던 구간이 포함된다는 것을 밝힌다
  const resumed = buildReport(
    { status: 'success', attempts: 1, rounds: [round(1, 'aaa')] },
    '작업',
    undefined,
    undefined,
    { resumeCount: 1, elapsedMs: 372_000 },
  )
  expect(resumed).toContain('멎어 있던 시간 포함')
})

test('자기 확인은 시도가 아니라 실행을 센다', () => {
  const base = { status: 'success' as const, attempts: 1, rounds: [round(1, 'aaa')] }

  // 전부 돌았다
  expect(
    buildReport(base, '작업', undefined, undefined, {
      selfChecks: [{ cmd: 'bun test' }, { cmd: './gradlew build' }],
    }),
  ).toContain('**self-checks**: 2건 (에이전트가 스스로 돌림 — 판정 아님)')

  // 실측 1차의 모양 — 시도는 있었는데 전부 거부됐다. "13건"으로 적으면 거짓말이다
  const denied = buildReport(base, '작업', undefined, undefined, {
    selfChecks: [
      { cmd: './gradlew test --tests "*A*"', denied: true },
      { cmd: './gradlew build', denied: true },
    ],
  })
  expect(denied).toContain('시도 2건 중 **0건만 실행**')
  expect(denied).toContain('이 턴은 검증 없이 썼다')
  // 무엇이 막혔는지 보여야 원인 규명이 된다 — 없으면 "왜 컴파일도 안 하고 썼나"에서 멈춘다
  expect(denied).toContain('./gradlew test --tests "*A*"')

  // 아예 안 돌린 것도 사실대로
  expect(buildReport(base, '작업', undefined, undefined, { selfChecks: [] })).toContain(
    '0건 — 에이전트가 검증 없이 썼다',
  )
})

test('리포트가 게이트 밖 주장을 적는다 — 세 상태를 갈라서', () => {
  // report.md 는 증거의 일부다. 나중에 읽는 사람이 게이트 결과만 보면 초록만 보는데,
  // 게이트가 덮지 않은 자리는 초록에 나타나지 않는다 — 실측에서 에이전트가 게이트 밖
  // 사실을 단언했고 그것이 틀렸는데, 리포트 어디에도 그 표시가 없었다
  const base = { status: 'success' as const, attempts: 1, rounds: [] }

  const silent = buildReport(base, '작업', undefined, undefined, { claimsReported: false })
  expect(silent).toContain('신고 없음')
  expect(silent).toContain('뜻이 아닙니다')

  const none = buildReport(base, '작업', undefined, undefined, { claimsReported: true, claims: [] })
  expect(none).toContain('없다고 신고함')

  const some = buildReport(base, '작업', undefined, undefined, {
    claimsReported: true,
    claims: [{ claim: '문서만 바꿨다', basis: 'read', why: '문서를 검사하는 게이트가 없다' }],
  })
  expect(some).toContain('1건')
  expect(some).toContain('[read] 문서만 바꿨다')
  expect(some).toContain('문서를 검사하는 게이트가 없다')

  // 옛 실행에는 신고 요구가 없었다 — 없는 줄을 지어내지 않는다
  expect(buildReport(base, '작업')).not.toContain('unverified-claims')
})
