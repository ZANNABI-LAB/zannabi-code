import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop, type LoopOptions } from '../src/loop'
import { executePrompt, planPrompt } from '../src/prompts'
import { RunStore, WHOLE_RUN } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'

const planText = (cmd: string) =>
  `계획: 한다.\n\`\`\`json\n{"gates":[{"name":"g","cmd":"${cmd}"}]}\n\`\`\``

const event = { type: 't', timestamp: '2026-08-20T00:00:00Z', payload: {} }

function store(prefix: string): RunStore {
  return new RunStore(mkdtempSync(join(tmpdir(), prefix)), '증거 보호')
}

test('정상 실행에서는 손실 기록이 비어 있다', () => {
  const s = store('zannabi-loss-none-')
  s.writePlan('p')
  s.appendTranscript(event)
  s.writeReport('r')
  expect(s.losses).toEqual([])
})

test('실행 디렉토리가 통째로 사라져도 죽지 않고, 사라졌다는 사실을 남긴다', () => {
  const s = store('zannabi-loss-dir-')
  s.appendTranscript(event)
  rmSync(s.dir, { recursive: true, force: true }) // 에이전트가 지웠다

  expect(() => s.appendTranscript(event)).not.toThrow() // 러너는 죽지 않는다
  expect(s.losses).toHaveLength(1)
  expect(s.losses[0].target).toBe(WHOLE_RUN)
  expect(existsSync(join(s.dir, 'transcript.jsonl'))).toBe(true) // 되살아났다
})

test('파일 하나만 지워져도 그 파일 이름으로 기록된다', () => {
  const s = store('zannabi-loss-file-')
  s.writeEvidence([])
  rmSync(join(s.dir, 'evidence.json'))

  s.writeEvidence([])
  expect(s.losses.map(l => l.target)).toEqual(['evidence.json'])
})

test('쓴 적 없는 파일이 없다고 손실로 세지 않는다 — 처음 쓰는 것과 지워진 것은 다르다', () => {
  const s = store('zannabi-loss-first-')
  s.writeGoal({ intent: 'x', gates: [], budget: 1 })
  s.writePlan('p')
  s.writeReport('r')
  expect(s.losses).toEqual([])
})

test('디렉토리가 두 번 사라지면 두 번 기록된다 — 한 번으로 뭉치지 않는다', () => {
  const s = store('zannabi-loss-twice-')
  s.writePlan('p')
  rmSync(s.dir, { recursive: true, force: true })
  s.writePlan('p')
  rmSync(s.dir, { recursive: true, force: true })
  s.writePlan('p')
  expect(s.losses).toHaveLength(2)
})

test('실행 중 증거가 지워지면 게이트를 통과해도 evidence-lost로 강등된다', async () => {
  // 2026-08-20 실측 재현: haiku 실행이 `.zannabi/`를 통째로 지워 러너가 ENOENT로 죽었다
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-loss-loop-'))
  const s = new RunStore(cwd, '증거 삭제 재현')
  const adapter = new FakeAdapter(
    [fakeResult(planText('true')), fakeResult('실행')],
    (_req, i) => { if (i === 1) rmSync(s.dir, { recursive: true, force: true }) },
  )

  const result = await runLoop({
    intent: '증거 삭제 재현',
    userGates: [],
    budget: 2,
    cwd,
    store: s,
    adapter,
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  } satisfies LoopOptions)

  expect(result.status).toBe('evidence-lost') // success가 아니다
  expect(result.rounds[0].evidence[0].outcome).toBe('pass') // 게이트 자체는 통과했다
  expect(result.evidenceLoss?.[0].target).toBe(WHOLE_RUN)
  expect(result.detail).toContain('완료로 보지 않습니다')
})

test('실패로 끝난 실행은 상태를 바꾸지 않고 사실만 덧붙인다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-loss-fail-'))
  const s = new RunStore(cwd, '실패 중 삭제')
  const adapter = new FakeAdapter(
    [fakeResult(planText('false')), fakeResult('1'), fakeResult('2')],
    (_req, i) => { if (i === 1) rmSync(s.dir, { recursive: true, force: true }) },
  )

  const result = await runLoop({
    intent: '실패 중 삭제',
    userGates: [],
    budget: 2,
    cwd,
    store: s,
    adapter,
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  } satisfies LoopOptions)

  expect(result.status).toBe('budget-exhausted') // 실패 사유를 증거 소실로 덮지 않는다
  expect(result.evidenceLoss).toHaveLength(1)
  expect(result.detail).toContain('사라졌습니다')
})

test('증거 소실 뒤에도 리포트는 끝까지 쓰인다 — 사고를 알릴 자리가 사고로 사라지면 안 된다', async () => {
  const s = store('zannabi-loss-report-')
  s.writePlan('p')
  rmSync(s.dir, { recursive: true, force: true })
  s.writeReport('보고서')
  expect(readFileSync(join(s.dir, 'report.md'), 'utf-8')).toBe('보고서')
})

test('두 프롬프트 모두 증거 저장소를 건드리지 말라고 말한다', () => {
  // 실측에서 지운 에이전트는 어긋난 것이 아니라 "파일을 만들지 마라"를 따른 것이었다
  expect(planPrompt('x')).toContain('.zannabi/')
  expect(executePrompt('plan')).toContain('.zannabi/')
  expect(executePrompt('plan')).toContain('even when asked to keep the working tree clean')
})
