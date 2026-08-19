import type { ProcessOutcome } from './proc'

export interface AgentRequest {
  prompt: string
  cwd: string
  resumeSessionId?: string
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
  sessionId?: string
  finalText: string
  ok: boolean
  events: AgentEvent[]
  errorReason?: string
  usage?: Usage
}

/**
 * CLI가 내놓은 usage 객체를 중립 형태로 옮긴다.
 *
 * 필드명이 러너마다 다르므로 후보 이름을 받아 첫 번째로 발견되는 숫자를 쓴다.
 * 형태가 바뀌면 조용히 0이 되는 대신 필드가 없는 것으로 남는다 — 없는 값을 0으로
 * 위조하지 않는 것이 이 축의 전제다.
 */
export function readUsage(
  raw: unknown,
  names: { input: string[]; output: string[]; cached: string[] },
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
  return {
    inputTokens: input ?? 0,
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
  const base = { sessionId: parsed.sessionId, finalText: parsed.finalText, usage: parsed.usage }

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
