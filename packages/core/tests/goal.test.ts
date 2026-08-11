import { test, expect } from 'bun:test'
import { GoalSchema, GateSchema, extractGates } from '../src/goal'

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
  expect(extractGates(text)).toEqual([{ name: 'test', cmd: 'bun test', timeoutMs: 300_000 }])
})

test('extractGates: 블록 없음/깨진 JSON/스키마 불일치 → null', () => {
  expect(extractGates('계획만 있음')).toBeNull()
  expect(extractGates('```json\n{broken\n```')).toBeNull()
  expect(extractGates('```json\n{"gates":[{"name":"x"}]}\n```')).toBeNull()
})
