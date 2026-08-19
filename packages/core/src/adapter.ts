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
