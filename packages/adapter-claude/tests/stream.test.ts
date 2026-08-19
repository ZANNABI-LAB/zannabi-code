import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStreamJson } from '../src/stream'

const raw = readFileSync(join(import.meta.dir, 'fixtures/stream-sample.jsonl'), 'utf8')

test('session_id, 최종 텍스트, 성공 여부 추출', () => {
  const parsed = parseStreamJson(raw)
  expect(parsed.sessionId).toBe('abc-123')
  expect(parsed.finalText).toBe('재시도 로직을 추가했습니다.')
  expect(parsed.ok).toBe(true)
})

test('깨진 라인은 건너뛰고 유효 이벤트만 수집', () => {
  const parsed = parseStreamJson(raw)
  expect(parsed.events).toHaveLength(3) // 깨진 라인 제외
  expect(parsed.events.map(e => e.type)).toEqual(['system', 'assistant', 'result'])
})

test('result 없는 스트림(크래시) → ok false, finalText 빈 문자열', () => {
  const parsed = parseStreamJson('{"type":"system","session_id":"x"}\n')
  expect(parsed.ok).toBe(false)
  expect(parsed.finalText).toBe('')
  expect(parsed.sessionId).toBe('x') // 세션은 건짐 → resume 가능
})

test('비객체 JSON 라인(null, 숫자)은 건너뛰고 유효 이벤트만 수집', () => {
  const parsed = parseStreamJson('{"type":"system","session_id":"x"}\nnull\n123\n{"type":"result","subtype":"success","result":"ok","session_id":"x"}\n')
  expect(parsed.ok).toBe(true)
  expect(parsed.finalText).toBe('ok')
  expect(parsed.events).toHaveLength(2)
  expect(parsed.events.map(e => e.type)).toEqual(['system', 'result'])
})

test('result가 성공이 아니면 사유를 뽑는다', () => {
  const raw = '{"type":"result","subtype":"error_during_execution","result":"rate limit  exceeded"}'
  const parsed = parseStreamJson(raw)
  expect(parsed.ok).toBe(false)
  expect(parsed.errorReason).toBe('result=error_during_execution: rate limit exceeded')
})

test('result 이벤트가 아예 없으면 그것도 사유로 남는다 (401 만료 형태)', () => {
  const parsed = parseStreamJson('{"type":"system","session_id":"abc"}')
  expect(parsed.ok).toBe(false)
  expect(parsed.errorReason).toContain('result 이벤트 없음')
})

test('성공한 스트림에는 사유가 없다', () => {
  const parsed = parseStreamJson('{"type":"result","subtype":"success","result":"done"}')
  expect(parsed.ok).toBe(true)
  expect(parsed.errorReason).toBeUndefined()
})
