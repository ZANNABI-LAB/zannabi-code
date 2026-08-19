/**
 * 재현되지 않는 통과는 증거가 아니다.
 *
 * 게이트를 한 번만 돌리면 간헐적으로 통과하는 테스트가 그대로 완료 선언이 된다.
 * 그래서 **모든 게이트가 통과한 라운드에서만** 게이트를 더 돌려 재현을 확인한다.
 * 실패한 라운드는 재확인하지 않는다 — 어차피 다음 시도로 넘어가고, 실패의 재현은
 * 이 도구가 답해야 할 질문이 아니다. 비용이 성공 시 한 번으로 묶이는 것도 같은 이유다.
 */
import type { Evidence, Gate } from './goal'

/** 기본값 1 = 재확인 없음. 값을 올리는 것은 사용자의 명시적 선택이어야 한다(그만큼 느려진다) */
export const DEFAULT_VERIFY_REPEAT = 1

export interface RecheckResult {
  /** 추가 실행에서 나온 증거. 원본을 덮어쓰지 않고 나란히 쌓인다 */
  evidence: Evidence[]
  /** 한 번이라도 통과하지 않은 게이트 이름 */
  flaky: string[]
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
  const flaky = new Set<string>()
  for (let pass = 1; pass < repeat; pass++) {
    for (const gate of gates) {
      const result = await run(gate)
      evidence.push(result)
      if (result.outcome !== 'pass') flaky.add(gate.name)
    }
    if (flaky.size > 0) break
  }
  return { evidence, flaky: [...flaky] }
}
