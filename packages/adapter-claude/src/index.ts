import type { AgentAdapter, AgentRequest, AgentResult } from '@zannabi-lab/core'
import { parseStreamJson } from './stream'

export { parseStreamJson } from './stream'

export interface ClaudeAdapterOptions {
  binary?: string
  permissionMode?: string
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude'

  constructor(private options: ClaudeAdapterOptions = {}) {}

  buildArgs(request: AgentRequest): string[] {
    const args = [
      '-p', request.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.options.permissionMode ?? 'acceptEdits',
    ]
    if (request.resumeSessionId) args.push('--resume', request.resumeSessionId)
    return args
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    try {
      const proc = Bun.spawn([this.options.binary ?? 'claude', ...this.buildArgs(request)], {
        cwd: request.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const raw = await new Response(proc.stdout).text()
      const parsed = parseStreamJson(raw)
      return {
        ok: exitCode === 0 && parsed.ok,
        sessionId: parsed.sessionId,
        finalText: parsed.finalText,
        events: parsed.events,
      }
    } catch {
      return { ok: false, finalText: '', events: [] } // spawn 실패 — 증거는 없지만 크래시도 안 함
    }
  }
}
