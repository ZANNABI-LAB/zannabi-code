import type { AgentAdapter, AgentRequest, AgentResult } from './adapter'

export class FakeAdapter implements AgentAdapter {
  readonly name = 'fake'
  requests: AgentRequest[] = []
  private queue: AgentResult[]
  private calls = 0

  constructor(
    results: AgentResult[],
    private onRun?: (request: AgentRequest, index: number) => void,
  ) {
    this.queue = [...results]
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    this.onRun?.(request, this.calls++)
    this.requests.push(request)
    const next = this.queue.shift()
    if (!next) throw new Error('FakeAdapter: no more queued results')
    return next
  }
}

export function fakeResult(finalText: string, sessionId = 's1'): AgentResult {
  return { ok: true, sessionId, finalText, events: [] }
}
