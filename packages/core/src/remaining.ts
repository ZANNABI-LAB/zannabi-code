/**
 * 남은 일 — 아직 통과하지 못한 게이트.
 *
 * **왜 라운드 성공/실패로는 부족한가**: 지금 라운드는 통째로 성공이거나 실패라서,
 * 게이트 5개 중 4개가 통과로 바뀐 라운드와 여전히 5개 다 실패인 라운드가 **같아 보인다.**
 * `build`는 통과인데 `api-auth`가 빨간 것 — 그것이 "할 일 하나"의 객관 버전인데
 * "라운드 실패"라는 한 마디로 뭉개져 있었다.
 *
 * gajae-code의 `ultragoal`은 실패하면 라운드를 더 쓰는 대신 **blocker story를 하나 더
 * 만든다.** 그 착안을 여기서 빌리되 저쪽과 결정적으로 다른 점이 있다 — 저쪽 blocker는
 * **에이전트가 판단해** 만들고, 우리 남은 일은 **게이트 종료코드**가 만든다.
 *
 * ⚠️ **이것을 종료 조건으로 쓰지 않는다.** "남은 일이 안 줄면 정체"는 그럴듯하지만
 * 실측이 이미 반증한 규칙이다(B2는 게이트 결과가 같은 2라운드 뒤에 진전했다).
 * 여기서 만드는 것은 **판정이 아니라 화면**이다 — 자세한 근거는 `progress.ts` 머리글.
 */
import type { Evidence, Round } from './goal'

export interface RemainingWork {
  /** 아직 통과하지 못한 게이트. 비면 완료다 */
  open: string[]
  /** 이번 라운드에 **처음** 통과한 게이트 */
  closed: string[]
  /**
   * 앞 라운드에서 통과했는데 이번에 다시 실패한 게이트 — **고치다 깬 자리다.**
   *
   * 이 축이 없으면 "남은 일 2건"이 두 경우를 뭉갠다: 처음부터 못 푼 2건과,
   * 하나를 풀면서 다른 하나를 깨 생긴 2건. 뒤쪽은 접근 자체를 바꿔야 한다는 신호라
   * 다음 라운드에 전할 말이 다르다.
   */
  reopened: string[]
}

/** 통과하지 못한 게이트 이름. `error`(실행 자체 실패)도 통과가 아니므로 남은 일이다 */
export function openGates(evidence: Evidence[]): string[] {
  return evidence.filter(e => e.outcome !== 'pass').map(e => e.gate)
}

/**
 * 마지막 라운드 기준의 남은 일과, 앞 라운드 대비 무엇이 닫히고 무엇이 되열렸는지.
 *
 * 라운드가 하나뿐이면 `closed`·`reopened`는 비어 있다 — 비교할 앞이 없을 때
 * "전부 새로 닫았다"고 말하면 첫 라운드가 늘 진전으로 보인다.
 */
export function remainingWork(rounds: Round[]): RemainingWork {
  const last = rounds[rounds.length - 1]
  if (!last) return { open: [], closed: [], reopened: [] }
  const open = openGates(last.evidence)
  const prev = rounds[rounds.length - 2]
  if (!prev) return { open, closed: [], reopened: [] }
  const openBefore = new Set(openGates(prev.evidence))
  const openNow = new Set(open)
  return {
    open,
    closed: [...openBefore].filter(g => !openNow.has(g)),
    // 앞 라운드에 통과였는데(= openBefore에 없음) 지금 실패인 것
    reopened: open.filter(g => !openBefore.has(g) && prev.evidence.some(e => e.gate === g)),
  }
}
