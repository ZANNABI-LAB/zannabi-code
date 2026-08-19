import {
  runProcess, toAgentResult,
  type AgentAdapter, type AgentRequest, type AgentResult, type PreflightResult,
} from '@zannabi-lab/core'
import { parseCodexStream } from './stream'

export { parseCodexStream } from './stream'

export interface CodexAdapterOptions {
  binary?: string
  model?: string
  /** codex 샌드박스 정책. 러너는 에이전트가 파일을 고쳐야 하므로 기본이 workspace-write */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** git 저장소가 아닌 디렉토리에서도 실행 허용 */
  skipGitRepoCheck?: boolean
  idleTimeoutMs?: number
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex'

  constructor(private options: CodexAdapterOptions = {}) {}

  private get binary() {
    return this.options.binary ?? 'codex'
  }

  /**
   * `codex exec` 는 프롬프트를 위치 인자로 받는다. 이어가기는 `--resume` 플래그가 아니라
   * **`exec resume` 서브커맨드**이고, 옵션 집합이 다르다 — `--sandbox`·`-C`·`--skip-git-repo-check`를
   * 받지 않으므로 붙이면 파싱 오류(exit 2)가 난다. 작업 디렉토리는 프로세스 cwd로 전달된다.
   */
  buildArgs(request: AgentRequest): string[] {
    const model = this.options.model ? ['-m', this.options.model] : []

    if (request.resumeSessionId)
      return ['exec', 'resume', '--json', ...model, request.resumeSessionId, request.prompt]

    return [
      'exec',
      '--json',
      '--sandbox', this.options.sandbox ?? 'workspace-write',
      '-C', request.cwd,
      ...model,
      ...(this.options.skipGitRepoCheck ? ['--skip-git-repo-check'] : []),
      request.prompt,
    ]
  }

  /** `codex login status` 는 평문 한 줄 + 종료코드로 알린다 */
  async preflight(): Promise<PreflightResult> {
    const outcome = await runProcess([this.binary, 'login', 'status'], { idleTimeoutMs: 30_000 })
    if (outcome.spawnError)
      return { ok: true, detail: `사전점검 건너뜀: ${outcome.spawnError}` }
    if (outcome.exitCode !== 0)
      return { ok: false, detail: 'codex 로그인 필요 — `codex login`' }
    return { ok: true, detail: outcome.stdout.trim() || undefined }
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    // cwd는 -C로 넘긴다. codex가 작업 루트를 스스로 정하므로 프로세스 cwd와 일치시켜 둔다
    const outcome = await runProcess([this.binary, ...this.buildArgs(request)], {
      cwd: request.cwd,
      idleTimeoutMs: this.options.idleTimeoutMs,
    })
    return toAgentResult('codex', outcome, parseCodexStream(outcome.stdout))
  }
}
