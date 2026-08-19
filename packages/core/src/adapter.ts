import type { ProcessOutcome } from './proc'

export interface AgentRequest {
  prompt: string
  cwd: string
  resumeSessionId?: string
}

export interface AgentEvent {
  type: string
  timestamp: string
  payload: unknown
}

export interface AgentResult {
  ok: boolean
  sessionId?: string
  finalText: string
  events: AgentEvent[]
  /** 실패 사유 한 줄. ok=false일 때만 의미가 있다 — 진단이 transcript 파싱을 요구하지 않게 한다 */
  errorReason?: string
}

/** 어댑터가 구동 가능한 상태인지 — 인증 만료처럼 실행 전에 알 수 있는 것만 본다 */
export interface PreflightResult {
  ok: boolean
  detail?: string
}

export interface AgentAdapter {
  readonly name: string
  run(request: AgentRequest): Promise<AgentResult>
  /** 선택 구현. core는 어떤 에이전트의 존재도 모르므로 검사 내용은 어댑터가 정한다 */
  preflight?(): Promise<PreflightResult>
}

/** 어댑터가 자기 CLI의 출력 형식을 해석해 내놓는 중립 형태 */
export interface ParsedAgentStream {
  sessionId?: string
  finalText: string
  ok: boolean
  events: AgentEvent[]
  errorReason?: string
}

const STDERR_TAIL_CHARS = 4000
const STDERR_REASON_CHARS = 200

/**
 * 프로세스 결과 + 해석된 스트림 → AgentResult.
 * 실패 판정과 사유 조립은 어느 CLI를 쓰든 같으므로 여기서 한 번만 한다.
 */
export function toAgentResult(
  label: string,
  outcome: ProcessOutcome,
  parsed: ParsedAgentStream,
): AgentResult {
  const base = { sessionId: parsed.sessionId, finalText: parsed.finalText }

  if (outcome.spawnError)
    return { ...base, ok: false, events: parsed.events, errorReason: `${label} 실행 실패: ${outcome.spawnError}` }

  if (outcome.idleKilled)
    return {
      ...base,
      ok: false,
      events: parsed.events,
      errorReason: `출력이 ${outcome.idleTimeoutMs}ms 동안 없어 종료시켰습니다 (에이전트 행)`,
    }

  const ok = outcome.exitCode === 0 && parsed.ok
  const events = [...parsed.events]
  // 실패 시 진단: stderr 꼬리를 이벤트로 남긴다
  if (!ok && outcome.stderr)
    events.push({
      type: 'stderr',
      timestamp: new Date().toISOString(),
      payload: { text: outcome.stderr.slice(-STDERR_TAIL_CHARS) },
    })

  if (ok) return { ...base, ok, events }

  const parts = [`exit ${outcome.exitCode}`]
  if (parsed.errorReason) parts.push(parsed.errorReason)
  const lastLine = outcome.stderr.trim().split('\n').filter(Boolean).at(-1)
  if (lastLine) parts.push(`stderr: ${lastLine.slice(-STDERR_REASON_CHARS)}`)
  return { ...base, ok, events, errorReason: parts.join(' | ') }
}
