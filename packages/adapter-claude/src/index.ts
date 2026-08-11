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
      // 드레인: stdout/stderr를 읽기 시작하고, 그 후 exit 대기 (64KB 버퍼 deadlock 방지)
      const stdoutPromise = new Response(proc.stdout).text()
      const stderrPromise = new Response(proc.stderr).text()
      const exitCode = await proc.exited
      const raw = await stdoutPromise
      const stderrText = await stderrPromise
      const parsed = parseStreamJson(raw)
      const ok = exitCode === 0 && parsed.ok
      const events = [...parsed.events]
      // 실패 시 진단: stderr의 마지막 4000글자를 이벤트로 추가
      if (!ok && stderrText) {
        events.push({
          type: 'stderr',
          timestamp: new Date().toISOString(),
          payload: { text: stderrText.slice(-4000) },
        })
      }
      return {
        ok,
        sessionId: parsed.sessionId,
        finalText: parsed.finalText,
        events,
      }
    } catch {
      return { ok: false, finalText: '', events: [] } // spawn 실패 — 증거는 없지만 크래시도 안 함
    }
  }
}
