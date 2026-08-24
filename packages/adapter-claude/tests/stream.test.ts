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

test('result 이벤트에서 토큰과 비용을 거둔다', () => {
  const raw = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: '완료',
    total_cost_usd: 0.0312,
    usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 900 },
  })
  const parsed = parseStreamJson(raw)
  expect(parsed.usage).toEqual({
    inputTokens: 12,
    outputTokens: 34,
    cachedInputTokens: 900,
    costUsd: 0.0312,
    turns: 1,
  })
})

test('usage가 없는 스트림은 usage 없이 돌아온다', () => {
  const parsed = parseStreamJson(
    JSON.stringify({ type: 'result', subtype: 'success', result: '완료' }),
  )
  expect(parsed.usage).toBeUndefined()
})

test('에이전트가 스스로 돌린 명령을 뽑는다', () => {
  const lines = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '빌드해 보겠습니다' },
          { type: 'tool_use', name: 'Bash', input: { command: './gradlew build' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/x' } },
        ],
      },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] },
    },
    { type: 'result', subtype: 'success', result: '했음' },
  ]
  const parsed = parseStreamJson(lines.map(l => JSON.stringify(l)).join('\n'))

  // Bash만 센다 — Edit는 자기 확인이 아니라 작업이다
  expect(parsed.selfChecks).toEqual([{ cmd: './gradlew build' }, { cmd: 'bun test' }])
})

test('셸을 한 번도 안 쓴 턴은 selfChecks가 아예 없다', () => {
  // 빈 배열과 없음을 가르는 이유: 저널에 빈 배열을 실으면 "0건 확인함"으로 읽히는데,
  // 어댑터가 알아내지 못한 것과 에이전트가 안 돌린 것은 다른 사실이다
  const parsed = parseStreamJson(
    [
      { type: 'assistant', message: { content: [{ type: 'text', text: '했음' }] } },
      { type: 'result', subtype: 'success', result: '했음' },
    ]
      .map(l => JSON.stringify(l))
      .join('\n'),
  )
  expect(parsed.selfChecks).toBeUndefined()
})

test('거부된 시도를 실행한 것으로 세지 않는다 — 13건이 0건일 수 있다', () => {
  // 실측 1차의 모양: 따옴표 하나가 달라 전부 거부됐는데 리포트는 "13건"이라 적었다
  const lines = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: './gradlew test --tests "*A*"' } },
          { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'bun test' } },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: '했음',
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: './gradlew test --tests "*A*"' } },
      ],
    },
  ]
  const parsed = parseStreamJson(lines.map(l => JSON.stringify(l)).join('\n'))

  expect(parsed.selfChecks).toEqual([
    { cmd: './gradlew test --tests "*A*"', denied: true },
    { cmd: 'bun test' },
  ])
})

test('id가 없는 거부 기록은 명령 문자열로 맞춘다', () => {
  // 대조에 실패해 거부를 놓치면 리포트가 "확인했다"고 말한다 — 이 필드를 만든 이유가 그것이다
  const lines = [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: './gradlew -v' } }] },
    },
    {
      type: 'result',
      subtype: 'success',
      result: '했음',
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: './gradlew -v' } }],
    },
  ]
  const parsed = parseStreamJson(lines.map(l => JSON.stringify(l)).join('\n'))
  expect(parsed.selfChecks).toEqual([{ cmd: './gradlew -v', denied: true }])
})
