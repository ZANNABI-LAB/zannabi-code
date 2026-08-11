import type { AgentEvent } from '@zannabi-lab/core'

export interface ParsedStream {
  sessionId?: string
  finalText: string
  ok: boolean
  events: AgentEvent[]
}

export function parseStreamJson(raw: string): ParsedStream {
  const events: AgentEvent[] = []
  let sessionId: string | undefined
  let finalText = ''
  let ok = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let json: Record<string, unknown>
    try {
      json = JSON.parse(trimmed)
    } catch {
      continue // 외부 출력은 신뢰하지 않는다 — 깨진 라인은 건너뜀
    }
    events.push({
      type: typeof json.type === 'string' ? json.type : 'unknown',
      timestamp: new Date().toISOString(),
      payload: json,
    })
    if (typeof json.session_id === 'string') sessionId = json.session_id
    if (json.type === 'result') {
      ok = json.subtype === 'success'
      finalText = typeof json.result === 'string' ? json.result : ''
    }
  }
  return { sessionId, finalText, ok, events }
}
