import type {
  AgentAdapter, AgentRequest, AgentResult, PreflightResult,
} from '@zannabi-lab/core'
import { parseStreamJson } from './stream'

export { parseStreamJson } from './stream'

const STDERR_REASON_CHARS = 200

/** 종료코드 · 스트림 사유 · stderr 마지막 줄을 한 줄로 합친다 (report.md에 그대로 실린다) */
function failureReason(exitCode: number, streamReason: string | undefined, stderr: string): string {
  const parts = [`exit ${exitCode}`]
  if (streamReason) parts.push(streamReason)
  const lastLine = stderr.trim().split('\n').filter(Boolean).at(-1)
  if (lastLine) parts.push(`stderr: ${lastLine.slice(-STDERR_REASON_CHARS)}`)
  return parts.join(' | ')
}

export interface ClaudeAdapterOptions {
  binary?: string
  permissionMode?: string
  model?: string
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
    if (this.options.model) args.push('--model', this.options.model)
    if (request.resumeSessionId) args.push('--resume', request.resumeSessionId)
    return args
  }

  /**
   * `claude auth status`는 로그아웃 상태에서도 exit 0을 낼 수 있으므로
   * 종료코드가 아니라 JSON의 loggedIn을 본다.
   */
  async preflight(): Promise<PreflightResult> {
    try {
      const proc = Bun.spawn([this.options.binary ?? 'claude', 'auth', 'status'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = await new Response(proc.stdout).text()
      const code = await proc.exited
      if (code !== 0) return { ok: false, detail: `claude auth status 실패 (exit ${code})` }
      const parsed = JSON.parse(out) as { loggedIn?: unknown; authMethod?: unknown }
      if (parsed.loggedIn !== true) return { ok: false, detail: 'claude 로그인 필요 — `claude auth login`' }
      return { ok: true, detail: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined }
    } catch (err) {
      // claude 미설치나 출력 형식 변경 — 사전점검 실패로 실행을 막지는 않는다
      return { ok: true, detail: `사전점검 건너뜀: ${err instanceof Error ? err.message : String(err)}` }
    }
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
        errorReason: ok ? undefined : failureReason(exitCode, parsed.errorReason, stderrText),
      }
    } catch (err) {
      // spawn 실패 — 증거는 없지만 크래시도 안 함
      return {
        ok: false,
        finalText: '',
        events: [],
        errorReason: `claude 실행 실패: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}
