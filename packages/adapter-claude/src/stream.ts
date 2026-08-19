import type { AgentEvent } from '@zannabi-lab/core'

export interface ParsedStream {
  sessionId?: string
  finalText: string
  ok: boolean
  events: AgentEvent[]
  /** result 이벤트가 성공이 아닐 때의 사유 (subtype + 본문 앞부분) */
  errorReason?: string
}

const REASON_CHARS = 300

export function parseStreamJson(raw: string): ParsedStream {
  const events: AgentEvent[] = []
  let sessionId: string | undefined
  let finalText = ''
  let ok = false
  let errorReason: string | undefined
  let sawResult = false
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
    if (typeof json.session_id === 'string') sessionId = json.session_id
    if (json.type === 'result') {
      sawResult = true
      ok = json.subtype === 'success'
      finalText = typeof json.result === 'string' ? json.result : ''
      if (!ok) {
        const subtype = typeof json.subtype === 'string' ? json.subtype : 'unknown'
        const body = typeof json.result === 'string' ? json.result : ''
        const error = typeof json.error === 'string' ? json.error : ''
        const tail = (body || error).replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS)
        errorReason = tail ? `result=${subtype}: ${tail}` : `result=${subtype}`
      }
    }
  }
  // result 이벤트 자체가 없으면 스트림이 중간에 끊긴 것 — 이것도 사유다
  if (!sawResult) errorReason = 'result 이벤트 없음 (스트림이 완료 전에 끊김)'
  return { sessionId, finalText, ok, events, errorReason }
}
