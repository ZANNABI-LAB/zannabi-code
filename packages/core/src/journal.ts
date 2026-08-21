/**
 * 실행 이벤트 저널 — append-only JSONL.
 *
 * **저널 하나가 세 가지를 겸한다**: tail하면 실시간 화면, 재생하면 크래시 재개의 체크포인트,
 * 끝나고 읽으면 측정 데이터. 셋이 같은 재료라는 것이 이 설계의 전부다 —
 * 실시간용 전송층과 재개용 체크포인트를 따로 만들면 둘이 어긋날 때 어느 쪽이 진실인지
 * 정할 수 없게 된다.
 *
 * **전송층이 파일인 이유.** 소켓이나 데몬을 두면 소비자가 러너에 붙는 방법을 알아야 하고,
 * 그 순간 계약이 러너 구현에 묶인다. 파일은 제일 멍청한 대신 누구나 읽을 수 있고,
 * 언젠가 다른 러너가 같은 어휘로 같은 파일을 쓰면 소비자는 바뀌지 않는다.
 *
 * **왜 스냅샷(`evidence.json`)으로는 안 되는가.** 덮어쓰기는 두 가지를 못 한다:
 * 쓰는 도중 죽으면 반쪽 JSON이 남아 파일 전체가 못 읽게 되고, "지금 무엇을 하는 중인지"
 * (계획 중·승인 대기·게이트 실행 중)가 아예 표현되지 않는다. 줄 단위 추가는 마지막 한 줄만
 * 버리면 되고, 진행 중인 상태가 이벤트로 남는다.
 */
import { z } from 'zod'
import { EvidenceSchema, RevisionSchema, GateSchema, DroppedGateSchema } from './goal'

/**
 * 저널이 따르는 계약 판. 소비자는 이 값을 보고 읽을 수 있는지 판단한다.
 *
 * 판 번호를 처음부터 박아 두는 이유: 번호 없는 파일이 이미 밖에 나가 있으면
 * 나중에 판을 붙이는 순간 옛 파일 전부가 "판 미상"이 된다.
 * 판을 올리는 규칙은 `docs/contract-v1.md` §5에 있다.
 */
export const CONTRACT_VERSION = 1

export const JOURNAL_FILENAME = 'journal.jsonl'

const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number().optional(),
  costUsd: z.number().optional(),
  turns: z.number(),
})

/** 모든 이벤트가 공유하는 것 — 무엇이, 언제 */
const base = { at: z.string() }

/**
 * 저널 어휘.
 *
 * 고른 기준은 **"이것이 없으면 밖에서 상태를 재구성할 수 없는가"** 하나다.
 * 예쁘게 나누는 것이 아니라, 재생만으로 루프의 메모리 상태(라운드·사용량·세션·피드백)가
 * 복원되어야 재개가 성립한다.
 */
export const JournalEventSchema = z.discriminatedUnion('type', [
  /** 실행의 시작. 재개할 때 "무엇을 하려던 실행인가"의 출처다 */
  z.object({
    ...base,
    type: z.literal('run-started'),
    contractVersion: z.number().int().positive(),
    runId: z.string(),
    intent: z.string(),
    cwd: z.string(),
    budget: z.number().int().positive(),
    runtime: z.object({ plan: z.string(), exec: z.string() }).optional(),
    profile: z.string().optional(),
    maxCostUsd: z.number().optional(),
    /**
     * best-of-N의 일부라면 그 race의 이름.
     *
     * 없으면 같은 작업의 조 셋이 서로 무관한 실행 셋으로 보인다 — race를 여러 번 돌린
     * 저장소에서 어느 실행이 어느 비교에 속했는지 알 수 없게 되고, 조합별 실적을 모으는
     * 측정이 성립하지 않는다.
     */
    raceId: z.string().optional(),
  }),
  /**
   * 중단됐던 실행을 이어받았다.
   *
   * 재개를 새 저널로 가르지 않고 같은 파일에 이어 쓰기 때문에 이 줄이 필요하다 —
   * 없으면 재생하는 쪽이 라운드 번호의 점프와 시각의 공백을 설명할 수 없고,
   * 한 번에 돈 실행과 세 번 끊겼다 이어 돈 실행이 똑같아 보인다.
   */
  z.object({
    ...base,
    type: z.literal('run-resumed'),
    fromRound: z.number().int().positive(),
    completedRounds: z.number().int().nonnegative(),
    /** 재개할 때 고른 런타임. 처음과 다를 수 있다 — 그 사실이 남아야 비용 비교가 성립한다 */
    runtime: z.object({ plan: z.string(), exec: z.string() }).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('plan-finished'),
    ok: z.boolean(),
    usage: UsageSchema.optional(),
    /** 계획 턴의 세션. 분리 실행이 아니면 실행 턴이 이어받는다 */
    sessionId: z.string().optional(),
    /**
     * 런타임이 **실제로 쓴** 모델. 우리가 지정한 값이 아니라 그쪽이 보고한 값이다.
     *
     * `run-started`의 `runtime`은 실행 **전에** 쓰이므로 지정값밖에 모른다.
     * 실제 모델은 첫 턴이 끝나야 알 수 있고, 그것을 여기 싣지 않으면
     * 리포트는 아는데 저널은 모르는 상태가 된다 — 실측에서 정확히 그랬다.
     */
    model: z.string().optional(),
  }),
  /**
   * 사람의 승인을 기다리는 중.
   *
   * 계약 초안에 없던 것을 넣었다. **없으면 tail하는 쪽에서 "승인 대기"와 "멈춰 죽음"이
   * 구분되지 않는다** — 둘 다 그냥 이벤트가 끊긴 것으로 보인다. 관측일 뿐이므로
   * 단방향 원칙은 그대로다(원격에서 승인을 *주는* 것은 별개 계약이다).
   */
  z.object({
    ...base,
    type: z.literal('approval-requested'),
    gates: z.array(GateSchema),
    warnings: z.array(
      z.object({
        gate: z.string(),
        cmd: z.string(),
        reason: z.string(),
        /** `blocking`은 실행 자체가 불가능, `advisory`는 사람이 알아야 할 것 */
        kind: z.enum(['blocking', 'advisory']),
      }),
    ),
    dropped: z.array(DroppedGateSchema).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('approval-resolved'),
    action: z.enum(['approve', 'abort']),
    reason: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('round-started'), round: z.number().int().positive() }),
  /**
   * 실행 턴이 끝났다 — 게이트를 돌리기 전.
   *
   * 라운드 완료와 따로 두는 이유는 **비용과 세션이 여기서 확정되기** 때문이다.
   * 게이트를 돌리다 죽으면 이 라운드는 미완이지만 실행 턴의 지출은 이미 발생했다.
   * 라운드 단위로만 기록하면 그 지출이 재개 후 사라져 상한이 거짓말을 한다.
   */
  z.object({
    ...base,
    type: z.literal('exec-finished'),
    round: z.number().int().positive(),
    ok: z.boolean(),
    usage: UsageSchema.optional(),
    sessionId: z.string().optional(),
    /** 실행 런타임이 실제로 쓴 모델. {@link plan-finished}의 같은 필드와 같은 이유로 있다 */
    model: z.string().optional(),
  }),
  /**
   * 게이트 하나가 시작됐다.
   *
   * 결과만으로는 **지금 무엇이 도는 중인지** 알 수 없다. 15분 타임아웃에 걸린 게이트가
   * 어디서 멈췄는지를 저널만 보고 말할 수 없으면, 그것이 실시간 축의 구멍이다.
   */
  z.object({
    ...base,
    type: z.literal('gate-started'),
    round: z.number().int().positive(),
    phase: z.enum(['verify', 'recheck']),
    gate: z.string(),
    cmd: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('gate-result'),
    round: z.number().int().positive(),
    /** 첫 검증인지 통과 재확인인지. 재확인 결과가 원본 증거를 덮어쓰면 안 된다 */
    phase: z.enum(['verify', 'recheck']),
    evidence: EvidenceSchema,
  }),
  z.object({
    ...base,
    type: z.literal('round-finished'),
    round: z.number().int().positive(),
    revision: RevisionSchema,
    repeatOf: z.number().int().positive().optional(),
    /** 이 라운드에서 모든 게이트가 통과했는지 — 재생 없이 카드 한 장을 그리는 데 쓰인다 */
    allPass: z.boolean(),
  }),
  /**
   * 보고된 누적 지출이 갱신됐다.
   *
   * 사용량 이벤트를 합치면 나오는 값이지만 따로 싣는다 — 소비자가 러너의 합산 규칙
   * (캐시 입력을 어느 쪽이 포함하는지 등)을 다시 구현하게 만들면 계약이 아니라 숙제다.
   */
  z.object({
    ...base,
    type: z.literal('cost-updated'),
    plan: UsageSchema,
    exec: UsageSchema,
    spentUsd: z.number().optional(),
    coverage: z.enum(['full', 'partial', 'none', 'not-run']).optional(),
  }),
  /** 증거가 사라졌다. 이 줄이 하나라도 있으면 그 실행의 판정은 증거로 뒷받침되지 않는다 */
  z.object({ ...base, type: z.literal('evidence-lost'), target: z.string() }),
  z.object({
    ...base,
    type: z.literal('run-finished'),
    status: z.string(),
    attempts: z.number().int().nonnegative(),
    detail: z.string().optional(),
  }),
])
export type JournalEvent = z.infer<typeof JournalEventSchema>
export type JournalEventType = JournalEvent['type']

/** `at`을 빼고 준 이벤트에 시각을 찍는다 — 호출부마다 `new Date()`를 쓰지 않게 */
export type JournalInput = { [K in JournalEvent['type']]: Omit<Extract<JournalEvent, { type: K }>, 'at'> }[JournalEvent['type']]

/**
 * 저널 한 줄을 읽는다. **깨진 줄은 오류가 아니라 `null`이다.**
 *
 * kill -9는 줄 중간에서 끊는다. 마지막 한 줄이 반쪽인 것은 정상이고, 그것 때문에
 * 앞의 멀쩡한 수백 줄을 못 읽게 되는 쪽이 훨씬 나쁘다. 알 수 없는 `type`도 같다 —
 * 나중 판의 러너가 쓴 파일을 옛 소비자가 읽는 경우가 그것이고, 모르는 줄은 건너뛰면 된다.
 */
export function parseJournalLine(line: string): JournalEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  const parsed = JournalEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parseJournal(text: string): JournalEvent[] {
  const events: JournalEvent[] = []
  for (const line of text.split('\n')) {
    const event = parseJournalLine(line)
    if (event) events.push(event)
  }
  return events
}

export function serializeJournalEvent(event: JournalEvent): string {
  return JSON.stringify(event) + '\n'
}
