import { test, expect } from 'bun:test'
import { summarizeRace, parseArm, runConcurrent, type ArmOutcome } from '../src/race'
import type { LoopResult } from '../src/loop'
import { emptyUsage } from '../src/adapter'

const AGENTS = ['claude', 'codex'] as const

function outcome(
  name: string,
  status: LoopResult['status'],
  attempts: number,
  execCostUsd?: number,
  elapsedMs = 1000,
): ArmOutcome {
  const idx = name.indexOf(':')
  return {
    arm: {
      name,
      agent: idx === -1 ? name : name.slice(0, idx),
      ...(idx === -1 ? {} : { model: name.slice(idx + 1) }),
    },
    runId: `run-${name}`,
    elapsedMs,
    branch: `zannabi/run-${name}`,
    commits: 1,
    result: {
      status,
      attempts,
      rounds: [],
      usage: {
        plan: emptyUsage(),
        exec: { ...emptyUsage(), turns: 1, ...(execCostUsd === undefined ? {} : { costUsd: execCostUsd }) },
      },
    },
  }
}

test('집계의 비용 합은 개별 조의 합과 같다', () => {
  // best-of-N이 지켜야 할 것. 집계가 개별 실행과 다른 말을 하기 시작하면
  // 병렬은 측정 도구가 아니라 측정을 망치는 장치가 된다
  const arms = [outcome('a', 'success', 1, 1.25), outcome('b', 'success', 2, 0.5)]
  const summary = summarizeRace('r1', '작업', arms)

  expect(summary.totalCostUsd).toBeCloseTo(1.75, 6)
  expect(summary.costCoverage).toBe('full')
  expect(summary.passed).toHaveLength(2)
  expect(summary.failed).toHaveLength(0)
})

test('일부만 비용을 보고하면 합계가 partial이라고 말한다', () => {
  const summary = summarizeRace('r2', '작업', [
    outcome('claude', 'success', 1, 2.0),
    outcome('codex', 'success', 1), // codex는 비용을 주지 않는다
  ])
  expect(summary.totalCostUsd).toBe(2.0)
  // 개별 실행에서 지키던 규칙이 집계에서 무너지면, 합계가 가장 거짓말하기 쉬운 자리가 된다
  expect(summary.costCoverage).toBe('partial')
})

test('아무도 비용을 보고하지 않으면 0이 아니라 없는 것이다', () => {
  const summary = summarizeRace('r3', '작업', [
    outcome('codex', 'success', 1),
    outcome('codex2' as string, 'success', 1),
  ])
  expect(summary.totalCostUsd).toBeUndefined()
  expect(summary.costCoverage).toBe('none')
})

test('라운드가 적은 조가 이기고, 무엇으로 갈랐는지 말한다', () => {
  const summary = summarizeRace('r4', '작업', [
    outcome('slow', 'success', 3, 0.1),
    outcome('fast', 'success', 1, 9.9),
  ])
  // 라운드를 먼저 보는 이유: 모든 런타임이 동등하게 보고하는 유일한 축이다
  expect(summary.winner?.arm.name).toBe('fast')
  expect(summary.verdict).toContain('라운드')
})

test('라운드가 같으면 비용으로 가른다', () => {
  const summary = summarizeRace('r5', '작업', [
    outcome('expensive', 'success', 1, 3.0),
    outcome('cheap', 'success', 1, 0.5),
  ])
  expect(summary.winner?.arm.name).toBe('cheap')
  expect(summary.verdict).toContain('비용으로 갈랐습니다')
})

test('비용을 비교할 수 없으면 그 사실을 밝히고 시간으로 고른다', () => {
  const summary = summarizeRace('r6', '작업', [
    outcome('codex', 'success', 1, undefined, 500),
    outcome('claude', 'success', 1, 2.0, 900),
  ])
  // 없는 값으로 순위를 매기면 침묵한 런타임이 언제나 이기거나 언제나 진다
  expect(summary.verdict).toContain('비용을 보고하지 않는 조가 있어')
  expect(summary.winner?.arm.name).toBe('codex')
})

test('통과한 조가 없으면 승자를 만들지 않는다', () => {
  const summary = summarizeRace('r7', '작업', [
    outcome('a', 'budget-exhausted', 3, 1.0),
    outcome('b', 'evidence-lost', 1, 0.2),
  ])
  expect(summary.winner).toBeUndefined()
  expect(summary.passed).toHaveLength(0)
  expect(summary.verdict).toContain('통과한 조가 없습니다')
  // 실패한 조의 비용도 합계에 든다 — 태운 돈은 태운 돈이다
  expect(summary.totalCostUsd).toBeCloseTo(1.2, 6)
})

test('evidence-lost는 통과로 세지 않는다', () => {
  // 게이트는 통과했을 수 있지만 증거가 없는 실행은 이 도구의 전제 아래에서 완료가 아니다
  const summary = summarizeRace('r8', '작업', [
    outcome('good', 'success', 2, 1.0),
    outcome('lost', 'evidence-lost', 1, 0.1),
  ])
  expect(summary.passed.map(p => p.arm.name)).toEqual(['good'])
  expect(summary.winner?.arm.name).toBe('good')
})

test('조 표기를 읽고, 모르는 런타임은 세운다', () => {
  expect(parseArm('codex', AGENTS)).toEqual({ name: 'codex', agent: 'codex' })
  expect(parseArm('claude:haiku-4-5', AGENTS)).toEqual({
    name: 'claude:haiku-4-5',
    agent: 'claude',
    model: 'haiku-4-5',
  })
  expect(() => parseArm('gpt', AGENTS)).toThrow('claude | codex')
  expect(() => parseArm('claude:', AGENTS)).toThrow('모델이 비어 있습니다')
  expect(() => parseArm('  ', AGENTS)).toThrow('비어 있습니다')
})

test('동시 실행 수를 넘기지 않는다', async () => {
  // 조 하나가 에이전트 프로세스에 게이트 프로세스를 더 쓴다. 상한이 없으면
  // 게이트 소요시간이 서로의 부하로 늘어나 재확인의 시간 비교가 못 믿을 값이 된다
  let running = 0
  let peak = 0
  const jobs = Array.from({ length: 6 }, (_, i) => async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 20))
    running--
    return i
  })

  const results = await runConcurrent(jobs, 2)
  expect(peak).toBeLessThanOrEqual(2)
  // 순서는 보존된다 — 결과를 조와 짝지어야 하므로
  expect(results).toEqual([0, 1, 2, 3, 4, 5])
})
