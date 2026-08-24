import type { ProcessOutcome } from './proc'
// 스키마는 goal.ts가 갖는다 — 저널과 이 계약이 같은 모양을 써야 갈리지 않는다
import type { SelfCheck } from './goal'
export type { SelfCheck } from './goal'

export interface AgentRequest {
  prompt: string
  cwd: string
  resumeSessionId?: string
  /**
   * 이 턴에서 에이전트가 **스스로 돌려도 되는 명령**. 게이트의 `cmd`가 그대로 들어온다.
   *
   * **판정과는 다른 층이다.** 여기서 에이전트가 게이트를 백 번 돌려도 완료는 러너가
   * 돌린 결과로만 정해진다. 이것은 **자기 확인**이다 — 오타 하나를 라운드 하나
   * ($2~3)로 갚지 않게 하는 용도다. 실측에서 에이전트가 컴파일 0회로 1,092줄을 썼다.
   *
   * **왜 게이트 명령만인가.** 러너가 어차피 돌릴 명령이므로 새 위험이 생기지 않고,
   * "에이전트는 완료의 정의를 스스로 확인할 수 있다"는 원칙이 그대로 선다.
   * 넓게 열면 편해지지만 그 순간 러너가 준 권한을 러너가 설명할 수 없게 된다.
   *
   * 비어 있거나 없으면 어떤 명령도 열지 않는다. **해석은 어댑터의 몫이다** —
   * core는 claude의 `--allowedTools`도 codex의 샌드박스도 모른다.
   */
  allowedCommands?: string[]
}

export interface AgentEvent {
  type: string
  timestamp: string
  payload: unknown
}

/**
 * 한 턴의 사용량. 어느 CLI든 토큰은 주지만 **비용은 주는 쪽과 안 주는 쪽이 갈린다**.
 * 그래서 costUsd는 선택이고, 없을 때 0으로 채우지 않는다 — 0원과 "모름"은 다른 사실이고,
 * 조합별 비용을 비교하는 것이 이 축의 목적이라 그 차이를 뭉개면 축 자체가 못 쓰게 된다.
 */
export interface Usage {
  /**
   * **캐시에 없던** 입력 토큰. `cachedInputTokens`와 겹치지 않는다.
   *
   * CLI마다 원본 필드의 뜻이 다르다 — claude의 `input_tokens`는 캐시 읽기와 별개고,
   * codex의 `input_tokens`는 캐시 읽기를 **포함한다**. 그대로 한 열에 담으면 조합 비교가
   * 성립하지 않고 합계 행도 뜻이 깨지므로, {@link readUsage}가 어댑터 경계에서 뺄셈해
   * 두 축이 언제나 배타적이 되게 맞춘다. 총 입력은 두 값을 더하면 된다.
   */
  inputTokens: number
  outputTokens: number
  /** 캐시에서 읽은 입력 토큰. 청구는 대개 이쪽이 싸다 */
  cachedInputTokens?: number
  costUsd?: number
  /** 이 값이 몇 번의 에이전트 턴을 합친 것인지 */
  turns: number
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, turns: 0 }
}

/** 턴 사용량 누적. 어느 한쪽만 비용을 보고해도 합계는 "보고된 만큼"을 유지한다 */
export function addUsage(base: Usage, next?: Usage): Usage {
  if (!next) return base
  const cached = (base.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0)
  const cost =
    base.costUsd === undefined && next.costUsd === undefined
      ? undefined
      : (base.costUsd ?? 0) + (next.costUsd ?? 0)
  return {
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(cost === undefined ? {} : { costUsd: cost }),
    turns: base.turns + next.turns,
  }
}

export interface AgentResult {
  ok: boolean
  sessionId?: string
  finalText: string
  events: AgentEvent[]
  /** 실패 사유 한 줄. ok=false일 때만 의미가 있다 — 진단이 transcript 파싱을 요구하지 않게 한다 */
  errorReason?: string
  /** 이 턴이 쓴 자원. 어댑터가 보고하지 않으면 없다 */
  usage?: Usage
  /**
   * 런타임이 **실제로 쓴** 모델. 우리가 지정한 것이 아니라 그쪽이 보고한 값이다.
   *
   * 왜 필요한가: 모델은 `--model` 말고도 정해진다(환경변수·프로필·CLI 기본값).
   * 우리가 넘긴 값만 기록하면 `ANTHROPIC_MODEL=claude-opus-5`로 띄운 실행이
   * `claude:default`로 남는다 — 실측에서 정확히 그 일이 있었고,
   * **조합별 비교가 측정의 축인데 그 축이 비어서 기록됐다.**
   */
  model?: string
  /**
   * 이 턴에서 에이전트가 **스스로 돌린** 명령들.
   *
   * 러너가 판정으로 돌린 게이트와 **다른 층**이다. 이것이 없으면 "에이전트가 자기 코드를
   * 확인하고 썼는가"를 밖에서 물을 수 없고, 그 질문이 이 축의 값 전부다.
   */
  selfChecks?: SelfCheck[]
}

/** 어댑터가 구동 가능한 상태인지 — 인증 만료처럼 실행 전에 알 수 있는 것만 본다 */
export interface PreflightResult {
  ok: boolean
  detail?: string
}

export interface AgentAdapter {
  readonly name: string
  run(request: AgentRequest): Promise<AgentResult>
  /** 선택 구현. core는 어떤 에이전트의 존재도 모르므로 검사 내용은 어댑터가 정한다 */
  preflight?(): Promise<PreflightResult>
}

/** 어댑터가 자기 CLI의 출력 형식을 해석해 내놓는 중립 형태 */
export interface ParsedAgentStream {
  /** 런타임이 스스로 보고한 모델. 어댑터가 알아내지 못하면 없다 */
  model?: string
  sessionId?: string
  finalText: string
  ok: boolean
  events: AgentEvent[]
  errorReason?: string
  usage?: Usage
  /** 이 턴에서 에이전트가 **시도한** 자기 확인. 어댑터가 알아내지 못하면 없다 */
  selfChecks?: SelfCheck[]
}

/**
 * CLI가 내놓은 usage 객체를 중립 형태로 옮긴다.
 *
 * 필드명이 러너마다 다르므로 후보 이름을 받아 첫 번째로 발견되는 숫자를 쓴다.
 * 형태가 바뀌면 조용히 0이 되는 대신 필드가 없는 것으로 남는다 — 없는 값을 0으로
 * 위조하지 않는 것이 이 축의 전제다.
 */
export interface UsageKeys {
  input: string[]
  output: string[]
  cached: string[]
  /**
   * 이 CLI의 입력 토큰 필드가 캐시 읽기를 **포함**하면 true (codex가 그렇다).
   * 그때는 캐시분을 빼서 {@link Usage.inputTokens}의 뜻을 어댑터끼리 맞춘다.
   */
  cachedInsideInput?: boolean
}

export function readUsage(
  raw: unknown,
  names: UsageKeys,
  costUsd?: unknown,
): Usage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const pick = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return undefined
  }
  const input = pick(names.input)
  const output = pick(names.output)
  if (input === undefined && output === undefined) return undefined
  const cached = pick(names.cached)
  // 뺄셈이 음수가 되면 이 CLI가 포함 관계라는 전제가 틀렸다는 뜻이다. 음수를 싣느니
  // 0으로 막는다 — 합계가 음수인 표는 읽는 사람이 어느 쪽을 의심해야 할지 알 수 없다
  const uncached =
    names.cachedInsideInput && input !== undefined && cached !== undefined
      ? Math.max(0, input - cached)
      : input
  return {
    inputTokens: uncached ?? 0,
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
    turns: 1,
  }
}

const STDERR_TAIL_CHARS = 4000
const STDERR_REASON_CHARS = 200

/**
 * 프로세스 결과 + 해석된 스트림 → AgentResult.
 * 실패 판정과 사유 조립은 어느 CLI를 쓰든 같으므로 여기서 한 번만 한다.
 */
export function toAgentResult(
  label: string,
  outcome: ProcessOutcome,
  parsed: ParsedAgentStream,
): AgentResult {
  // usage는 성패와 무관하게 싣는다 — 실패한 턴도 청구되고, 실패 비용이야말로
  // 조합을 비교할 때 알아야 하는 값이다
  const base = {
    sessionId: parsed.sessionId,
    finalText: parsed.finalText,
    usage: parsed.usage,
    model: parsed.model,
    selfChecks: parsed.selfChecks,
  }

  if (outcome.spawnError)
    return { ...base, ok: false, events: parsed.events, errorReason: `${label} 실행 실패: ${outcome.spawnError}` }

  if (outcome.idleKilled)
    return {
      ...base,
      ok: false,
      events: parsed.events,
      errorReason: `출력이 ${outcome.idleTimeoutMs}ms 동안 없어 종료시켰습니다 (에이전트 행)`,
    }

  const ok = outcome.exitCode === 0 && parsed.ok
  const events = [...parsed.events]
  // 실패 시 진단: stderr 꼬리를 이벤트로 남긴다
  if (!ok && outcome.stderr)
    events.push({
      type: 'stderr',
      timestamp: new Date().toISOString(),
      payload: { text: outcome.stderr.slice(-STDERR_TAIL_CHARS) },
    })

  if (ok) return { ...base, ok, events }

  const parts = [`exit ${outcome.exitCode}`]
  if (parsed.errorReason) parts.push(parsed.errorReason)
  const lastLine = outcome.stderr.trim().split('\n').filter(Boolean).at(-1)
  if (lastLine) parts.push(`stderr: ${lastLine.slice(-STDERR_REASON_CHARS)}`)
  return { ...base, ok, events, errorReason: parts.join(' | ') }
}
