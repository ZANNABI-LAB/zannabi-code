import { test, expect } from 'bun:test'
import { GoalSchema, GateSchema, extractGates, mergeGates } from '../src/goal'

test('Goal 기본값: budget 3, gate timeoutMs 300000', () => {
  const goal = GoalSchema.parse({
    intent: '재시도 로직 추가',
    gates: [{ name: 'test', cmd: 'bun test' }],
  })
  expect(goal.budget).toBe(3)
  expect(goal.gates[0].timeoutMs).toBe(300_000)
})

test('빈 name/cmd 게이트는 거부', () => {
  expect(GateSchema.safeParse({ name: '', cmd: 'x' }).success).toBe(false)
  expect(GateSchema.safeParse({ name: 'x', cmd: '' }).success).toBe(false)
})

test('extractGates: json 블록에서 게이트 추출', () => {
  const text = '계획입니다.\n```json\n{"gates":[{"name":"test","cmd":"bun test"}]}\n```'
  expect(extractGates(text)).toEqual([
    { name: 'test', cmd: 'bun test', timeoutMs: 300_000, source: 'suggested' },
  ])
})

test('extractGates: 블록 없음/깨진 JSON/스키마 불일치 → null', () => {
  expect(extractGates('계획만 있음')).toBeNull()
  expect(extractGates('```json\n{broken\n```')).toBeNull()
  expect(extractGates('```json\n{"gates":[{"name":"x"}]}\n```')).toBeNull()
})

test('JSON 블록이 여러 개면 마지막 것을 쓴다', () => {
  const text = [
    '예시는 이렇다:',
    '```json',
    '{"gates":[{"name":"예시","cmd":"echo example"}]}',
    '```',
    '실제 제안:',
    '```json',
    '{"gates":[{"name":"real","cmd":"bun test"}]}',
    '```',
  ].join('\n')
  const gates = extractGates(text)
  expect(gates).toHaveLength(1)
  expect(gates![0].name).toBe('real')
})

test('마지막 블록이 게이트가 아니면 앞쪽 블록을 본다', () => {
  const text = [
    '```json',
    '{"gates":[{"name":"real","cmd":"bun test"}]}',
    '```',
    '참고 설정:',
    '```json',
    '{"unrelated": true}',
    '```',
  ].join('\n')
  expect(extractGates(text)![0].name).toBe('real')
})

test('mergeGates: 이름이 겹치면 사용자 게이트가 이기고, 밀린 제안이 기록된다', () => {
  const user = [{ name: 'build', cmd: './gradlew build', timeoutMs: 1000, source: 'user' as const }]
  const suggested = [
    { name: 'build', cmd: './gradlew cleanTest build', timeoutMs: 1000, source: 'suggested' as const },
    { name: 'lint', cmd: 'bun lint', timeoutMs: 1000, source: 'suggested' as const },
  ]
  const { gates, dropped } = mergeGates(user, suggested)
  expect(gates.map(g => g.cmd)).toEqual(['./gradlew build', 'bun lint'])
  expect(dropped).toEqual([
    {
      name: 'build',
      cmd: './gradlew cleanTest build',
      reason: 'name-collision',
      keptCmd: './gradlew build',
    },
  ])
})

test('mergeGates: 명령까지 같은 충돌은 잃은 것이 없으므로 보고하지 않는다', () => {
  const g = { name: 'test', cmd: 'bun test', timeoutMs: 1000 }
  const { gates, dropped } = mergeGates(
    [{ ...g, source: 'user' as const }],
    [{ ...g, source: 'suggested' as const }],
  )
  expect(gates).toHaveLength(1)
  expect(dropped).toEqual([])
})

test('mergeGates: 거부 설정이면 제안 전부가 rejected로 남는다', () => {
  const { gates, dropped } = mergeGates(
    [{ name: 'u', cmd: 'true', timeoutMs: 1000, source: 'user' as const }],
    [{ name: 'g', cmd: 'false', timeoutMs: 1000, source: 'suggested' as const }],
    { reject: true },
  )
  expect(gates.map(g => g.name)).toEqual(['u'])
  expect(dropped).toEqual([{ name: 'g', cmd: 'false', reason: 'rejected' }])
})
