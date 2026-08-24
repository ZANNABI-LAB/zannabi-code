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
 * 이 명령을 자기 확인용으로 **열 수 있는가.**
 *
 * claude의 권한 규칙은 명령 문자열의 **접두**를 본다. 그래서 접두로 표현되지 않는 형태는
 * 패턴에 적어도 걸리지 않고 분류기로 떨어져 거부된다. 실측에서 세 건이 그렇게 막혔는데,
 * **그중 둘은 에이전트가 제안하고 러너가 승인한 게이트였다** — 자기가 쓴 문자열을 자기가
 * 그대로 쳤는데 막힌 것이다.
 *
 * 막히는 형태:
 * - **명령 치환**(`$(…)`, 백틱) — 매번 다른 문자열로 펼쳐지므로 접두가 성립하지 않는다.
 *   닫는 괄호가 패턴 문법(`Bash(…)`)까지 깨뜨린다.
 * - **선두 `!`** — 셸 부정. 규칙이 보는 첫 토큰이 명령이 아니게 된다.
 * - **연산자로 시작하는 복합** — 마찬가지로 첫 토큰이 명령이 아니다.
 *
 * 이 판정이 왜 어댑터에 있는가: **core는 claude의 권한 규칙을 모른다.** 다른 런타임은
 * 다른 규칙을 가지므로(codex는 샌드박스라 이 문제 자체가 없다) 판정도 런타임의 몫이다.
 */
function openable(cmd: string): boolean {
  const trimmed = cmd.trim()
  if (!trimmed) return false
  if (trimmed.includes('$(') || trimmed.includes('`') || trimmed.includes(')')) return false
  if (/^[!&|;(]/.test(trimmed)) return false
  return true
}

/**
 * 열 수 있는 명령만 골라 낸다. **루프는 이 답으로 프롬프트를 쓴다** —
 * 못 여는 것을 "쓸 수 있다"고 적으면 안내문이 거짓말이 되고, 에이전트는 정확히 베끼고도
 * 막혀 자기가 무엇을 틀렸는지 찾느라 시도를 한 번 더 쓴다.
 */
export function openableCommands(commands: string[]): string[] {
  return [...new Set(commands.filter(openable).map(c => c.trim()))]
}

/**
 * 게이트 명령을 claude의 `--allowedTools` 패턴으로 옮긴다.
 *
 * **접두 매칭이다**(`Bash(./gradlew test*)`). 정확히 일치만 허용하면 에이전트가
 * `--info` 하나만 붙여도 막히고, 그러면 열어 준 의미가 없다. 반대로 명령 이름까지만
 * 열면(`Bash(./gradlew *)`) 게이트가 아닌 하위 명령까지 딸려 들어온다 —
 * 이쪽은 러너가 준 권한을 러너가 설명할 수 없게 되는 쪽이라 택하지 않았다.
 */
export function allowedToolPatterns(commands?: string[]): string[] {
  return openableCommands(commands ?? []).map(c => `Bash(${c}*)`)
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude'

  constructor(private options: ClaudeAdapterOptions = {}) {}

  private get binary() {
    return this.options.binary ?? 'claude'
  }

  /**
   * 이 런타임이 자기 확인용으로 열 수 있는 명령. 루프가 프롬프트를 쓰기 전에 묻는다.
   *
   * **사후가 아니라 사전에 답해야 한다.** 열어 준 목록과 실제 열린 목록이 다른데 그 차이를
   * 아무도 모르면, 프롬프트가 못 쓰는 것을 쓸 수 있다고 말하게 된다.
   */
  openableCommands(commands: string[]): string[] {
    return openableCommands(commands)
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
