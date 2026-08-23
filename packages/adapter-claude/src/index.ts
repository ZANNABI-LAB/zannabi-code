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

/**
 * 게이트 명령을 claude의 `--allowedTools` 패턴으로 옮긴다.
 *
 * **접두 매칭이다**(`Bash(./gradlew test*)`). 정확히 일치만 허용하면 에이전트가
 * `--info` 하나만 붙여도 막히고, 그러면 열어 준 의미가 없다. 반대로 명령 이름까지만
 * 열면(`Bash(./gradlew *)`) 게이트가 아닌 하위 명령까지 딸려 들어온다 —
 * 이쪽은 러너가 준 권한을 러너가 설명할 수 없게 되는 쪽이라 택하지 않았다.
 *
 * 닫는 괄호가 든 명령은 **버린다.** 패턴 문법을 깨뜨려 의도하지 않은 범위가 열릴 수
 * 있는데, 조용히 넓히느니 그 게이트 하나를 자기 확인에서 빼는 편이 낫다
 * (판정은 어차피 러너가 한다).
 */
export function allowedToolPatterns(commands?: string[]): string[] {
  const seen = new Set<string>()
  for (const cmd of commands ?? []) {
    const trimmed = cmd.trim()
    if (!trimmed || trimmed.includes(')')) continue
    seen.add(`Bash(${trimmed}*)`)
  }
  return [...seen]
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
    // 자기 확인용 명령을 연다. acceptEdits는 편집만 통과시키고 Bash는 승인 대기로
    // 떨어뜨리는데, 비대화형이라 그 승인은 영영 오지 않는다 — 실측에서 권한 거부 7건이
    // 전부 `./gradlew`였고 그 턴은 컴파일 한 번 없이 404줄을 썼다
    const allowed = allowedToolPatterns(request.allowedCommands)
    if (allowed.length > 0) args.push('--allowedTools', ...allowed)
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
