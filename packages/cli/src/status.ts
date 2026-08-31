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
import { resumability, contractGap } from '@zannabi-lab/core'

/** 경과를 사람의 말로. 초·분·시간 세 구간이면 충분하다 — 밀리초는 게이트에서나 의미가 있다 */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}초` : s < 3600 ? `${Math.round(s / 60)}분` : `${(s / 3600).toFixed(1)}시간`
}

function elapsedMs(from?: string, to?: string): number | undefined {
  if (!from || !to) return undefined
  const ms = new Date(to).getTime() - new Date(from).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/**
 * 마지막 이벤트로부터 얼마나 조용한가.
 *
 * **저널은 프로세스의 생사를 모른다.** 아는 것은 "언제 마지막으로 무언가 일어났는가"뿐이므로,
 * 죽었다고 단정하는 대신 무음 경과를 말한다. 15분짜리 게이트가 도는 중일 수도 있고
 * 러너가 죽었을 수도 있는데, 그 둘을 가르는 것은 사람이지 이 화면이 아니다.
 */
function silence(lastEventAt?: string, now: Date = new Date()): { ms: number; text: string } | undefined {
  const ms = elapsedMs(lastEventAt, now.toISOString())
  return ms === undefined ? undefined : { ms, text: duration(ms) }
}

/**
 * 이 실행이 얼마나 걸렸나. **재개한 실행에서는 멎어 있던 시간이 포함된다** —
 * 저널은 프로세스가 죽어 있던 구간을 모르므로 첫 이벤트와 마지막 이벤트의 차이밖에
 * 말할 수 없다. 그것을 "돈 시간"이라 부르면 거짓이라 부르는 이름을 달리한다.
 */
function elapsedLine(state: ReplayState): string | undefined {
  const end = state.phase === 'finished' ? state.finishedAt : state.lastEventAt
  const ms = elapsedMs(state.startedAt, end)
  if (ms === undefined) return undefined
  const label = state.phase === 'finished' ? '소요' : '경과'
  const caveat = state.resumeCount ? ' (멎어 있던 시간 포함)' : ''
  return `${label}: ${duration(ms)}${caveat}`
}

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

export function renderStatus(
  state: ReplayState,
  now: Date = new Date(),
  /**
   * 증거를 찾은 프로젝트 경로. **저널의 `cwd`와 다르면 그 실행은 격리돼 돌았다.**
   *
   * 격리 실행은 워크트리에서 돌고 증거만 원본에 남기므로 두 경로가 갈린다. 저널이 그
   * 사실을 이미 담고 있는데 화면이 안 쓰면, 나중에 증거를 보는 사람은 워킹트리에 변경이
   * 없는데 `success`인 실행을 보고 어리둥절해진다 — 결과는 브랜치에 있다.
   */
  projectDir?: string,
): string {
  const lines: string[] = []
  const head = state.phase === 'finished' ? `${PHASE_TEXT.finished} (${state.status})` : PHASE_TEXT[state.phase]
  /**
   * **판이 다르면 아래 전부가 의심스러우므로 맨 위에 적는다.**
   *
   * 저널이 계약 판을 싣고 replay가 복원하는데 화면이 한 번도 안 봤다 — 판이 다른 저널을
   * 조용히 이 판으로 읽었다는 뜻이다. `replay`는 모르는 type을 건너뛰도록 만들어져 있어,
   * 더 높은 판의 저널에서는 라운드가 통째로 빠져도 화면이 아무 말을 하지 않았다.
   *
   * 판을 밝히지 않은 저널(`unknown`)은 말하지 않는다 — 계약 이전에 남은 기록이 그렇고,
   * 그것까지 경고하면 옛 실행을 볼 때마다 뜬다
   */
  const gap = contractGap(state.contractVersion)
  if (gap.kind === 'newer' || gap.kind === 'older') lines.push(`⚠️  ${gap.text}`)
  lines.push(`실행: ${state.runId ?? '(알 수 없음)'}`)
  // intent가 여러 줄인 실행이 있다(실측에서 43줄). 전문을 뿌리면 정작 상태가 밀려난다
  if (state.intent) {
    const first = state.intent.split('\n')[0].trim()
    const more = state.intent.includes('\n') ? ' …' : ''
    lines.push(`의도: ${first.slice(0, 100)}${first.length > 100 ? '…' : ''}${more}`)
  }
  lines.push(`상태: ${head}`)
  if (state.runtime) lines.push(`런타임: 계획 ${state.runtime.plan} · 실행 ${state.runtime.exec}`)
  if (state.profile) lines.push(`프리셋: ${state.profile}`)
  // 조 하나만 떼어 보는 사람에게 "이것은 비교의 일부였다"를 알린다
  if (state.raceId) lines.push(`best-of-N: ${state.raceId}의 조 하나입니다`)

  // 워킹트리가 깨끗한데 success인 실행 앞에서 어리둥절하지 않게 한다 — 결과는 브랜치에 있다
  if (projectDir && state.cwd && state.cwd !== projectDir && state.runId)
    lines.push(`격리: 워크트리에서 돌았습니다 — 결과는 브랜치 zannabi/${state.runId}에 있습니다`)

  // 한 번에 돈 실행과 죽었다 이어 돈 실행은 다른 실행이다. 저널이 run-resumed를
  // 기록하는 이유가 정확히 이것인데, 화면이 안 쓰면 그 사실이 밖에서 사라진다
  if (state.resumeCount) lines.push(`재개: ${state.resumeCount}회 이어받았습니다`)

  // 조합 비교의 축 셋(비용·토큰·시간) 중 하나다. 저널이 첫 줄과 마지막 줄의 시각을
  // 가지고 있는데 화면이 안 쓰면, 재는 사람이 스톱워치를 따로 든다
  const elapsed = elapsedLine(state)
  if (elapsed) lines.push(elapsed)

  // **판정과 다른 층이라는 것이 이 줄의 전부다.** 자체 확인은 완료를 만들지 않는다 —
  // 에이전트가 게이트를 백 번 돌려도 판정은 아래 라운드 줄의 것이다.
  // 그리고 **시도가 아니라 실행을 센다**: 실측에서 13건이 전부 거부돼 실제로는 0건이었다
  if (state.selfChecks?.length) {
    const denied = state.selfChecks.filter(c => c.denied).length
    const ran = state.selfChecks.length - denied
    lines.push(
      denied === 0
        ? `에이전트 자체 확인: ${ran}건 (판정 아님)`
        : `에이전트 자체 확인: 시도 ${state.selfChecks.length}건 중 ${ran}건 실행` +
          ` · ${denied}건 거부됨 (열어 준 패턴과 어긋남)`,
    )
  }

  const budget = state.budget === undefined ? '?' : String(state.budget)
  /**
   * **완료된 라운드와 시도한 라운드는 다르다.**
   *
   * 실행 턴이 실패하면(`agent-error`) 루프는 라운드를 완성하지 않고 끝나므로 완료 수는
   * 0인데 시도는 1이다. 완료 수만 적으면 화면이 "0/4 완료"라고만 말해 **아무것도 안 해 본
   * 실행처럼 보인다** — 실제로는 에이전트를 띄웠고 돈도 썼다. 저널의 `run-finished`가
   * 그 숫자를 싣고 있는데 화면이 안 읽던 자리다.
   *
   * 같을 때는 적지 않는다. 대부분의 실행이 그렇고, 같은 값을 두 번 적으면 다른 경우가 묻힌다
   */
  const attempted =
    state.attempts !== undefined && state.attempts > state.rounds.length
      ? ` (시도 ${state.attempts}회 — 마지막 라운드는 완성되지 않았습니다)`
      : ''
  lines.push(`라운드: ${state.rounds.length}/${budget} 완료${attempted}`)
  for (const r of state.rounds) {
    const pass = r.evidence.filter(e => e.outcome === 'pass').length
    const repeat = r.repeatOf === undefined ? '' : ` · 라운드 ${r.repeatOf}과 동일`
    const recheck = r.recheck === undefined ? '' : ` · 재확인 ${r.recheck.length}건`
    lines.push(`  ${r.round}: 게이트 ${pass}/${r.evidence.length} 통과${recheck}${repeat}`)
  }
  // 진행 중인 라운드를 완료 목록에 섞지 않는다 — 절반 검증된 라운드는 판정의 근거가 아니다.
  // 그러나 **지금까지 나온 게이트 결과는 보여준다.** 저널에 이미 있는 것을 화면이 안 쓰면
  // 실행 중에 밖에서 보는 사람에게는 아무 정보도 없는 것과 같다
  if (state.partialRound !== undefined) {
    const done = state.phase === 'finished' ? '중단됨' : '진행 중'
    lines.push(`  ${state.partialRound}: ${done} (아직 판정의 근거가 아닙니다)`)
    for (const e of state.partialEvidence ?? []) {
      const mark = e.outcome === 'pass' ? '✅' : e.outcome === 'fail' ? '❌' : '⛔'
      lines.push(`     ${mark} ${e.gate} → exit ${e.exitCode} · ${(e.durationMs / 1000).toFixed(1)}s`)
    }
    if (state.runningGate) lines.push(`     ⏳ ${state.runningGate} 실행 중`)
  }

  const cost = costLine(state)
  if (cost) lines.push(cost)

  if (state.losses.length > 0) {
    lines.push(`증거 손실 ${state.losses.length}건 — 이 실행의 판정은 증거로 뒷받침되지 않습니다`)
    for (const l of state.losses) lines.push(`  ${l.at} ${l.target}`)
  }

  if (state.detail) lines.push(`사유: ${state.detail}`)

  const quiet = silence(state.lastEventAt, now)
  if (state.lastEventAt)
    lines.push(`마지막 이벤트: ${state.lastEventAt}${quiet ? ` (${quiet.text} 전)` : ''}`)

  if (state.phase !== 'finished') {
    // **죽었다고 단정하지 않는다.** 이 실행은 지금 돌고 있을 수도 있다.
    // 재개는 "러너가 이미 끝났다면"이라는 조건을 붙여 안내한다 —
    // 살아 있는 실행에 resume을 권하면 같은 증거 디렉토리에 두 러너가 쓰게 된다
    const can = resumability(state)
    if (can.ok)
      lines.push(
        `러너가 이미 멎었다면 라운드 ${can.nextRound}부터 이어서 돌 수 있습니다` +
          ` (zannabi resume ${state.runId})`,
      )
    else lines.push(`이어서 돌 수 없습니다 — ${can.reason}`)
    lines.push('(러너가 지금도 도는 중인지 죽었는지는 저널이 말할 수 없습니다 — 무음 경과로 판단하세요)')
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
export function renderRunLine(
  runId: string,
  state: ReplayState,
  hasJournal = true,
  now: Date = new Date(),
): string {
  if (!hasJournal) return `· ${runId}  저널 없음 (저널을 쓰기 전 판으로 돌린 실행입니다)`
  const mark = state.phase === 'finished' ? (state.status === 'success' ? '✅' : '❌') : '⏳'
  const what =
    state.phase === 'finished' ? (state.status ?? '?') : PHASE_TEXT[state.phase]
  const rounds = `${state.rounds.length}${state.budget === undefined ? '' : `/${state.budget}`}R`
  const cost = state.spentUsd === undefined ? '' : ` · $${state.spentUsd.toFixed(2)}`
  const lost = state.losses.length > 0 ? ' · 증거손실' : ''
  // 목록에서 race의 조들이 서로 무관한 실행으로 보이지 않게 한다
  const race = state.raceId ? ' · race' : ''
  // 목록에서도 한 번에 돈 실행과 구분되어야 한다 — 실행 시간과 라운드 수를 비교하는
  // 측정에서 그 차이를 뭉개면 안 된다
  const resumed = state.resumeCount ? ` · 재개${state.resumeCount}` : ''
  // 진행 중인 실행은 무음 경과를 함께 — 목록만 보고도 멎은 것 같은지 가늠할 수 있어야 한다
  const quiet = state.phase === 'finished' ? undefined : silence(state.lastEventAt, now)
  const idle = quiet ? ` · ${quiet.text} 조용` : ''
  return `${mark} ${runId}  ${what} · ${rounds}${cost}${lost}${race}${resumed}${idle}`
}
