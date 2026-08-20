import { test, expect } from 'bun:test'
import { addUsage, emptyUsage, readUsage, type Usage } from '../src/adapter'

const KEYS = { input: ['input_tokens'], output: ['output_tokens'], cached: ['cached_input_tokens'] }

test('usage 객체를 중립 형태로 옮긴다', () => {
  const usage = readUsage(
    { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 },
    KEYS,
    0.0123,
  )
  expect(usage).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    costUsd: 0.0123,
    turns: 1,
  })
})

test('토큰 필드가 하나도 없으면 usage 자체가 없다 — 0으로 위조하지 않는다', () => {
  expect(readUsage({ nothing: 1 }, KEYS)).toBeUndefined()
  expect(readUsage(undefined, KEYS)).toBeUndefined()
  expect(readUsage('not an object', KEYS)).toBeUndefined()
})

test('비용을 보고하지 않으면 costUsd가 없다', () => {
  expect(readUsage({ input_tokens: 5, output_tokens: 1 }, KEYS)?.costUsd).toBeUndefined()
})

test('누적: 양쪽 다 비용을 모르면 합계도 모른다', () => {
  const a: Usage = { inputTokens: 1, outputTokens: 2, turns: 1 }
  const total = addUsage(addUsage(emptyUsage(), a), a)
  expect(total).toEqual({ inputTokens: 2, outputTokens: 4, turns: 2 })
  expect(total.costUsd).toBeUndefined()
})

test('누적: 한쪽만 비용을 보고하면 보고된 만큼만 합산된다', () => {
  const known: Usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.5, turns: 1 }
  const unknown: Usage = { inputTokens: 1, outputTokens: 1, turns: 1 }
  expect(addUsage(known, unknown).costUsd).toBe(0.5)
})

test('누적: 없는 턴은 합계를 바꾸지 않는다', () => {
  const base: Usage = { inputTokens: 3, outputTokens: 3, turns: 1 }
  expect(addUsage(base, undefined)).toBe(base)
})

test('cachedInsideInput이면 캐시분을 빼서 어댑터끼리 같은 뜻이 되게 한다', () => {
  const raw = { input_tokens: 566_030, output_tokens: 100, cached_input_tokens: 504_576 }
  // codex: input ⊃ cached — 실측한 포함 관계
  expect(readUsage(raw, { ...KEYS, cachedInsideInput: true })).toEqual({
    inputTokens: 61_454,
    outputTokens: 100,
    cachedInputTokens: 504_576,
    turns: 1,
  })
  // claude: input과 cached가 별개 — 그대로 싣는다
  expect(readUsage(raw, KEYS)?.inputTokens).toBe(566_030)
})

test('캐시만 있고 입력이 없으면 뺄셈하지 않는다 — 없는 값을 0으로 만들지 않는다', () => {
  const usage = readUsage(
    { output_tokens: 3, cached_input_tokens: 50 },
    { ...KEYS, cachedInsideInput: true },
  )
  expect(usage).toEqual({ inputTokens: 0, outputTokens: 3, cachedInputTokens: 50, turns: 1 })
})
