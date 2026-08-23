import { readUsage, type AgentEvent, type Usage } from '@zannabi-lab/core'

export interface ParsedStream {
  sessionId?: string
  finalText: string
  ok: boolean
  events: AgentEvent[]
  /** result 이벤트가 성공이 아닐 때의 사유 (subtype + 본문 앞부분) */
  errorReason?: string
  usage?: Usage
  /** 런타임이 스스로 보고한 모델(`system/init`). 우리가 지정한 값이 아니다 */
  model?: string
  /** 에이전트가 스스로 돌린 셸 명령 — assistant 메시지의 `tool_use`에서 뽑는다 */
  selfChecks?: string[]
}

/**
 * `result` 이벤트의 usage 필드명. claude는 비용까지 보고한다.
 *
 * `cache_read_input_tokens`는 `input_tokens`와 **별개로** 세어지므로(실측: 15 + 307,180)
 * 뺄셈하지 않는다 — codex 쪽과 달리 이미 배타적이다.
 */
const USAGE_KEYS = {
  input: ['input_tokens'],
  output: ['output_tokens'],
  cached: ['cache_read_input_tokens'],
}

const REASON_CHARS = 300

/**
 * 이 턴에서 에이전트가 돌린 셸 명령을 뽑는다.
 *
 * assistant 메시지의 `content[]`에 `{type: "tool_use", name: "Bash", input: {command}}`로 온다.
 * **거부당한 것도 여기에는 남는다** — 승인 대기로 떨어져 실제로는 돌지 않은 호출까지 세면
 * "확인하고 썼다"가 거짓이 되므로, 세는 쪽(`toolResults`)에서 결과와 대조해야 한다.
 * 여기서는 시도된 명령만 모은다.
 */
function readBashCommands(json: Record<string, unknown>): string[] {
  if (json.type !== 'assistant') return []
  const message = json.message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  const found: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type !== 'tool_use' || b.name !== 'Bash') continue
    const input = b.input
    if (typeof input !== 'object' || input === null) continue
    const cmd = (input as Record<string, unknown>).command
    if (typeof cmd === 'string' && cmd.trim()) found.push(cmd.trim())
  }
  return found
}

export function parseStreamJson(raw: string): ParsedStream {
  const events: AgentEvent[] = []
  let sessionId: string | undefined
  let finalText = ''
  let ok = false
  let errorReason: string | undefined
  let sawResult = false
  let usage: Usage | undefined
  let model: string | undefined
  const selfChecks: string[] = []
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
    // 실제로 무엇이 돌았는지는 그쪽만 안다 — 환경변수로 정해질 수도 있다
    if (typeof json.model === 'string') model = json.model
    selfChecks.push(...readBashCommands(json))
    if (json.type === 'result') {
      sawResult = true
      usage = readUsage(json.usage, USAGE_KEYS, json.total_cost_usd) ?? usage
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
  return {
    sessionId, finalText, ok, events, errorReason, usage, model,
    ...(selfChecks.length > 0 ? { selfChecks } : {}),
  }
}
