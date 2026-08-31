import { z } from 'zod'

export const DEFAULT_GATE_TIMEOUT_MS = 300_000

/**
 * 게이트의 출처. 기본이 `suggested`인 것은 이 스키마로 파싱되는 것이 대개
 * 에이전트가 계획에 적어 낸 JSON 블록이기 때문이다 — 사용자 게이트는 CLI가 명시적으로 표시한다.
 *
 * 왜 나누는가: 사용자가 건 게이트는 **완료의 정의**고 에이전트가 제안한 게이트는 **자기 검사**다.
 * 둘을 한 통에 담으면 "완료 기준은 다 만족했는데 자기가 건 불가능한 게이트로 죽은" 실행이
 * 그냥 실패로 보인다. 실제로 그런 실행이 있었다.
 */
export const GateSourceSchema = z.enum(['user', 'suggested'])
export type GateSource = z.infer<typeof GateSourceSchema>

export const GateSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  timeoutMs: z.number().int().positive().default(DEFAULT_GATE_TIMEOUT_MS),
  source: GateSourceSchema.default('suggested'),
})
export type Gate = z.infer<typeof GateSchema>

/**
 * 채택되지 못한 제안 게이트 한 건.
 *
 * 이 기록이 필요한 이유: 계획 에이전트가 *"이 게이트를 지금 형태로 두면 2회차가 캐시로
 * 스킵돼 재확인이 헛돈다"* 고 정확히 진단하고 clean 단계를 붙인 명령을 제안했는데,
 * 같은 이름의 사용자 게이트가 이겨서 경고 한 줄 없이 사라진 실행이 있었다.
 * 사용자 게이트가 이기는 것 자체는 옳다 — 그게 완료의 정의니까. 문제는 **침묵**이었다.
 */
export const DroppedGateSchema = z.object({
  name: z.string(),
  cmd: z.string(),
  /** `name-collision`은 같은 이름의 사용자 게이트에 밀린 것, `rejected`는 --reject-suggested */
  reason: z.enum(['name-collision', 'rejected']),
  /** 충돌일 때 대신 실행된 사용자 게이트의 명령. 두 명령의 차이가 곧 잃어버린 정보다 */
  keptCmd: z.string().optional(),
})
export type DroppedGate = z.infer<typeof DroppedGateSchema>

/**
 * 사용자 게이트와 제안 게이트를 합친다. 이름이 겹치면 사용자 게이트가 이긴다.
 *
 * 밀려난 제안은 버리지 않고 {@link DroppedGate}로 돌려준다 — 호출자가 경고로 띄우고
 * 증거에 남길 수 있어야 한다. 명령까지 똑같은 충돌은 잃은 것이 없으므로 보고하지 않는다.
 */
export function mergeGates(
  userGates: Gate[],
  suggested: Gate[],
  opts: { reject?: boolean } = {},
): { gates: Gate[]; dropped: DroppedGate[] } {
  const dropped: DroppedGate[] = []
  if (opts.reject)
    return {
      gates: [...userGates],
      dropped: suggested.map(s => ({ name: s.name, cmd: s.cmd, reason: 'rejected' as const })),
    }
  const kept: Gate[] = [...userGates]
  for (const s of suggested) {
    const clash = kept.find(k => k.name === s.name)
    if (!clash) {
      kept.push(s)
      continue
    }
    // 같은 이름·같은 명령이면 중복일 뿐 손실이 아니다
    if (clash.cmd !== s.cmd)
      dropped.push({ name: s.name, cmd: s.cmd, reason: 'name-collision', keptCmd: clash.cmd })
  }
  return { gates: kept, dropped }
}

/** 어떤 런타임 조합으로 돌았는지. 증거만 보고 재현할 수 있어야 한다 */
export const RuntimeSchema = z.object({
  plan: z.string(),
  exec: z.string(),
})

export const GoalSchema = z.object({
  intent: z.string().min(1),
  gates: z.array(GateSchema),
  budget: z.number().int().min(1).default(3),
  runtime: RuntimeSchema.optional(),
  /** 채택되지 못한 제안 게이트. 무엇이 왜 빠졌는지가 증거에 남아야 한다 */
  droppedGates: z.array(DroppedGateSchema).optional(),
  /** 루프를 지배한 설정. 증거만 보고 같은 조건을 다시 세울 수 있어야 한다 */
  loop: z
    .object({
      stallLimit: z.number().int().min(0),
      verifyRepeat: z.number().int().min(1),
      rejectSuggested: z.boolean(),
      /** 어떤 프리셋으로 돌았는지. 조합별 실적을 모을 때의 묶음 키가 된다 */
      profile: z.string().optional(),
    })
    .optional(),
})
export type Goal = z.infer<typeof GoalSchema>

/**
 * 증거가 딛고 선 워킹트리 상태. `tracked: false`면 git으로 읽을 수 없었다는 뜻이고,
 * 그때는 head/diffHash가 없다 — 없는 것을 빈 문자열로 위장하면 "변경 없음"과 구별되지 않는다.
 */
export const RevisionSchema = z.object({
  tracked: z.boolean(),
  /** HEAD 커밋 sha. 커밋이 아직 없는 저장소면 null */
  head: z.string().nullable(),
  /** 미추적 파일까지 포함한 변경분의 sha256 앞 16자 */
  diffHash: z.string().nullable(),
})
export type Revision = z.infer<typeof RevisionSchema>

export const EvidenceSchema = z.object({
  gate: z.string(),
  cmd: z.string(),
  /** 이 게이트가 완료의 정의였는지(user) 에이전트의 자기 검사였는지(suggested) */
  source: GateSourceSchema.default('suggested'),
  outcome: z.enum(['pass', 'fail', 'error']),
  exitCode: z.number().nullable(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  durationMs: z.number(),
  timestamp: z.string(),
  /**
   * 출력에서 추린 실패 신호 줄. 통과한 게이트에는 없다.
   *
   * tail은 꼬리 4000자라 시험 수백 건의 통과 로그에 밀려 정작 실패 줄이 잘린다.
   * 크기를 키우는 대신 신호를 따로 뽑아 리포트가 원인부터 말하게 한다.
   */
  signals: z.array(z.string()).optional(),
  /** 이 증거가 어떤 리비전에서 나왔는지(설계 §5). 증거 한 줄만 떼어 봐도 대상이 특정돼야 한다 */
  revision: RevisionSchema.optional(),
})
export type Evidence = z.infer<typeof EvidenceSchema>

/**
 * 한 번의 EXECUTE → VERIFY 사이클.
 *
 * 라운드를 명시적 레코드로 만든 이유: 증거만 나열하면 "몇 라운드째의 증거인지"와
 * "그 사이 파일이 바뀌었는지"가 사라진다. no-progress 판정은 정확히 그 둘을 본다.
 */
/**
 * 에이전트가 **시도한** 자기 확인 한 건.
 *
 * **시도와 실행을 가르는 것이 이 모양의 존재 이유다.** 시도만 세면 리포트가 거짓말을 한다 —
 * 실측에서 `selfChecks 13건`으로 적힌 실행의 실제 실행이 **0건**이었다(전부 권한 거부).
 * 저널만으로는 구별할 수 없어 `transcript.jsonl`의 거부 기록을 사람이 대조해야 했다.
 * "0건이면 열렸는데 안 쓴 것"이라는 판정이 성립하려면 0건이 아닌 경우도 믿을 수 있어야 한다.
 */
export const SelfCheckSchema = z.object({
  cmd: z.string(),
  /** 런타임이 거부했다 — 열어 준 범위 밖이거나 패턴이 어긋났다. 없으면 실제로 돌았다 */
  denied: z.literal(true).optional(),
})
export type SelfCheck = z.infer<typeof SelfCheckSchema>

/**
 * 재확인이 실제로 다시 돌지 않았을 수 있다는 정황 한 건.
 *
 * 라운드 요약과 저널 이벤트가 **같은 모양을 쓴다** — 둘이 갈리면 리포트가 말하는 정황과
 * 저널에 남은 정황이 다른 것이 되고, 사후에 어느 쪽을 믿을지 정할 수 없게 된다.
 */
export const RecheckSuspectSchema = z.object({
  gate: z.string(),
  firstMs: z.number(),
  recheckMs: z.number(),
  /**
   * 무엇이 이 정황을 만들었나. 이 필드가 없으면 리포트가 두 사유를 한 문장으로
   * 섞고, 실측에서 재확인이 **더 느렸던** 행에 "훨씬 빨리 끝났다"는
   * 사실과 반대인 설명이 붙었다.
   */
  reason: z.enum(['ratio', 'clean-too-fast']).default('ratio'),
})

export const RoundSchema = z.object({
  round: z.number().int().positive(),
  revision: RevisionSchema,
  evidence: z.array(EvidenceSchema),
  /** 리비전과 게이트 결과가 모두 같았던 앞선 라운드 번호. 없으면 진전이 있었다는 뜻 */
  repeatOf: z.number().int().positive().optional(),
  /** 통과를 재확인하려고 게이트를 더 돌린 결과. 원본 증거를 덮어쓰지 않고 나란히 남긴다 */
  recheck: z.array(EvidenceSchema).optional(),
  /**
   * 재확인에서 통과가 재현되지 않은 게이트 이름들. 비어 있지 않으면 그 통과는 증거가 아니다.
   * 원인이 간헐성인지 결정론적 결함인지는 이 값이 말하지 않는다 — 실전 첫 사례는 후자였다.
   */
  unreproduced: z.array(z.string()).optional(),
  /**
   * 재확인이 첫 회보다 극단적으로 짧게 끝난 게이트. 통과를 무르지는 않지만,
   * "재확인했다"는 말이 실제로 무엇을 확인한 것인지 사람이 따져 볼 근거를 남긴다.
   */
  recheckSuspects: z.array(RecheckSuspectSchema).optional(),
})
export type Round = z.infer<typeof RoundSchema>

/**
 * 게이트가 확인해 주지 않는 주장 하나.
 *
 * **왜 이것이 필요한가**: 실행 턴에 셸을 열어 주자(Phase 11) 라운드 낭비는 줄었지만
 * **"확인 못 한 자리"를 스스로 지목하는 일이 사라졌다.** 셸이 닫혀 있을 때는 못 돌리는 것이
 * 명백해서 지목이 나왔는데, 대부분 돌릴 수 있게 되자 **돌릴 수 없는 나머지가 눈에 안 띈다.**
 * 그 나머지가 정확히 틀리기 쉬운 자리다 — 실측에서 에이전트는 "어떤 코드도 이 값을 보지
 * 않는다"고 단언했고, 사람이 grep 한 번으로 반례를 찾았다.
 *
 * **게이트에 기대 출력을 붙여도(Phase 12) 못 잡는다.** 그 자리에 게이트가 없기 때문이다 —
 * 화면(HTML/JS)처럼 게이트가 구조적으로 안 덮는 산출물이 있고, 그건 러너가 아니라 저장소 사정이다.
 */
export const ClaimSchema = z.object({
  /** 주장 자체. 에이전트가 참이라고 말하지만 게이트가 보증하지 않는 것 */
  claim: z.string().min(1),
  /** 무엇에 근거하는가 — 읽어서 아는 것과 미뤄 짐작한 것은 신뢰도가 다르다 */
  basis: z.enum(['read', 'inferred', 'unverified']),
  /** 왜 게이트로 확인할 수 없었는가. 비워도 되지만 적으면 게이트를 늘릴 단서가 된다 */
  why: z.string().optional(),
})
export type Claim = z.infer<typeof ClaimSchema>

/**
 * 실행 턴의 신고. **세 상태를 가르는 것이 이 타입의 전부다.**
 *
 * 실측에서 "확인하지 못한 것" 절이 비어 있었는데, **그것이 회피인지 정말로 없는 것인지
 * 구별할 수 없었다.** 산문으로 요구했더니 그냥 안 쓴 것이다. 명시적인 빈 신고와 무신고를
 * 가르면 그 구분이 생긴다 — "없다고 말했다"는 검증 가능한 진술이고, "말하지 않았다"는 아니다.
 */
export type ClaimReport =
  /** 형식을 지켜 신고했다. 목록이 비어 있으면 "게이트 밖 주장이 없다"고 **말한** 것이다 */
  | { reported: true; claims: Claim[] }
  /** 요구한 형식이 답변에 없다. 신고하지 않은 것이며, 없다고 말한 것이 아니다 */
  | { reported: false }

const claimsBlock = z.object({ claims: z.array(ClaimSchema) })

/**
 * 실행 턴의 답변에서 신고를 뽑는다.
 *
 * {@link extractGates}와 같은 이유로 **마지막 블록부터** 훑는다 — 답변 안에 예시 블록이
 * 먼저 나오면 앞에서부터 집는 쪽은 엉뚱한 것을 읽는다.
 *
 * **게이트 블록과 섞이지 않는다**: 계획 턴은 `{"gates":…}`를, 실행 턴은 `{"claims":…}`를
 * 낸다. 스키마가 다르므로 서로의 블록은 파싱에 실패해 건너뛰어진다.
 */
export function extractClaims(text: string): ClaimReport {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const result = claimsBlock.safeParse(JSON.parse(blocks[i][1]))
      if (result.success) return { reported: true, claims: result.data.claims }
    } catch {
      // 이 블록은 신고가 아니다 — 앞쪽 블록을 계속 본다
    }
  }
  return { reported: false }
}

const gatesBlock = z.object({ gates: z.array(GateSchema) })

/**
 * 계획 본문에서 게이트 제안을 뽑는다.
 *
 * 프롬프트는 "답변 끝에 JSON 블록 하나"를 요구하므로 **마지막 블록부터** 훑는다.
 * 계획 안에 예시나 인용 블록이 먼저 나오면 첫 블록을 집는 쪽은 엉뚱한 것을 읽는다.
 */
export function extractGates(text: string): Gate[] | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const result = gatesBlock.safeParse(JSON.parse(blocks[i][1]))
      if (result.success) return result.data.gates
    } catch {
      // 이 블록은 게이트가 아니다 — 앞쪽 블록을 계속 본다
    }
  }
  return null
}
