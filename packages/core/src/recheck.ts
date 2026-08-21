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
 *
 * **2차 실측이 임계를 낮추게 했다.** 10초로 뒀더니 `api-auth`(첫 회 9769ms)가 걸렸는데,
 * 재확인이 오히려 더 느렸다(11030ms) — 시험은 실제로 돌았다. 그 저장소의 정직한 게이트가
 * 9.3~13.6초라 임계 10초가 **한가운데**에 있었다. 5초로 내리면 실측의 진짜 결함
 * (2075ms)은 그대로 잡고 정직한 게이트는 놓아준다.
 */
export const CLEAN_MIN_MS = 5_000

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
export interface RecheckSuspectOptions {
  /**
   * 이 라운드의 첫 회가 **차가운 상태**에서 돌았는가(격리된 새 워킹트리의 첫 라운드).
   *
   * 그러면 비율 축을 끈다. 2차 실측에서 워크트리의 첫 `build`가 콜드 컴파일을 포함해
   * 52.6초였고 재확인은 시험만 19.7초였다 — 비율 0.37로 걸렸지만 **정직하게 빨라진 것**이다.
   * 워크트리의 라운드 1 첫 회는 언제나 이 모양이므로 구조적 오탐이다.
   * 절대 시간 축(clean-too-fast)은 그대로 둔다 — 그쪽은 콜드와 무관하게 유효하다.
   */
  coldFirstRun?: boolean
}

export function recheckSuspects(
  first: Evidence[],
  recheck: Evidence[],
  opts: RecheckSuspectOptions = {},
): RecheckSuspect[] {
  const suspects: RecheckSuspect[] = []
  for (const origin of first) {
    if (origin.outcome !== 'pass') continue
    const durations = recheck.filter(e => e.gate === origin.gate).map(e => e.durationMs)
    if (durations.length === 0) continue
    const fastest = Math.min(...durations)

    // 축 1 — 재확인이 첫 회보다 크게 빨랐다. 짧은 명령은 프로세스 기동 편차가
    // 소요시간을 지배하므로 비율을 묻지 않는다
    if (
      !opts.coldFirstRun &&
      origin.durationMs >= RECHECK_MIN_MS &&
      fastest < origin.durationMs * RECHECK_FAST_RATIO
    ) {
      suspects.push({
        gate: origin.gate, firstMs: origin.durationMs, recheckMs: fastest, reason: 'ratio',
      })
      continue
    }

    // 축 2 — 첫 회부터 헛돈 경우. 비율은 이것을 볼 수 없다(둘 다 빠르면 비율은 1에 가깝다).
    // 명령 문자열을 보지만 **사전 경고가 아니다**: 지웠던 그 검사는 명령만 보고 미리
    // 짚어 오탐만 냈고, 이것은 명령의 의도와 **실측된 소요시간을 함께** 본다.
    // "clean을 붙였는데 실제로 2초에 끝났다"는 관측이지 추측이 아니다.
    //
    // **재확인이 더 느렸으면 짚지 않는다.** 두 번째가 첫 번째보다 오래 걸렸다는 것은
    // 일이 실제로 일어났다는 증거다 — 캐시로 스킵됐다면 그럴 수 없다.
    // 2차 실측의 오탐(9769ms → 11030ms)이 정확히 이 모양이었다
    if (
      CLEAN_TOKENS.test(origin.cmd) &&
      origin.durationMs < CLEAN_MIN_MS &&
      fastest < origin.durationMs
    )
      suspects.push({
        gate: origin.gate, firstMs: origin.durationMs, recheckMs: fastest, reason: 'clean-too-fast',
      })
  }
  return suspects
}

/**
 * 콜드 첫 회 억제가 **삼킨** 후보 — 억제가 없었다면 비율 축으로 짚였을 게이트들.
 *
 * 억제는 축을 끄는 것이라 먹었을 때의 증상이 "경고가 없다"이다. 그 모양은
 * *억제가 일했다*와 *애초에 걸릴 자리가 아니었다*를 구분하지 못한다 — 3차 실측이
 * 정확히 여기서 막혔다(워크트리로 돌렸지만 비율이 0.57이라 판단할 재료가 없었다).
 *
 * 그래서 억제된 것을 따로 세어 저널에 남긴다. **검증을 위해서가 아니라 관측을 위해서다**:
 * 억제가 잘못 걸려 진짜 캐시 스킵을 삼켜도, 이 값이 없으면 그 사실이 아무 데도 남지 않는다.
 * 그쪽이 거짓 초록으로 가는 경로다.
 */
export function suppressedByCold(first: Evidence[], recheck: Evidence[]): RecheckSuspect[] {
  return recheckSuspects(first, recheck).filter(s => s.reason === 'ratio')
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
