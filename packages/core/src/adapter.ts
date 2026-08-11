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
}

export interface AgentAdapter {
  readonly name: string
  run(request: AgentRequest): Promise<AgentResult>
}
