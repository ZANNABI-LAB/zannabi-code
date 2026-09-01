import { describe, expect, test } from 'bun:test'
import { openGates, remainingWork } from '../src/remaining'
import type { Evidence, Round } from '../src/goal'

const ev = (gate: string, outcome: 'pass' | 'fail' | 'error'): Evidence => ({
  gate,
  cmd: `run ${gate}`,
  source: 'user',
  outcome,
  exitCode: outcome === 'pass' ? 0 : 1,
  stdoutTail: '',
  stderrTail: '',
  durationMs: 1,
  timestamp: '2026-09-01T00:00:00.000Z',
})

const round = (n: number, ...evidence: Evidence[]): Round => ({
  round: n,
  revision: { tracked: true, head: 'abc', diffHash: `d${n}` },
  evidence,
})

describe('남은 일', () => {
  test('통과하지 못한 게이트가 남은 일이다', () => {
    expect(openGates([ev('a', 'pass'), ev('b', 'fail'), ev('c', 'pass')])).toEqual(['b'])
  })

  test('error도 남은 일이다 — 돌지 못한 게이트는 통과한 게이트가 아니다', () => {
    expect(openGates([ev('a', 'error'), ev('b', 'pass')])).toEqual(['a'])
  })

  test('전부 통과하면 남은 일이 없다', () => {
    expect(remainingWork([round(1, ev('a', 'pass'))])).toEqual({ open: [], closed: [], reopened: [] })
  })

  test('★ 첫 라운드는 무엇도 닫은 것이 아니다 — 비교할 앞이 없다', () => {
    // 비교 대상이 없을 때 "전부 새로 닫았다"고 하면 첫 라운드가 늘 진전으로 보인다
    expect(remainingWork([round(1, ev('a', 'pass'), ev('b', 'fail'))])).toEqual({
      open: ['b'],
      closed: [],
      reopened: [],
    })
  })

  test('★ 라운드 사이에 무엇이 닫혔는지 말한다 — 이것이 없으면 진전이 화면에 안 남는다', () => {
    const work = remainingWork([
      round(1, ev('a', 'fail'), ev('b', 'fail')),
      round(2, ev('a', 'pass'), ev('b', 'fail')),
    ])
    expect(work).toEqual({ open: ['b'], closed: ['a'], reopened: [] })
  })

  test('★★ 고치다 깬 자리를 회귀로 잡는다 — "남은 일 1건"이 뭉개던 두 경우를 가른다', () => {
    const work = remainingWork([
      round(1, ev('a', 'fail'), ev('b', 'pass')),
      round(2, ev('a', 'pass'), ev('b', 'fail')),
    ])
    // 하나를 풀면서 다른 하나를 깼다 — 남은 일 수는 그대로 1이지만 뜻이 완전히 다르다
    expect(work.open).toEqual(['b'])
    expect(work.closed).toEqual(['a'])
    expect(work.reopened).toEqual(['b'])
  })

  test('처음부터 못 푼 것은 회귀가 아니다', () => {
    const work = remainingWork([
      round(1, ev('a', 'fail'), ev('b', 'fail')),
      round(2, ev('a', 'fail'), ev('b', 'fail')),
    ])
    expect(work.open).toEqual(['a', 'b'])
    expect(work.reopened).toEqual([])
  })

  test('앞 라운드에 없던 게이트는 회귀가 아니다 — 처음 돈 게이트다', () => {
    const work = remainingWork([round(1, ev('a', 'pass')), round(2, ev('a', 'pass'), ev('new', 'fail'))])
    expect(work.open).toEqual(['new'])
    expect(work.reopened).toEqual([])
  })

  test('라운드가 없으면 빈 결과다', () => {
    expect(remainingWork([])).toEqual({ open: [], closed: [], reopened: [] })
  })
})
