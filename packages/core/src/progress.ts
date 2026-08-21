/**
 * 라운드가 정말 제자리인지 판정한다.
 *
 * 실측이 순진한 규칙을 반증했다: 게이트 결과가 같다고 정체는 아니다.
 * (C2는 3라운드가 완전히 동일했지만, B2는 결과가 같은 2라운드 뒤에 진전했다.)
 * 그래서 **게이트 결과와 워킹트리 변경분을 함께** 본다 — 파일이 달라졌다면
 * 같은 실패를 다시 봤더라도 다른 시도를 한 것이므로 진전으로 친다.
 *
 * **거의 발동하지 않는 최후 안전망이다.** 정체를 일부러 일으키려 세 번 시도해 세 번 다
 * 감지되지 않았고 이유가 전부 달랐다(막힌 에이전트도 diff는 계속 바뀐다 · 대상 저장소 안에
 * 쌓이는 로그 파일 · A-B-A-B 왕복). 11회 실측에서도 미발동. 남긴 이유는 설계 근거가 실측이고
 * 오발동이 0회라서지, 자주 값을 내기 때문이 아니다.
 */
import type { Evidence, Revision, Round } from './goal'

/** 기본 한계. C2(3라운드 동일)는 잡고 B2(2라운드 동일 후 진전)는 살리는 자리다 */
export const DEFAULT_STALL_LIMIT = 3

export function roundSignature(revision: Revision, evidence: Evidence[]): string {
  return [
    revision.diffHash ?? 'untracked',
    ...evidence.map(e => `${e.gate}=${e.outcome}:${e.exitCode}`),
  ].join('|')
}

/**
 * 직전 라운드들과 서명이 같은 가장 이른 라운드 번호. 없으면 undefined.
 *
 * 연속된 꼬리만 본다 — A B A처럼 사이에 다른 시도가 낀 경우는 정체가 아니라 왕복이고,
 * 그것을 정체로 부르면 되돌아가며 탐색하는 정상 동작을 끊는다.
 */
export function repeatOf(previous: Round[], signature: string): number | undefined {
  let found: number | undefined
  for (let i = previous.length - 1; i >= 0; i--) {
    const round = previous[i]
    if (roundSignature(round.revision, round.evidence) !== signature) break
    found = round.round
  }
  return found
}

/**
 * 정체로 루프를 끊을지. limit이 0 이하면 감지를 끈다.
 *
 * 리비전을 못 읽는 환경(git 아님)에서는 **감지 자체를 하지 않는다.** 그때 남는 축은
 * 게이트 결과뿐인데, 그 축만으로 끊는 규칙이 바로 실측에서 틀린 것으로 드러난 규칙이다.
 */
export function shouldStop(rounds: Round[], limit: number): boolean {
  if (limit <= 0 || rounds.length < limit) return false
  const tail = rounds.slice(-limit)
  if (!tail.every(r => r.revision.tracked && r.revision.diffHash !== null)) return false
  const signature = roundSignature(tail[0].revision, tail[0].evidence)
  return tail.every(r => roundSignature(r.revision, r.evidence) === signature)
}

/**
 * 정체 감지가 이 예산에서 아무것도 구할 수 없는 조합인지.
 *
 * 감지는 **연속 `limit` 라운드**가 같아야 발동하는데, 예산이 그 이하면 발동 시점이
 * 마지막 라운드이거나 아예 오지 않는다. 즉 남길 예산이 없어 감지가 있으나 마나가 된다.
 * 실측에서 걸렸다: 라운드 1·2의 diff 해시가 완전히 같았는데도(`stallLimit` 3, 예산 3)
 * 감지가 발동하지 않고 예산 소진으로 끝났다.
 *
 * 조용히 예산을 늘리거나 한계를 낮추지 않는다 — 둘 다 사용자가 정한 실행 조건이고,
 * 도구가 그것을 뒤에서 바꾸면 실행끼리 비교하는 이 프로젝트의 측정이 무너진다.
 * 대신 조합이 죽어 있다는 사실을 말한다.
 */
export function stallDetectionDead(stallLimit: number, budget: number): boolean {
  return stallLimit > 0 && stallLimit >= budget
}
