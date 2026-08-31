import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderStatus, renderRunLine } from '../src/status'
import { replay, parseJournal, JOURNAL_FILENAME, listRuns, resolveRun, readJournal, resumability } from '@zannabi-lab/core'

const CLI = join(import.meta.dir, '..', 'src', 'index.ts')

/** fake 어댑터로 실행 하나를 만든다 — 실제 저널을 쓰는 경로를 그대로 탄다 */
async function runOnce(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-status-'))
  const proc = Bun.spawn(['bun', 'run', CLI, 'run', '상태 시험', '--cwd', cwd, '--gate', 'user:true', '--yes'], {
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
  expect(out).toContain('게이트 2/2 통과')
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
  expect(out).toContain('1/4R')
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

test('모르는 계약 판의 저널은 그 사실을 맨 위에 말한다', () => {
  // **회귀 방지**: 저널 첫 줄이 contractVersion을 싣고 replay가 복원하는데, 화면도 재개도
  // 그 값을 한 번도 보지 않았다. replay는 모르는 type을 건너뛰도록 만들어져 있어
  // 더 높은 판에서는 라운드가 통째로 빠져도 화면이 조용했다.
  // 계약 문서 §5가 "판 올리기"를 규정해 놓고 읽는 쪽이 판을 무시하면 규정은 문서에만 있다
  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 99, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  const text = renderStatus(state)
  expect(text).toContain('v99')
  expect(text).toContain('실제보다 적을 수 있습니다')
  // 아래 내용 전부가 의심스러우므로 맨 위여야 한다
  expect(text.split('\n')[0]).toContain('⚠️')
})

test('모르는 판의 저널로는 이어 돌지 않는다', () => {
  // 보는 것과 이어가는 것은 다르다 — 화면은 덜 보여주고 끝나지만,
  // 재개는 놓친 기록 위에 새 라운드를 쌓아 증거를 망친다
  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 99, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
        { type: 'approval-requested', at: 't1', gates: [{ name: 'g', cmd: 'true', timeoutMs: 1000, source: 'user' }], warnings: [] },
        { type: 'approval-resolved', at: 't2', action: 'approve' },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  const can = resumability(state)
  expect(can.ok).toBe(false)
  if (!can.ok) expect(can.reason).toContain('v99')
})

test('격리돼 돈 실행은 결과가 브랜치에 있다고 말한다', () => {
  // 저널의 cwd(워크트리)와 증거가 있는 프로젝트 경로가 갈린다 — 저널이 이미 아는 사실이다.
  // 안 쓰면 워킹트리가 깨끗한데 success인 실행 앞에서 사람이 어리둥절해진다
  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r-1', intent: 'i', cwd: '/tmp/zannabi-wt-x/work', budget: 3 },
        { type: 'run-finished', at: 't1', status: 'success', attempts: 1 },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  expect(renderStatus(state, new Date(), { projectDir: '/home/me/project' })).toContain('브랜치 zannabi/r-1')
  // 같은 자리에서 돌았으면 말하지 않는다 — 격리는 예외이지 기본이 아니다
  expect(renderStatus(state, new Date(), { projectDir: '/tmp/zannabi-wt-x/work' })).not.toContain('격리:')
})

test('화면이 신고의 세 상태를 다르게 적는다', () => {
  // 신고 없음 · 없다고 말함 · N건은 전부 다른 사실이다. 화면에서 같아 보이면
  // 이 기능이 만들어진 이유(회피인지 정말 없는지 구별)가 사라진다
  const journalWith = (extra: object[]) =>
    replay(
      parseJournal(
        [
          { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
          ...extra,
        ]
          .map(e => JSON.stringify(e))
          .join('\n'),
      ),
    )

  const silent = renderStatus(journalWith([{ type: 'claims-reported', at: 't1', round: 1, reported: false, claims: [] }]))
  expect(silent).toContain('신고하지 않았습니다')
  expect(silent).toContain('없다는 뜻이 아닙니다')

  const none = renderStatus(journalWith([{ type: 'claims-reported', at: 't1', round: 1, reported: true, claims: [] }]))
  expect(none).toContain('없다고 신고했습니다')
  expect(none).not.toContain('신고하지 않았습니다')

  const some = renderStatus(
    journalWith([
      {
        type: 'claims-reported', at: 't1', round: 1, reported: true,
        claims: [{ claim: '설정 화면은 여전히 뜬다', basis: 'read', why: 'HTML을 여는 게이트가 없다' }],
      },
    ]),
  )
  expect(some).toContain('1건')
  expect(some).toContain('설정 화면은 여전히 뜬다')
  expect(some).toContain('[read]')

  // 옛 저널에는 신고 요구 자체가 없었다 — 아무 말도 하지 않는다
  expect(renderStatus(journalWith([]))).not.toContain('게이트 밖 주장')
})

test('신고는 마지막 라운드의 것으로 갈아끼운다', () => {
  // 2라운드에서 해소한 불확실을 1라운드의 신고와 함께 쌓아 보여주면,
  // 이미 없어진 것을 남아 있는 것처럼 읽게 된다 (selfChecks 는 반대로 누적한다)
  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
        { type: 'claims-reported', at: 't1', round: 1, reported: true, claims: [{ claim: '1라운드 불확실', basis: 'inferred' }] },
        { type: 'claims-reported', at: 't2', round: 2, reported: true, claims: [] },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  expect(state.claims).toEqual([])
  expect(renderStatus(state)).toContain('없다고 신고했습니다')
  expect(renderStatus(state)).not.toContain('1라운드 불확실')
})

test('변조 흔적은 증거 손실보다 먼저, 눈에 띄게 적는다', () => {
  // 손실은 "증거가 없다", 변조는 "증거가 있는데 믿을 수 없다" — 뒤쪽이 더 나쁘다
  const state = replay(
    parseJournal(
      [{ type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 }]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  const text = renderStatus(state, new Date(), {
    audit: { ok: false, at: 11, kind: 'modified', detail: '11번째 줄(gate-result)이 쓰인 뒤에 고쳐졌습니다' },
  })
  expect(text).toContain('증거 변조 흔적')
  expect(text).toContain('gate-result')

  // 확인할 수 없는 것을 매번 알리면 진짜 경고가 그 소음에 묻힌다
  const old = renderStatus(state, new Date(), { audit: { ok: true, verified: 0, unverifiable: true } })
  expect(old).not.toContain('변조')
})

test('무결성은 통과했을 때도 말한다', () => {
  // **실측 지적**: 통과 시 조용하면 "검사가 돌았고 통과"와 "검사가 안 돌았다"를
  // 사용자가 구별할 수 없다. 무결성은 없을 때가 아니라 **있을 때 신뢰를 만드는 값**이다
  const state = replay(
    parseJournal(
      JSON.stringify({
        type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3,
      }) + '\n',
    ),
  )
  expect(renderStatus(state, new Date(), { audit: { ok: true, verified: 13 } })).toContain(
    '저널 13줄이 쓰인 그대로입니다',
  )
  // 확인할 수 없는 것은 여전히 말하지 않는다 — 매번 반복하면 진짜 경고가 묻힌다
  expect(
    renderStatus(state, new Date(), { audit: { ok: true, verified: 0, unverifiable: true } }),
  ).not.toContain('무결성')
})

test('목록에서도 변조된 실행이 성공처럼 보이지 않는다', () => {
  // 증거 손실은 이미 목록에 찍히는데 변조는 안 찍혀서, 고쳐진 실행이 `✅ success`로 보였다.
  // 목록만 훑고 지나가는 사람에게는 그것이 유일하게 본 화면이다 — 그리고 변조가 손실보다 나쁘다
  const state = replay(
    parseJournal(
      [
        { type: 'run-started', at: 't0', contractVersion: 1, runId: 'r', intent: 'i', cwd: '/x', budget: 3 },
        { type: 'run-finished', at: 't1', status: 'success', attempts: 1 },
      ]
        .map(e => JSON.stringify(e))
        .join('\n'),
    ),
  )
  const forged = renderRunLine('r', state, {
    audit: { ok: false, at: 3, kind: 'modified', detail: '3번째 줄이 고쳐졌습니다' },
  })
  expect(forged).toContain('변조')

  // 정상 실행에는 아무 표시도 붙지 않는다 — 통과를 목록에서까지 떠들면 줄이 길어지기만 한다
  expect(renderRunLine('r', state, { audit: { ok: true, verified: 9 } })).not.toContain('변조')
})
