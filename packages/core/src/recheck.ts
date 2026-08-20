/**
 * 재현되지 않는 통과는 증거가 아니다.
 *
 * 게이트를 한 번만 돌리면 간헐적으로 통과하는 테스트가 그대로 완료 선언이 된다.
 * 그래서 **모든 게이트가 통과한 라운드에서만** 게이트를 더 돌려 재현을 확인한다.
 * 실패한 라운드는 재확인하지 않는다 — 어차피 다음 시도로 넘어가고, 실패의 재현은
 * 이 도구가 답해야 할 질문이 아니다. 비용이 성공 시 한 번으로 묶이는 것도 같은 이유다.
 */
import type { Evidence, Gate } from './goal'
import type { GateWarning } from './gates'

/** 기본값 1 = 재확인 없음. 값을 올리는 것은 사용자의 명시적 선택이어야 한다(그만큼 느려진다) */
export const DEFAULT_VERIFY_REPEAT = 1

/**
 * 결과를 캐시하거나 증분으로 건너뛰는 빌드 도구들.
 *
 * 재확인의 전제는 "같은 명령을 다시 돌리면 같은 일이 다시 일어난다"인데, 이 도구들에서는
 * 그 전제가 성립하지 않는다 — 두 번째 실행이 UP-TO-DATE로 스킵되면 재확인은 아무것도
 * 확인하지 못한 채 통과한다. 실전에서 정확히 이 일이 있었다(gradle).
 */
const CACHING_BUILD_TOOLS = /(^|\/|\s)(gradlew?|mvn|mvnw|bazel|buck2?|sbt|turbo|nx|make)(\s|$)/

/** 캐시를 무르는 신호. 하나라도 있으면 사용자가 이미 알고 대비한 것으로 본다 */
const CACHE_BUSTING = /(\bclean\w*|--rerun-tasks|--no-build-cache|--no-daemon|-B\b|--force)/i

/**
 * 재확인이 헛돌 위험을 짚는다. 실행을 막지는 않는다(advisory) — 게이트가 어떻게 도는지는
 * 사용자가 우리보다 잘 알고, 여기서 확실히 말할 수 있는 것은 "그럴 수 있다"까지다.
 *
 * **오탐이 난다.** 실측에서 `outputs.upToDateWhen { false }`로 캐시를 이미 끈 게이트 둘에
 * 경고가 떴다(그 둘은 실제로 매번 돌았다 — 소요시간 비율 0.69·0.86이 증거다). 명령 문자열만
 * 보는 검사의 한계이고, 그래서 {@link recheckSuspects}가 실행 후 소요시간으로 다시 본다.
 * 둘은 경쟁하지 않고 **상보적**이다 — 사전 경고는 미리 말할 수 있고 사후 감지는 정확하다.
 *
 * 이 경고가 없으면 러너는 아무것도 확인하지 못한 채 "재확인했다"고 말하게 된다.
 * 검증 우선을 표방하는 도구에서 **거짓 안심은 검사를 안 하느니만 못하다.**
 */
export function recheckWarnings(gates: Gate[], repeat: number): GateWarning[] {
  if (repeat <= 1) return []
  return gates
    .filter(g => CACHING_BUILD_TOOLS.test(g.cmd) && !CACHE_BUSTING.test(g.cmd))
    .map(g => ({
      gate: g.name,
      cmd: g.cmd,
      kind: 'advisory' as const,
      reason:
        '재확인이 헛돌 수 있습니다 — 이 빌드 도구는 변경이 없으면 작업을 건너뜁니다. ' +
        '게이트 명령에 clean 단계를 포함해야 두 번째 실행이 실제로 다시 돕니다. ' +
        '다만 이 경고는 명령 문자열만 보므로 빌드 스크립트가 이미 캐시를 끈 경우(예: ' +
        'outputs.upToDateWhen { false })에도 뜬다 — 실제로 헛돌았는지는 실행 후 소요시간으로 다시 본다',
    }))
}

/**
 * 재확인이 첫 회보다 이 비율 미만으로 걸렸으면 짚는다 (2.5배 넘게 빨랐다는 뜻).
 *
 * 실측 근거: gradle 게이트가 첫 회 54.9s → 재확인 14.8s(0.27)로 UP-TO-DATE 스킵된 사례.
 * 더 느슨하게(0.5) 잡으면 데몬이 덥혀져 정직하게 두 배 빨라진 실행까지 걸리고, 더 빡빡하게
 * (0.25) 잡으면 그 실측 사례를 놓친다. 어차피 확정 판정이 아니라 사람이 볼 숫자를 띄우는 것이
 * 목적이므로 실측을 잡는 쪽에 맞췄다.
 */
export const RECHECK_FAST_RATIO = 0.4

/**
 * 첫 회가 이보다 짧으면 판단하지 않는다. 짧은 명령은 프로세스 기동 편차가 소요시간을
 * 지배해서 비율이 아무것도 뜻하지 않는다.
 */
export const RECHECK_MIN_MS = 5_000

/** 재확인이 실제로 다시 돌지 않았을 수 있다는 정황 한 건 */
export interface RecheckSuspect {
  gate: string
  /** 그 라운드 첫 실행의 소요시간 */
  firstMs: number
  /** 재확인 중 가장 짧았던 소요시간 — 스킵의 신호가 가장 강한 회차 */
  recheckMs: number
}

/**
 * 재확인이 헛돌았을 정황을 **사후에** 짚는다.
 *
 * {@link recheckWarnings}는 명령어 문자열만 보고 미리 경고하는 휴리스틱이라, 이름이 다른
 * 래퍼 스크립트나 처음 보는 빌드 도구에는 뚫린다. 소요시간은 그와 달리 **일이 실제로
 * 일어나지 않았다는 직접 신호**다 — 같은 리비전에 같은 명령인데 2.5배 넘게 빨랐다면
 * 두 번째 실행은 첫 번째와 같은 일을 하지 않았다.
 *
 * 확정 판정은 하지 않는다. 데몬이 덥혀지거나 OS 페이지 캐시가 채워져 정직하게 빨라지는
 * 경우도 있기 때문이다. 그래서 실행 상태를 바꾸지 않고 숫자를 사람 앞에 놓기만 한다.
 */
export function recheckSuspects(first: Evidence[], recheck: Evidence[]): RecheckSuspect[] {
  const suspects: RecheckSuspect[] = []
  for (const origin of first) {
    if (origin.outcome !== 'pass' || origin.durationMs < RECHECK_MIN_MS) continue
    const durations = recheck.filter(e => e.gate === origin.gate).map(e => e.durationMs)
    if (durations.length === 0) continue
    const fastest = Math.min(...durations)
    if (fastest < origin.durationMs * RECHECK_FAST_RATIO)
      suspects.push({ gate: origin.gate, firstMs: origin.durationMs, recheckMs: fastest })
  }
  return suspects
}

export interface RecheckResult {
  /** 추가 실행에서 나온 증거. 원본을 덮어쓰지 않고 나란히 쌓인다 */
  evidence: Evidence[]
  /**
   * 재확인에서 통과가 재현되지 않은 게이트 이름.
   *
   * `flaky`라 부르지 않는 이유: 실전에서 여기 걸린 첫 사례는 간헐적 실패가 아니라
   * **두 번째 실행부터 항상 실패**하는 결정론적 결함이었다(전역 집계가 이전 실행 로그까지 셌다).
   * 이름이 원인을 간헐성으로 좁히면 사람이 그쪽만 뒤진다. 여기서 확실히 말할 수 있는 것은
   * "재현되지 않았다"까지다.
   */
  unreproduced: string[]
}

/**
 * 통과한 게이트들을 `repeat - 1`번 더 돌린다.
 *
 * 한 게이트가 갈리는 순간 나머지 반복을 계속할 이유는 없지만, 그 라운드의 다른 게이트도
 * 갈리는지는 알아야 진단이 된다 — 그래서 회차는 끊되 게이트는 전부 돈다.
 */
export async function recheckGates(
  gates: Gate[],
  repeat: number,
  run: (gate: Gate) => Promise<Evidence>,
): Promise<RecheckResult> {
  const evidence: Evidence[] = []
  const unreproduced = new Set<string>()
  for (let pass = 1; pass < repeat; pass++) {
    for (const gate of gates) {
      const result = await run(gate)
      evidence.push(result)
      if (result.outcome !== 'pass') unreproduced.add(gate.name)
    }
    if (unreproduced.size > 0) break
  }
  return { evidence, unreproduced: [...unreproduced] }
}
