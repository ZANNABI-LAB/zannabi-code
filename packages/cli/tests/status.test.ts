import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderStatus, renderRunLine } from '../src/status'
import { replay, parseJournal, JOURNAL_FILENAME, listRuns, resolveRun, readJournal } from '@zannabi-lab/core'

const CLI = join(import.meta.dir, '..', 'src', 'index.ts')

/** fake 어댑터로 실행 하나를 만든다 — 실제 저널을 쓰는 경로를 그대로 탄다 */
async function runOnce(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-status-'))
  const proc = Bun.spawn(['bun', 'run', CLI, 'run', '상태 시험', '--cwd', cwd, '--yes'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
  return cwd
}

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out, err }
}

test('status는 저널만 읽어 끝난 실행을 재구성한다', async () => {
  const cwd = await runOnce()
  const runId = listRuns(cwd)[0]

  const { code, out } = await cli(['status', runId, '--cwd', cwd])
  expect(code).toBe(0)
  expect(out).toContain(runId)
  expect(out).toContain('종료 (success)')
  expect(out).toContain('게이트 1/1 통과')
}, 20_000)

test('status는 report.md나 evidence.json 없이도 답한다', async () => {
  // 계약의 핵심 주장 — 저널 한 파일이면 상태가 나온다. 파생 파일을 지우고 확인한다
  const cwd = await runOnce()
  const found = resolveRun(cwd)
  expect(found.ok).toBe(true)
  if (!found.ok) return
  for (const name of ['report.md', 'evidence.json', 'goal.json'])
    writeFileSync(join(found.dir, name), '')

  const { code, out } = await cli(['status', found.runId, '--cwd', cwd])
  expect(code).toBe(0)
  expect(out).toContain('종료 (success)')
}, 20_000)

test('인자 없는 status는 실행 목록을 한 줄씩 준다', async () => {
  const cwd = await runOnce()
  const { code, out } = await cli(['status', '--cwd', cwd])
  expect(code).toBe(0)
  expect(out).toContain('✅')
  expect(out).toContain('1/3R')
}, 20_000)

test('없는 실행을 물으면 후보를 함께 보여준다', async () => {
  const cwd = await runOnce()
  const { code, err } = await cli(['status', '없는이름', '--cwd', cwd])
  expect(code).toBe(1)
  expect(err).toContain('그런 실행이 없습니다')
  // "없습니다"만 주면 사용자에게 다음 수가 없다
  expect(err).toContain(listRuns(cwd)[0])
}, 20_000)

test('중단된 실행은 재개 안내와 함께, 단정하지 않고 보고된다', async () => {
  const cwd = await runOnce()
  const found = resolveRun(cwd)
  if (!found.ok) throw new Error('run not found')

  // kill -9 흉내: round-finished 앞에서 자른다
  const all = parseJournal(readFileSync(join(found.dir, JOURNAL_FILENAME), 'utf-8'))
  const cut = all.slice(0, all.findIndex(e => e.type === 'round-finished'))
  writeFileSync(join(found.dir, JOURNAL_FILENAME), cut.map(e => JSON.stringify(e)).join('\n') + '\n')

  const { code, out } = await cli(['status', found.runId, '--cwd', cwd])
  expect(code).toBe(0)
  expect(out).toContain('진행 중')
  // 살아 있을 수도 있는 실행에 재개를 무조건 권하지 않는다 — 조건을 붙인다
  expect(out).toContain('러너가 이미 멎었다면')
  // 저널은 프로세스 생사를 모른다 — 모르는 것을 아는 척하면 안 된다
  expect(out).toContain('저널이 말할 수 없습니다')
}, 20_000)

test('저널 없는 옛 실행을 "끊김"이라 부르지 않는다', async () => {
  // 저널을 쓰기 전 판으로 돌린 실행이 남아 있는 저장소가 실제로 있다(실전에서 24건).
  // 그것들은 대개 정상 종료됐다 — 재생할 이벤트가 없는 것과 도중에 끊긴 것은 다른 사실이다
  const cwd = await runOnce()
  const found = resolveRun(cwd)
  if (!found.ok) throw new Error('run not found')
  await Bun.$`rm ${join(found.dir, JOURNAL_FILENAME)}`.quiet()

  const { code, out } = await cli(['status', '--cwd', cwd])
  expect(code).toBe(0)
  expect(out).toContain('저널 없음')
  expect(out).not.toContain('이벤트가 끊김')
}, 20_000)

test('증거 손실은 상태 화면에서 판정보다 먼저 눈에 띈다', () => {
  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
        { type: 'evidence-lost', at: 't1', target: '(실행 디렉토리 전체)' },
        { type: 'run-finished', at: 't2', status: 'evidence-lost', attempts: 1 },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  const text = renderStatus(state)
  expect(text).toContain('증거로 뒷받침되지 않습니다')
  expect(renderRunLine('r', state)).toContain('증거손실')
})

test('비용 미보고를 0원으로 적지 않는다', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-status-cost-'))
  expect(readJournal(join(cwd, 'nope'))).toEqual([])

  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd, budget: 3 },
        {
          type: 'cost-updated',
          at: 't1',
          plan: { inputTokens: 1, outputTokens: 1, turns: 1 },
          exec: { inputTokens: 1, outputTokens: 1, turns: 1 },
          coverage: 'none',
        },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  const text = renderStatus(state)
  expect(text).toContain('보고되지 않음')
  expect(text).not.toContain('$0.00')
})

test('한 번에 돈 실행과 이어 돈 실행을 화면이 구분한다', () => {
  // 저널은 run-resumed로 알고 있는데 화면이 안 쓰면, 이 실행이 죽었다 이어 돈 것인지
  // 읽는 사람이 알 수 없다. 6차 실측의 report.md에 재개 흔적이 한 글자도 없었다
  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
        { type: 'round-started', at: 't1', round: 1 },
        { type: 'run-resumed', at: 't2', fromRound: 1, completedRounds: 0 },
        { type: 'run-finished', at: 't3', status: 'success', attempts: 1 },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  expect(state.resumeCount).toBe(1)
  expect(renderStatus(state)).toContain('재개: 1회')
  expect(renderRunLine('r', state)).toContain('재개1')

  // 한 번에 돈 실행에는 아무 말도 붙지 않는다
  const once = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
        { type: 'run-finished', at: 't1', status: 'success', attempts: 1 },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  expect(renderStatus(once)).not.toContain('재개')
  expect(renderRunLine('r', once)).not.toContain('재개')
})

test('소요시간을 화면이 말한다 — 재개한 실행은 멎어 있던 시간을 밝힌다', () => {
  const journal = (extra: object[]) =>
    replay(
      parseJournal(
        [
          { type: 'run-started', at: '2026-08-23T00:00:00.000Z', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
          ...extra,
          { type: 'run-finished', at: '2026-08-23T00:06:00.000Z', status: 'success', attempts: 1 },
        ]
          .map(e => JSON.stringify(e))
          .join('\n'),
      ),
    )

  // 한 번에 돈 실행 — 첫 이벤트부터 마지막까지가 그대로 소요시간이다
  expect(renderStatus(journal([]))).toContain('소요: 6분')

  // 재개한 실행 — 저널은 프로세스가 죽어 있던 구간을 모른다. 그것을 "돈 시간"이라
  // 부르면 거짓이므로 단서를 붙인다
  const resumed = renderStatus(
    journal([{ type: 'run-resumed', at: '2026-08-23T00:05:00.000Z', fromRound: 1, completedRounds: 0 }]),
  )
  expect(resumed).toContain('소요: 6분 (멎어 있던 시간 포함)')
})
