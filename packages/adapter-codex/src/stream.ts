import type { AgentEvent, ParsedAgentStream } from '@zannabi-lab/core'

const REASON_CHARS = 300

/**
 * `codex exec --json` 의 JSONL 이벤트를 해석한다. 실측한 형태:
 *
 *   {"type":"thread.started","thread_id":"01a0..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * 실패하면 `turn.failed`(error.message)와 최상위 `error` 이벤트가 온다.
 */
export function parseCodexStream(raw: string): ParsedAgentStream {
  const events: AgentEvent[] = []
  let sessionId: string | undefined
  let finalText = ''
  let ok = false
  let sawTurnEnd = false
  let errorReason: string | undefined

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // 외부 출력은 신뢰하지 않는다 — 깨진 라인은 건너뜀
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const json = parsed as Record<string, unknown>

    events.push({
      type: typeof json.type === 'string' ? json.type : 'unknown',
      timestamp: new Date().toISOString(),
      payload: json,
    })

    if (json.type === 'thread.started' && typeof json.thread_id === 'string')
      sessionId = json.thread_id

    // 마지막 agent_message가 최종 답변이다
    if (json.type === 'item.completed') {
      const item = json.item as Record<string, unknown> | undefined
      if (item?.type === 'agent_message' && typeof item.text === 'string') finalText = item.text
    }

    if (json.type === 'turn.completed') {
      sawTurnEnd = true
      ok = true
    }

    if (json.type === 'turn.failed') {
      sawTurnEnd = true
      ok = false
      const error = json.error as Record<string, unknown> | undefined
      const message = typeof error?.message === 'string' ? error.message : ''
      errorReason = message ? `turn.failed: ${condense(message)}` : 'turn.failed'
    }

    // turn.failed가 없더라도 최상위 error는 사유로 잡아둔다
    if (json.type === 'error' && !errorReason && typeof json.message === 'string')
      errorReason = `error: ${condense(json.message)}`
  }

  if (!sawTurnEnd) errorReason ??= 'turn 종료 이벤트 없음 (스트림이 완료 전에 끊김)'
  return { sessionId, finalText, ok, events, errorReason: ok ? undefined : errorReason }
}

/** codex는 오류 본문에 JSON을 통째로 넣기도 한다 — 한 줄로 줄인다 */
function condense(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS)
}
