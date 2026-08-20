import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCodexStream } from '../src/stream'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8')

test('성공 스트림 — thread_id · 최종 답변 · ok (실측 출력)', () => {
  const parsed = parseCodexStream(fixture('exec-success.jsonl'))
  expect(parsed.ok).toBe(true)
  expect(parsed.sessionId).toBe('01a0189b-9d9b-7c00-9819-b0ffa06aacbe')
  expect(parsed.finalText).toBe('pong')
  expect(parsed.errorReason).toBeUndefined()
  expect(parsed.events.length).toBe(4)
})

test('실패 스트림 — turn.failed 사유를 뽑는다 (실측 출력)', () => {
  const parsed = parseCodexStream(fixture('exec-failed.jsonl'))
  expect(parsed.ok).toBe(false)
  expect(parsed.sessionId).toBe('01a018a2-2d7f-7473-83e7-9beb2370240a')
  expect(parsed.errorReason).toContain('turn.failed')
  expect(parsed.errorReason).toContain('not supported')
})

test('마지막 agent_message가 최종 답변이 된다', () => {
  const raw = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"중간"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"최종"}}',
    '{"type":"turn.completed"}',
  ].join('\n')
  expect(parseCodexStream(raw).finalText).toBe('최종')
})

test('agent_message가 아닌 item은 최종 답변으로 보지 않는다', () => {
  const raw = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"답변"}}',
    '{"type":"item.completed","item":{"type":"error","message":"경고일 뿐"}}',
    '{"type":"turn.completed"}',
  ].join('\n')
  expect(parseCodexStream(raw).finalText).toBe('답변')
})

test('turn 종료 이벤트가 없으면 끊긴 것으로 본다', () => {
  const parsed = parseCodexStream('{"type":"thread.started","thread_id":"t1"}')
  expect(parsed.ok).toBe(false)
  expect(parsed.errorReason).toContain('turn 종료 이벤트 없음')
})

test('깨진 라인과 비객체 JSON은 건너뛴다', () => {
  const raw = [
    'not json at all',
    '[1,2,3]',
    '"just a string"',
    '{"type":"turn.completed"}',
  ].join('\n')
  const parsed = parseCodexStream(raw)
  expect(parsed.ok).toBe(true)
  expect(parsed.events).toHaveLength(1)
})

test('turn.completed에서 토큰을 거둔다 — codex는 비용을 보고하지 않는다', () => {
  const raw = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 7, output_tokens: 8, cached_input_tokens: 5 },
  })
  const parsed = parseCodexStream(raw)
  // codex의 input_tokens는 캐시분을 포함하므로 빼서 싣는다 — claude 쪽과 같은 뜻이 되게
  expect(parsed.usage).toEqual({
    inputTokens: 2,
    outputTokens: 8,
    cachedInputTokens: 5,
    turns: 1,
  })
  expect(parsed.usage?.costUsd).toBeUndefined()
})

test('캐시가 입력보다 크면 0으로 막는다 — 음수 토큰은 싣지 않는다', () => {
  const raw = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 5, output_tokens: 1, cached_input_tokens: 9 },
  })
  expect(parseCodexStream(raw).usage?.inputTokens).toBe(0)
})

test('실패한 턴의 사용량도 거둔다 — 실패도 청구된다', () => {
  const raw = [
    JSON.stringify({ type: 'turn.failed', error: { message: '터짐' }, usage: { input_tokens: 3, output_tokens: 1 } }),
  ].join('\n')
  const parsed = parseCodexStream(raw)
  expect(parsed.ok).toBe(false)
  expect(parsed.usage?.inputTokens).toBe(3)
})
