/**
 * `zannabi status` — 저널만 읽어 실행 상태를 말한다.
 *
 * **편의 기능이 아니라 계약의 검산이다.** 이 러너는 "저널만 있으면 밖에서 상태를 재구성할
 * 수 있다"고 주장하는데, 그 주장을 스스로 지키는지 확인할 방법이 없으면 주장으로 남는다. 이 명령은 `report.md`도 `evidence.json`도 읽지 않는다 —
 * 저널 한 파일에서 나오지 않는 정보는 여기 뜰 수 없고, 안 뜨면 계약이 부족한 것이다.
 *
 * 그래서 millim이 할 일을 러너가 미리 하는 것이 아니다. 같은 파일로 같은 것을 할 수 있다는
 * 증명이고, 화면은 millim의 몫이다.
 */
import type { ReplayState } from '@zannabi-lab/core'
import { resumability } from '@zannabi-lab/core'

/** 진행 중 상태는 사람의 말로 옮긴다 — `interrupted`가 무슨 뜻인지 사용자는 모른다 */
const PHASE_TEXT: Record<ReplayState['phase'], string> = {
  planning: '계획 수립 중',
  'awaiting-approval': '승인 대기 중',
  executing: '에이전트 실행 중',
  verifying: '게이트 검증 중',
  finished: '종료',
  interrupted: '이벤트가 끊김',
}

function costLine(state: ReplayState): string | undefined {
  if (state.spentUsd === undefined) {
    // "0원"이라고 적으면 공짜라는 거짓이 된다. 모름과 0은 다른 사실이다
    if (state.coverage === 'none') return '비용: 보고되지 않음 (이 런타임은 비용을 주지 않습니다)'
    return undefined
  }
  const limit = state.maxCostUsd === undefined ? '' : ` / 상한 $${state.maxCostUsd}`
  const partial = state.coverage === 'partial' ? ' — 지출의 일부만 본 금액입니다' : ''
  return `비용: $${state.spentUsd.toFixed(4)}${limit}${partial}`
}

export function renderStatus(state: ReplayState): string {
  const lines: string[] = []
  const head = state.phase === 'finished' ? `${PHASE_TEXT.finished} (${state.status})` : PHASE_TEXT[state.phase]
  lines.push(`실행: ${state.runId ?? '(알 수 없음)'}`)
  if (state.intent) lines.push(`의도: ${state.intent}`)
  lines.push(`상태: ${head}`)
  if (state.runtime) lines.push(`런타임: 계획 ${state.runtime.plan} · 실행 ${state.runtime.exec}`)
  if (state.profile) lines.push(`프리셋: ${state.profile}`)
  // 조 하나만 떼어 보는 사람에게 "이것은 비교의 일부였다"를 알린다
  if (state.raceId) lines.push(`best-of-N: ${state.raceId}의 조 하나입니다`)

  const budget = state.budget === undefined ? '?' : String(state.budget)
  lines.push(`라운드: ${state.rounds.length}/${budget} 완료`)
  for (const r of state.rounds) {
    const pass = r.evidence.filter(e => e.outcome === 'pass').length
    const repeat = r.repeatOf === undefined ? '' : ` · 라운드 ${r.repeatOf}과 동일`
    const recheck = r.recheck === undefined ? '' : ` · 재확인 ${r.recheck.length}건`
    lines.push(`  ${r.round}: 게이트 ${pass}/${r.evidence.length} 통과${recheck}${repeat}`)
  }
  // 중단된 라운드를 완료 목록에 섞지 않는다 — 절반 검증된 라운드는 판정의 근거가 아니다
  if (state.partialRound !== undefined)
    lines.push(`  ${state.partialRound}: 중단됨 (검증이 끝나지 않았습니다)`)

  const cost = costLine(state)
  if (cost) lines.push(cost)

  if (state.losses.length > 0) {
    lines.push(`증거 손실 ${state.losses.length}건 — 이 실행의 판정은 증거로 뒷받침되지 않습니다`)
    for (const l of state.losses) lines.push(`  ${l.at} ${l.target}`)
  }

  if (state.detail) lines.push(`사유: ${state.detail}`)
  if (state.lastEventAt) lines.push(`마지막 이벤트: ${state.lastEventAt}`)

  if (state.phase !== 'finished') {
    const can = resumability(state)
    lines.push(
      can.ok
        ? `이어서 돌 수 있습니다 — 다음은 라운드 ${can.nextRound}입니다 (zannabi resume ${state.runId})`
        : `이어서 돌 수 없습니다 — ${can.reason}`,
    )
    // 저널은 프로세스의 생사를 모른다. 모르는 것을 아는 척하지 않는다
    if (state.phase === 'interrupted')
      lines.push('(러너가 죽었는지 지금도 도는 중인지는 저널이 말할 수 없습니다)')
  }
  return lines.join('\n')
}

/**
 * `zannabi status`를 인자 없이 부른 목록 화면. 한 줄에 한 실행.
 *
 * **저널이 없는 실행을 "끊김"이라 부르지 않는다.** 저널을 쓰기 전 판으로 돌린 실행이
 * 남아 있는 저장소가 실제로 있고(실전에서 24건), 그것들은 대개 정상 종료됐다.
 * 재생할 이벤트가 없는 것과 이벤트가 도중에 끊긴 것은 다른 사실이다 —
 * 모르는 것을 아는 척하면 옛 실행 전부가 죽은 실행처럼 보인다.
 */
export function renderRunLine(runId: string, state: ReplayState, hasJournal = true): string {
  if (!hasJournal) return `· ${runId}  저널 없음 (저널을 쓰기 전 판으로 돌린 실행입니다)`
  const mark = state.phase === 'finished' ? (state.status === 'success' ? '✅' : '❌') : '⏳'
  const what =
    state.phase === 'finished' ? (state.status ?? '?') : PHASE_TEXT[state.phase]
  const rounds = `${state.rounds.length}${state.budget === undefined ? '' : `/${state.budget}`}R`
  const cost = state.spentUsd === undefined ? '' : ` · $${state.spentUsd.toFixed(2)}`
  const lost = state.losses.length > 0 ? ' · 증거손실' : ''
  // 목록에서 race의 조들이 서로 무관한 실행으로 보이지 않게 한다
  const race = state.raceId ? ' · race' : ''
  return `${mark} ${runId}  ${what} · ${rounds}${cost}${lost}${race}`
}
