/**
 * **남은 일이 저널에 담기고 화면이 그것을 쓰는지** 본다.
 *
 * 이 저장소에서 일곱 번 반복된 결함 유형이 "저널은 아는데 화면이 안 쓴다"이고,
 * 여기 더해 이번 세션에 사촌이 하나 나왔다 — **화면이 거짓을 쓴다**(끝난 요청에
 * "기다리는 중"이 남아 있었다). 새 축이 생겼으니 두 방향 모두 시험이 있어야 한다.
 */
import { test, expect, describe } from 'bun:test'
import type { LoopResult, Round } from '@zannabi-lab/core'
import { replay, remainingWork } from '@zannabi-lab/core'
import { renderStatus } from '../src/status'
import { buildReport } from '../src/report'

const ev = (gate: string, outcome: 'pass' | 'fail') => ({
  gate,
  cmd: `run ${gate}`,
  source: 'user' as const,
  outcome,
  exitCode: outcome === 'pass' ? 0 : 1,
  stdoutTail: '',
  stderrTail: '',
  durationMs: 5,
  timestamp: '2026-09-01T00:00:00.000Z',
})

const round = (n: number, ...evidence: ReturnType<typeof ev>[]): Round => ({
  round: n,
  revision: { tracked: true, head: 'abc1234', diffHash: `d${n}` },
  evidence,
})

const result = (rounds: Round[]): LoopResult => ({
  status: 'budget-exhausted',
  attempts: rounds.length,
  rounds,
})

describe('리포트', () => {
  test('★ 남은 일을 머리에 적는다 — attempts만으로는 어디까지 갔는지 알 수 없다', () => {
    const md = buildReport(result([round(1, ev('build', 'pass'), ev('lint', 'fail'))]), '작업')
    expect(md).toContain('**remaining**: 1건')
    expect(md).toContain('`lint`')
  })

  test('전부 통과했으면 남은 일 줄이 없다 — 없는 일을 적으면 그 줄이 거짓이 된다', () => {
    const md = buildReport(result([round(1, ev('build', 'pass'))]), '작업')
    expect(md).not.toContain('**remaining**')
  })

  test('★★ 되열린 게이트를 따로 적는다 — 개수로는 드러나지 않는다', () => {
    const md = buildReport(
      result([
        round(1, ev('a', 'fail'), ev('b', 'pass')),
        round(2, ev('a', 'pass'), ev('b', 'fail')),
      ]),
      '작업',
    )
    // 남은 일 수는 1로 그대로인데 뜻이 다르다
    expect(md).toContain('**remaining**: 1건')
    expect(md).toContain('**reopened**')
    expect(md).toContain('고치다 깬 자리')
  })

  test('★ 라운드마다 남은 일이 어떻게 줄었는지 표로 남긴다', () => {
    const md = buildReport(
      result([
        round(1, ev('a', 'fail'), ev('b', 'fail'), ev('c', 'fail')),
        round(2, ev('a', 'pass'), ev('b', 'fail'), ev('c', 'fail')),
        round(3, ev('a', 'pass'), ev('b', 'pass'), ev('c', 'fail')),
      ]),
      '작업',
    )
    expect(md).toContain('## 라운드별 진행')
    // 3건 → 2건 → 1건으로 줄어든 것이 보여야 한다. 예산 소진이라는 사실만으로는
    // 여기까지 왔다는 것을 알 수 없다
    expect(md).toContain('| 1 | `d1` | 3/3 — a, b, c | · | · |')
    expect(md).toContain('| 2 | `d2` | 2/3 — b, c | a | · |')
    expect(md).toContain('| 3 | `d3` | 1/3 — c | b | · |')
  })

  test('라운드가 하나면 표를 그리지 않는다 — 견줄 앞이 없다', () => {
    const md = buildReport(result([round(1, ev('a', 'fail'))]), '작업')
    expect(md).not.toContain('## 라운드별 진행')
  })

  test('★ 리비전과 남은 일이 한 표에 있다 — 남은 일이 그대로여도 파일이 달라졌으면 다른 시도다', () => {
    const md = buildReport(
      result([round(1, ev('a', 'fail')), round(2, ev('a', 'fail'))]),
      '작업',
    )
    // 정체 판정이 게이트 결과와 변경분을 함께 보는 것과 같은 이유로, 사람도 둘을 나란히 봐야 한다
    expect(md).toContain('| 1 | `d1` | 1/1 — a |')
    expect(md).toContain('| 2 | `d2` | 1/1 — a |')
  })
})

describe('status', () => {
  /** 저널 줄을 직접 만들어 재생한다 — 화면이 **저널만 읽어** 그리는지 보는 것이 요점이다 */
  const journal = (open: string[], closed: string[] = [], reopened: string[] = []) =>
    replay([
      {
        type: 'run-started', at: '2026-09-01T00:00:00.000Z', seq: 1, contractVersion: 1,
        runId: 'r', intent: '작업', cwd: '/tmp/x', budget: 4,
        runtime: { plan: 'claude:opus-5', exec: 'claude:opus-5' },
      },
      {
        type: 'round-finished', at: '2026-09-01T00:01:00.000Z', seq: 2,
        round: 1, revision: { tracked: true, head: 'abc', diffHash: 'd1' },
        allPass: open.length === 0, open, closed, reopened,
      },
    ] as never)

  test('★ 저널이 남긴 남은 일을 화면이 쓴다', () => {
    const text = renderStatus(journal(['lint', 'build']))
    expect(text).toContain('남은 일: 2건 (lint, build)')
  })

  test('닫힌 것과 되열린 것을 구별해 적는다', () => {
    const text = renderStatus(journal(['b'], ['a'], ['b']))
    expect(text).toContain('지난 라운드에 닫힘: a')
    expect(text).toContain('되열림: b')
    expect(text).toContain('고치다 깬 자리')
  })

  test('남은 일이 없으면 그 줄이 없다', () => {
    expect(renderStatus(journal([]))).not.toContain('남은 일:')
  })

  test('★ 옛 저널(그 축이 없던 실행)은 남은 일을 말하지 않는다 — 없는 것을 0건이라 하면 안 된다', () => {
    const state = replay([
      {
        type: 'run-started', at: '2026-09-01T00:00:00.000Z', seq: 1, contractVersion: 1,
        runId: 'r', intent: '작업', cwd: '/tmp/x', budget: 4,
        runtime: { plan: 'claude:opus-5', exec: 'claude:opus-5' },
      },
      {
        type: 'round-finished', at: '2026-09-01T00:01:00.000Z', seq: 2,
        round: 1, revision: { tracked: true, head: 'abc', diffHash: 'd1' }, allPass: false,
      },
    ] as never)
    expect(state.remaining).toBeUndefined()
    expect(renderStatus(state)).not.toContain('남은 일:')
  })
})

describe('저널과 화면이 같은 것을 말한다', () => {
  test('★ 저널이 실은 남은 일과 증거에서 다시 센 것이 일치한다', () => {
    // 저널은 루프가 계산해 실은 값이고, 리포트는 증거에서 다시 센다.
    // 두 경로가 갈리면 화면끼리 다른 말을 하게 된다
    const rounds = [round(1, ev('a', 'fail'), ev('b', 'pass')), round(2, ev('a', 'pass'), ev('b', 'fail'))]
    const fromEvidence = remainingWork(rounds)
    expect(fromEvidence.open).toEqual(['b'])
    expect(fromEvidence.reopened).toEqual(['b'])
    const md = buildReport(result(rounds), '작업')
    for (const g of fromEvidence.open) expect(md).toContain(`\`${g}\``)
  })
})
