import {
  runProcess, toAgentResult,
  type AgentAdapter, type AgentRequest, type AgentResult, type PreflightResult,
} from '@zannabi-lab/core'
import { parseStreamJson } from './stream'

export { parseStreamJson } from './stream'

export interface ClaudeAdapterOptions {
  binary?: string
  permissionMode?: string
  model?: string
  /** 마지막 출력 이후 이 시간이 지나면 종료시킨다. 0 이하면 끄기 */
  idleTimeoutMs?: number
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude'

  constructor(private options: ClaudeAdapterOptions = {}) {}

  private get binary() {
    return this.options.binary ?? 'claude'
  }

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
    const outcome = await runProcess([this.binary, 'auth', 'status'], { idleTimeoutMs: 30_000 })
    if (outcome.spawnError)
      // 미설치나 실행 불가 — 사전점검이 새로운 실패 경로가 되지는 않게 한다
      return { ok: true, detail: `사전점검 건너뜀: ${outcome.spawnError}` }
    if (outcome.exitCode !== 0)
      return { ok: false, detail: `claude auth status 실패 (exit ${outcome.exitCode})` }
    try {
      const parsed = JSON.parse(outcome.stdout) as { loggedIn?: unknown; authMethod?: unknown }
      if (parsed.loggedIn !== true)
        return { ok: false, detail: 'claude 로그인 필요 — `claude auth login`' }
      return { ok: true, detail: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined }
    } catch {
      return { ok: true, detail: '사전점검 건너뜀: auth status 출력을 해석하지 못했습니다' }
    }
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const outcome = await runProcess([this.binary, ...this.buildArgs(request)], {
      cwd: request.cwd,
      idleTimeoutMs: this.options.idleTimeoutMs,
    })
    return toAgentResult('claude', outcome, parseStreamJson(outcome.stdout))
  }
}
