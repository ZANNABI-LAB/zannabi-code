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

/** 출력이 이만큼 끊기면 멈춘 것으로 본다. 계획·실행 턴이 조용히 길어질 수 있어 넉넉히 잡는다 */
const IDLE_TIMEOUT_MS = 300_000
const KILL_GRACE_MS = 1000

export interface ClaudeAdapterOptions {
  binary?: string
  permissionMode?: string
  model?: string
  /** 마지막 출력 이후 이 시간이 지나면 종료시킨다. 0 이하면 끄기 */
  idleTimeoutMs?: number
}

const IO_GRACE_MS = 500

/**
 * 청크가 올 때마다 활동 시각을 갱신하며 sink에 모은다.
 *
 * 반환값이 아니라 sink에 쌓는 이유: 손자 프로세스가 파이프를 붙들면 이 루프가
 * 끝나지 않는다. 호출부는 종료 후 유예만 주고 sink에 쌓인 만큼만 가져간다.
 */
async function collect(
  stream: ReadableStream<Uint8Array> | null,
  sink: { text: string },
  touch: () => void,
) {
  if (!stream) return
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream) {
      touch()
      sink.text += decoder.decode(chunk, { stream: true })
    }
  } catch {
    // 스트림이 끊겨도 지금까지 모은 것은 진단에 쓴다
  }
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
      let lastActivity = Date.now()
      const touch = () => { lastActivity = Date.now() }
      const stdoutSink = { text: '' }
      const stderrSink = { text: '' }
      const outDone = collect(proc.stdout, stdoutSink, touch)
      const errDone = collect(proc.stderr, stderrSink, touch)

      // 행 감시: 출력이 끊긴 채 idleTimeoutMs가 지나면 종료시킨다
      const idleMs = this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
      let idleKilled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const watchdog =
        idleMs > 0
          ? setInterval(() => {
              if (Date.now() - lastActivity < idleMs) return
              idleKilled = true
              proc.kill()
              killTimer ??= setTimeout(() => proc.kill(9), KILL_GRACE_MS)
            }, Math.max(50, Math.min(idleMs, 5000)))
          : undefined

      const exitCode = await proc.exited
      if (watchdog) clearInterval(watchdog)
      if (killTimer) clearTimeout(killTimer)
      // 종료 후 남은 출력만 잠깐 거둔다. 손자 프로세스가 파이프를 붙들어도 여기서 멈추지 않는다
      await Promise.race([Promise.allSettled([outDone, errDone]), Bun.sleep(IO_GRACE_MS)])
      const raw = stdoutSink.text
      const stderrText = stderrSink.text
      const parsed = parseStreamJson(raw)
      const ok = exitCode === 0 && parsed.ok && !idleKilled
      if (idleKilled) {
        return {
          ok: false,
          sessionId: parsed.sessionId,
          finalText: parsed.finalText,
          events: parsed.events,
          errorReason: `출력이 ${idleMs}ms 동안 없어 종료시켰습니다 (에이전트 행)`,
        }
      }
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
