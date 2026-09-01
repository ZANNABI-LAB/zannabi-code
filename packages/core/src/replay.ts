/**
 * 저널 재생 — 이벤트 줄만 읽어 실행의 상태를 재구성한다.
 *
 * **재개와 실시간 화면은 같은 재료를 쓴다**는 주장이 여기서
 * 증명되거나 깨진다: 이 함수 하나가 두 곳에 쓰인다 —
 * `zannabi status`는 결과를 사람에게 보여주고, 재개는 같은 결과를 루프의 초기 상태로 삼는다.
 * 두 경로가 갈리면 "밖에서 본 상태"와 "이어서 도는 상태"가 어긋나고, 그 순간 계약은 거짓말이 된다.
 *
 * **순수 함수인 이유.** 파일을 읽지 않고 이벤트 배열만 받는다. 그래야 소비자(millim)가
 * 같은 로직을 파일이 아닌 다른 경로(tail 스트림·소켓 중계)로 흘려도 그대로 쓸 수 있고,
 * 무엇보다 테스트가 실제 실행 없이 임의의 중단 지점을 만들어 낼 수 있다 —
 * kill -9를 재현하는 가장 값싼 방법은 저널을 잘라 보는 것이다.
 */
import { emptyUsage, type Usage } from './adapter'
import type { CostCoverage } from './cost'
import type { Claim, Gate, Round, SelfCheck } from './goal'
import { CONTRACT_VERSION, type JournalEvent } from './journal'

/** 지금 이 실행이 무엇을 하는 중인가. `run-finished`가 없는 저널에서만 진행 중이다 */
export type RunPhase =
  | 'planning'
  /** 사람의 승인을 기다리는 중 — 멈춰 죽은 것과 구분되어야 하는 상태다 */
  | 'awaiting-approval'
  | 'executing'
  | 'verifying'
  | 'finished'
  /**
   * 이벤트가 끊겼다. 마지막 줄이 끝을 말하지 않는데 그 뒤가 없는 상태 —
   * 러너가 죽었거나, 지금 이 순간에도 돌고 있거나 둘 중 하나다.
   * **저널만 보고는 둘을 가를 수 없다**(프로세스 생사는 저널의 관할이 아니다).
   */
  | 'interrupted'

export interface ReplayState {
  /** `run-started`가 없으면 저널이 아니거나 첫 줄이 유실된 것 */
  runId?: string
  contractVersion?: number
  intent?: string
  cwd?: string
  budget?: number
  runtime?: { plan: string; exec: string }
  profile?: string
  maxCostUsd?: number
  /** best-of-N의 일부라면 그 race의 이름 */
  raceId?: string
  startedAt?: string

  phase: RunPhase
  /** 승인된 게이트. 승인 전이면 제안된 상태의 것 */
  gates: Gate[]
  approved?: boolean
  /**
   * 마지막으로 끝난 라운드가 남긴 일 — 아직 통과하지 못한 게이트와, 그 라운드에
   * 닫히거나 되열린 것. **옛 저널에는 없다**(이 축이 생기기 전 실행).
   */
  remaining?: { open: string[]; closed: string[]; reopened: string[] }

  /** **완료된** 라운드만. 중단된 라운드는 여기 없다 — 재개는 이 다음부터 간다 */
  rounds: ReplayRound[]
  /**
   * 시작됐지만 끝나지 않은 라운드 번호. 있으면 그 라운드는 다시 돌아야 한다.
   * 게이트를 절반쯤 돌다 죽은 라운드를 완료로 치면, 통과하지 않은 게이트가
   * 판정에서 조용히 빠진다 — 거짓 초록의 가장 값싼 경로다.
   */
  partialRound?: number
  /**
   * 진행 중인 라운드에서 **지금까지 나온** 게이트 결과.
   *
   * 판정의 근거는 아니다(라운드가 안 끝났다). 그러나 실행 중에 밖에서 보는 사람에게는
   * 이것이 전부다 — 저널에 `build pass`가 이미 있는데 화면이 "중단됨" 한 줄만 보여주면,
   * 데이터를 갖고도 안 쓰는 것이다.
   */
  partialEvidence?: Round['evidence']
  /** 지금 돌고 있는 게이트 이름. 끝나면 지워진다 */
  runningGate?: string

  usage: { plan: Usage; exec: Usage }
  spentUsd?: number
  coverage?: CostCoverage
  /** 실행 턴이 마지막으로 보고한 세션. 재개가 이어받는다 */
  sessionId?: string

  /** 증거가 사라진 사건. 하나라도 있으면 이 실행의 판정은 증거로 뒷받침되지 않는다 */
  losses: { at: string; target: string }[]

  /** `run-finished`가 있을 때만 */
  status?: string
  attempts?: number
  detail?: string
  finishedAt?: string
  /** 마지막 이벤트 시각. 실시간 화면이 "언제부터 조용한가"를 재는 값 */
  lastEventAt?: string
  /**
   * 에이전트가 **시도한** 자기 확인. 러너가 판정으로 돌린 게이트와 다른 층이다 —
   * 이 값이 비어 있으면 그 실행의 에이전트는 자기가 쓴 것이 도는지 모르고 썼다.
   *
   * **시도이지 실행이 아니다.** 거부된 것은 `denied`로 갈리므로, "몇 번 확인했나"를
   * 세려면 그것을 빼야 한다 — 세는 쪽이 그 사실을 모르면 13건이 0건일 수 있다.
   */
  selfChecks?: SelfCheck[]
  /**
   * 실행 턴이 신고한 **게이트 밖 주장**. 마지막으로 신고한 라운드의 것이다.
   *
   * **`claimsReported`와 함께 읽어야 한다.** 이 배열이 비어 있는 데는 두 가지 뜻이 있고,
   * 둘은 전혀 다르다 — 에이전트가 "없다"고 말했거나, 아무 말도 하지 않았거나.
   * 실측에서 그 둘을 구별할 수 없어 판단이 막혔다.
   */
  claims?: Claim[]
  /**
   * 실행 턴이 요구한 형식으로 답했는가. `false`면 신고를 **하지 않은** 것이다.
   *
   * `undefined`는 또 다른 상태다: 이 실행에는 신고 요구 자체가 없었다(옛 저널).
   */
  claimsReported?: boolean
  /**
   * 이 실행이 몇 번 이어받아졌는지. 0이 아니면 한 번에 돈 실행이 아니다 —
   * 실행 시간과 라운드 수를 비교하는 측정에서 그 차이를 뭉개면 안 된다.
   */
  resumeCount?: number
}

/** 재생으로 복원한 라운드 하나. 게이트 결과는 순서대로 모인다 */
export interface ReplayRound {
  round: number
  revision: Round['revision']
  evidence: Round['evidence']
  recheck?: Round['evidence']
  repeatOf?: number
  allPass: boolean
}

/** `claude:default` 같은 지정값 라벨을 실제 보고된 모델로 바꾼다 */
function withModel(label: string, reported: string): string {
  return `${label.split(':')[0]}:${reported}`
}

export function replay(events: JournalEvent[]): ReplayState {
  const state: ReplayState = {
    phase: 'interrupted',
    gates: [],
    rounds: [],
    usage: { plan: emptyUsage(), exec: emptyUsage() },
    losses: [],
  }
  /** 아직 `round-finished`를 못 본 라운드의 증거들 */
  let open: { round: number; evidence: Round['evidence']; recheck: Round['evidence'] } | undefined

  for (const event of events) {
    state.lastEventAt = event.at
    switch (event.type) {
      case 'run-started':
        state.runId = event.runId
        state.contractVersion = event.contractVersion
        state.intent = event.intent
        state.cwd = event.cwd
        state.budget = event.budget
        state.runtime = event.runtime
        state.profile = event.profile
        state.maxCostUsd = event.maxCostUsd
        state.raceId = event.raceId
        state.startedAt = event.at
        state.phase = 'planning'
        break
      case 'run-resumed':
        // 이어받은 실행은 아직 안 끝났다 — 앞선 재생이 남긴 finished/status를 지운다
        state.status = undefined
        state.attempts = undefined
        state.detail = undefined
        state.finishedAt = undefined
        state.resumeCount = (state.resumeCount ?? 0) + 1
        if (event.runtime !== undefined) state.runtime = event.runtime
        state.phase = 'executing'
        break
      case 'plan-finished':
        // 계획 세션은 계획 런타임의 것이다. 분리 실행이면 실행 턴이 이어받지 않으므로
        // 여기서 잡은 세션은 exec-finished가 덮어쓸 때까지의 잠정값이다
        if (event.sessionId !== undefined) state.sessionId = event.sessionId
        // 실제로 돈 모델이 보고됐으면 run-started의 지정값을 그것으로 고친다 —
        // 지정한 것과 실제로 돈 것이 다르면 사실은 후자다
        if (event.model !== undefined && state.runtime)
          state.runtime = { ...state.runtime, plan: withModel(state.runtime.plan, event.model) }
        break
      case 'approval-requested':
        state.gates = event.gates
        state.phase = 'awaiting-approval'
        break
      case 'approval-resolved':
        state.approved = event.action === 'approve'
        break
      case 'round-started':
        open = { round: event.round, evidence: [], recheck: [] }
        state.phase = 'executing'
        break
      case 'exec-finished':
        if (event.sessionId !== undefined) state.sessionId = event.sessionId
        if (event.model !== undefined && state.runtime)
          state.runtime = { ...state.runtime, exec: withModel(state.runtime.exec, event.model) }
        // 라운드를 넘어 누적한다 — "이 실행에서 에이전트가 몇 번 자기 확인을 했나"가
        // 물음이지, 라운드별로 나눠 봐야 할 값이 아니다
        if (event.selfChecks) state.selfChecks = [...(state.selfChecks ?? []), ...event.selfChecks]
        state.phase = 'verifying'
        break
      /**
       * 신고는 **누적하지 않고 갈아끼운다.** selfChecks와 반대인 이유: 자기 확인은
       * "이 실행에서 몇 번 확인했나"가 물음이라 누적이 맞지만, 주장은 **마지막 라운드의
       * 것이 현재 상태**다. 2라운드에서 고친 것을 1라운드의 주장과 함께 쌓아 보여주면
       * 이미 해소된 불확실을 남아 있는 것처럼 읽게 된다.
       */
      case 'claims-reported':
        state.claimsReported = event.reported
        state.claims = event.claims
        break
      case 'gate-started':
        state.runningGate = event.gate
        state.phase = 'verifying'
        break
      case 'gate-result':
        // 라운드 시작 줄이 유실된 저널도 읽는다 — 없는 것을 이유로 증거를 버리지 않는다
        if (!open) open = { round: event.round, evidence: [], recheck: [] }
        if (event.phase === 'recheck') open.recheck.push(event.evidence)
        else open.evidence.push(event.evidence)
        state.runningGate = undefined
        break
      case 'round-finished': {
        const evidence = open?.evidence ?? []
        const recheck = open?.recheck ?? []
        state.rounds.push({
          round: event.round,
          revision: event.revision,
          evidence,
          ...(recheck.length > 0 ? { recheck } : {}),
          ...(event.repeatOf === undefined ? {} : { repeatOf: event.repeatOf }),
          allPass: event.allPass,
        })
        // 저널이 직접 말한 남은 일을 그대로 옮긴다 — 증거에서 다시 세지 않는다.
        // 증거가 유실돼도 저널 줄은 남으므로, 화면이 기댈 곳은 이쪽이 옳다
        if (event.open)
          state.remaining = {
            open: event.open,
            closed: event.closed ?? [],
            reopened: event.reopened ?? [],
          }
        open = undefined
        state.runningGate = undefined
        break
      }
      case 'cost-updated':
        // 누적값이므로 더하지 않고 갈아끼운다. 더하면 재생할 때마다 지출이 불어난다
        state.usage = { plan: event.plan, exec: event.exec }
        state.spentUsd = event.spentUsd
        state.coverage = event.coverage
        break
      case 'evidence-lost':
        state.losses.push({ at: event.at, target: event.target })
        break
      case 'run-finished':
        state.status = event.status
        state.attempts = event.attempts
        state.detail = event.detail
        state.finishedAt = event.at
        state.phase = 'finished'
        break
    }
  }

  // 끝나지 않은 라운드가 남아 있다는 것은 **재개가 그 라운드부터 다시 돈다**는 뜻일 뿐,
  // 실행이 끊겼다는 뜻이 아니다. 예전에는 여기서 phase를 interrupted로 덮었는데,
  // open은 round-started~round-finished 사이 전체(실행 턴 + 게이트 검증 전체)라서
  // **정상 실행 중에는 언제나 참이었다.** 그래서 살아 있는 실행이 늘 "끊김"으로 보이고
  // 재개를 권유받았다 — status가 계약의 핵심 주장을 실행 중에만 어겼다.
  // 저널은 프로세스의 생사를 모른다. 아는 것(어디까지 왔는가)만 말하고,
  // 끊겼는지 여부는 마지막 이벤트로부터의 무음 경과라는 별도 축으로 판단한다.
  if (state.phase !== 'finished' && open) {
    state.partialRound = open.round
    if (open.evidence.length > 0) state.partialEvidence = open.evidence
  }
  return state
}

/** 재생한 라운드를 루프가 쓰는 {@link Round}로 되돌린다 — 재개가 이어받을 형태 */
export function toRounds(rounds: ReplayRound[]): Round[] {
  return rounds.map(r => ({
    round: r.round,
    revision: r.revision,
    evidence: r.evidence,
    ...(r.recheck === undefined ? {} : { recheck: r.recheck }),
    ...(r.repeatOf === undefined ? {} : { repeatOf: r.repeatOf }),
  }))
}

/**
 * 이 저널을 이 러너가 읽어도 되는가.
 *
 * **계약을 파는 도구가 자기 계약 판을 안 읽고 있었다.** 저널 첫 줄이 `contractVersion`을
 * 싣고 replay가 그것을 복원하는데, 화면도 재개도 그 값을 한 번도 보지 않았다 —
 * 판이 다른 저널을 조용히 이 판으로 읽었다는 뜻이다. 계약 문서 §5가 "판 올리기"를
 * 규정해 놓고 읽는 쪽 구현이 판을 무시하면, 규정은 문서에만 있는 것이다.
 *
 * 판이 **높은** 쪽이 위험하다: 우리가 모르는 어휘가 있고, `replay`는 모르는 type을
 * 건너뛰도록 만들어져 있어 **조용히 빠뜨린다.** 라운드 하나가 통째로 사라져도 화면은
 * 아무 말을 하지 않는다. 낮은 판은 대체로 읽힌다 — 어휘가 늘기만 했다면 그렇다.
 */
export function contractGap(
  version: number | undefined,
): { kind: 'same' | 'older' | 'newer' | 'unknown'; text?: string } {
  if (version === undefined)
    return {
      kind: 'unknown',
      text: '이 저널은 계약 판을 밝히지 않습니다 — 계약 이전에 남은 기록일 수 있습니다',
    }
  if (version === CONTRACT_VERSION) return { kind: 'same' }
  if (version < CONTRACT_VERSION)
    return {
      kind: 'older',
      text: `이 저널은 계약 v${version}이고 이 러너는 v${CONTRACT_VERSION}입니다 — 옛 판이라 일부 값이 비어 보일 수 있습니다`,
    }
  return {
    kind: 'newer',
    text:
      `이 저널은 계약 v${version}이고 이 러너는 v${CONTRACT_VERSION}까지만 압니다 — ` +
      '모르는 이벤트는 건너뛰므로 아래 내용이 실제보다 적을 수 있습니다',
  }
}

/**
 * 이 실행을 이어서 돌 수 있는가, 없다면 왜 없는가.
 *
 * 판단을 재개 명령 안에 두지 않고 따로 뺀 이유: 이유를 사람에게 **말해야** 하기 때문이다.
 * "재개할 수 없습니다"만 나오면 사용자는 저널을 손으로 뜯어보게 된다.
 */
export function resumability(
  state: ReplayState,
): { ok: true; nextRound: number } | { ok: false; reason: string } {
  if (state.runId === undefined) return { ok: false, reason: '저널에 run-started가 없습니다 — 이 실행의 시작 기록이 유실됐습니다' }
  // 모르는 판의 저널로는 **이어 돌지 않는다.** 보는 것과 이어가는 것은 다르다 —
  // 화면은 덜 보여주고 끝나지만, 재개는 놓친 라운드 위에 새 라운드를 쌓아 증거를 망친다
  const gap = contractGap(state.contractVersion)
  if (gap.kind === 'newer')
    return {
      ok: false,
      reason: `${gap.text} — 이어 돌면 놓친 기록 위에 새 라운드를 쌓게 되므로 재개하지 않습니다`,
    }
  if (state.phase === 'finished')
    return { ok: false, reason: `이미 ${state.status}로 끝난 실행입니다 — 이어서 돌 것이 없습니다` }
  if (state.approved !== true)
    return {
      ok: false,
      reason:
        '승인 전에 중단된 실행입니다 — 계획과 게이트가 확정되지 않았으므로 이어받을 완료 기준이 없습니다',
    }
  if (state.gates.length === 0)
    return { ok: false, reason: '승인된 게이트가 저널에 없습니다 — 완료 기준 없이는 이어갈 수 없습니다' }
  if (state.budget === undefined) return { ok: false, reason: '예산이 저널에 없습니다' }
  // 중단된 라운드는 처음부터 다시 돈다. 절반만 검증된 라운드를 완료로 치면
  // 돌지 않은 게이트가 판정에서 빠지고, 그것이 곧 거짓 초록이다
  const done = state.rounds.length
  const nextRound = done + 1
  if (nextRound > state.budget)
    return {
      ok: false,
      reason: `예산 ${state.budget}라운드를 이미 다 썼습니다 — 이어가려면 예산을 늘려 새로 시작해야 합니다`,
    }
  return { ok: true, nextRound }
}
