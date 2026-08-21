/**
 * 재현되지 않는 통과는 증거가 아니다.
 *
 * 모든 게이트가 통과한 라운드에서만 게이트를 더 돌려 재현을 확인한다. 실패한 라운드는
 * 재확인하지 않는다 — 어차피 다음 시도로 넘어가고, 실패의 재현은 이 도구가 답해야 할
 * 질문이 아니다. 비용이 성공 시 한 번으로 묶이는 것도 같은 이유다.
 *
 * **이것이 실제로 검사하는 것은 게이트의 멱등성이다.** 이름이 "flaky"였을 때의 서사는
 * 간헐적 실패 탐지였지만, 실적을 그대로 보면 다르다. `N=2`가 잡을 확률은:
 *   · 멱등성 위반(2회차부터 항상 실패) → 사실상 100%
 *   · 고빈도 간헐 실패(p=0.6) → 60%
 *   · 전형적 간헐 실패(p=0.1~0.2) → 10~20%
 * 실전에서 잡은 유일한 결함도 간헐이 아니라 **이전 실행이 남긴 상태**였다.
 * 저빈도 경합을 잡으려면 10회 넘게 돌려야 하는데 그건 이 도구가 팔 물건이 아니다.
 * **"게이트가 두 번 돌면 같은 답을 내는가"** — 게이트를 러너가 직접 실행하는 구조에서만
 * 값싸게 물을 수 있는 질문이고, 그것이 이 기능의 자리다.
 */
import type { Evidence, Gate } from './goal'

/** 기본값 1 = 재확인 없음. 값을 올리는 것은 사용자의 명시적 선택이어야 한다(그만큼 느려진다) */
export const DEFAULT_VERIFY_REPEAT = 1

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

/**
 * 청소를 명시한 명령이 이보다 빨리 끝나면, 비율과 무관하게 짚는다.
 *
 * **실측이 비율 축의 사각을 드러냈다.** `:csms:cleanTest build`가 첫 회 2075ms /
 * 재확인 1159ms로 비율 0.56이라 임계(0.4)를 안 넘었고, 첫 회가 5초 미만이라
 * {@link RECHECK_MIN_MS}에도 걸러졌다. 그런데 그 게이트는 **시험이 한 번도 돈 적 없는
 * 초록**이었다(대상 저장소의 빌드 캐시가 clean 뒤의 재컴파일까지 건너뛰었다).
 * 비율은 "두 번째가 첫 번째보다 빨랐는가"만 묻는다 — **첫 회부터 헛돌면 둘 다 빠르고
 * 비율은 1에 가까워 정상으로 보인다.**
 *
 * clean·cleanTest를 명시한 빌드가 몇 초에 끝나는 것은 일이 일어나지 않았다는 직접 신호다.
 */
export const CLEAN_MIN_MS = 10_000

/** 청소를 명시하는 토큰. 도구 이름이 아니라 **의도**를 보는 것이라 래퍼 스크립트에도 걸린다 */
const CLEAN_TOKENS = /\b(clean|cleanTest|cleanBuild|clean-test|distclean)\b/i

/** 재확인이 실제로 다시 돌지 않았을 수 있다는 정황 한 건 */
export interface RecheckSuspect {
  gate: string
  /** 그 라운드 첫 실행의 소요시간 */
  firstMs: number
  /** 재확인 중 가장 짧았던 소요시간 — 스킵의 신호가 가장 강한 회차 */
  recheckMs: number
  /**
   * 무엇이 이 정황을 만들었나.
   * `ratio`는 재확인이 첫 회보다 크게 빨랐다는 뜻이고,
   * `clean-too-fast`는 **첫 회부터** 청소 명령이 말이 안 되게 빨리 끝났다는 뜻이다.
   */
  reason: 'ratio' | 'clean-too-fast'
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
    if (origin.outcome !== 'pass') continue
    const durations = recheck.filter(e => e.gate === origin.gate).map(e => e.durationMs)
    if (durations.length === 0) continue
    const fastest = Math.min(...durations)

    // 축 1 — 재확인이 첫 회보다 크게 빨랐다. 짧은 명령은 프로세스 기동 편차가
    // 소요시간을 지배하므로 비율을 묻지 않는다
    if (origin.durationMs >= RECHECK_MIN_MS && fastest < origin.durationMs * RECHECK_FAST_RATIO) {
      suspects.push({
        gate: origin.gate, firstMs: origin.durationMs, recheckMs: fastest, reason: 'ratio',
      })
      continue
    }

    // 축 2 — 첫 회부터 헛돈 경우. 비율은 이것을 볼 수 없다(둘 다 빠르면 비율은 1에 가깝다).
    // 명령 문자열을 보지만 **사전 경고가 아니다**: 지웠던 그 검사는 명령만 보고 미리
    // 짚어 오탐만 냈고, 이것은 명령의 의도와 **실측된 소요시간을 함께** 본다.
    // "clean을 붙였는데 실제로 2초에 끝났다"는 관측이지 추측이 아니다
    if (CLEAN_TOKENS.test(origin.cmd) && origin.durationMs < CLEAN_MIN_MS)
      suspects.push({
        gate: origin.gate, firstMs: origin.durationMs, recheckMs: fastest, reason: 'clean-too-fast',
      })
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
