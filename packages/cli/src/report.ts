import {
  addUsage, emptyUsage, CONFIG_FILENAME, remainingWork,
  type Claim, type ConfigChange, type JournalAudit, type EvidenceLoss, type LoopResult, type SelfCheck, type Usage,
} from '@zannabi-lab/core'
import { duration } from './status'

// diff 캡처는 core로 옮겼다 — 루프가 라운드마다 워킹트리를 찍어야 하기 때문이다.
// CLI는 최종 diff 저장에만 쓰므로 여기서는 재수출만 한다
export { captureDiff } from '@zannabi-lab/core'

/**
 * 사용량 표. 계획과 실행을 나눠 적는 것이 요점이다 — "강한 계획 + 약한 실행"의 값을
 * 재려면 어느 쪽이 얼마를 썼는지가 갈려 있어야 한다.
 *
 * 비용을 보고하지 않는 러너(codex)는 `-`로 남긴다. 0원으로 적으면 공짜라는 거짓이 된다.
 *
 * `in(new)`와 `cached`는 어댑터가 정규화해 겹치지 않는다(코어의 `readUsage`). 열 이름에
 * 그 뜻을 박아 두는 이유: 원본 CLI의 `input_tokens`는 러너마다 포함 관계가 달라서,
 * 그냥 `in`이라고 적으면 이 표를 나중에 읽는 사람이 원본 숫자로 착각한다.
 */
function usageLines(usage: { plan: Usage; exec: Usage }): string[] {
  const cost = (u: Usage) => (u.costUsd === undefined ? '-' : `$${u.costUsd.toFixed(4)}`)
  const row = (name: string, u: Usage) =>
    `| ${name} | ${u.turns} | ${u.inputTokens.toLocaleString()} | ` +
    `${(u.cachedInputTokens ?? 0).toLocaleString()} | ${u.outputTokens.toLocaleString()} | ${cost(u)} |`
  const total = addUsage(addUsage(emptyUsage(), usage.plan), usage.exec)
  return [
    `| 턴 | 횟수 | in(new) | cached | out | cost |`,
    `|---|---|---|---|---|---|`,
    row('plan', usage.plan),
    row('exec', usage.exec),
    row('합계', total),
    ``,
    `> \`in(new)\`는 캐시에 없던 입력 토큰이고 \`cached\`와 겹치지 않는다 — 총 입력은 둘의 합이다.` +
      ` CLI 원본 필드의 포함 관계가 러너마다 달라 어댑터에서 맞춰 실었다.`,
  ]
}

/**
 * 자기 확인 한 줄. **시도가 아니라 실행을 센다.**
 *
 * 실측에서 이 줄이 `13건`이라 적혔는데 실제 실행은 **0건**이었다 — 따옴표 하나가 달라
 * 전부 거부됐고, 리포트만 읽은 사람은 에이전트가 확인하고 썼다고 믿게 된다.
 * 이 도구가 되풀이해 지키는 규칙이 여기서 깨졌었다: 관측하지 않은 것을 관측한 것처럼
 * 말하지 않는다.
 *
 * 그래서 거부가 있으면 **그 사실을 앞세운다.** 거부는 대개 러너 쪽 문제(열어 준 패턴과
 * 에이전트가 친 문자열이 어긋남)이고, 그것을 모르면 "왜 컴파일도 안 하고 썼나"에서 멈춘다.
 */
function selfCheckLine(checks: SelfCheck[]): string {
  const denied = checks.filter(c => c.denied)
  const ran = checks.length - denied.length
  if (checks.length === 0) return `- **self-checks**: 0건 — 에이전트가 검증 없이 썼다`
  if (denied.length === 0)
    return `- **self-checks**: ${ran}건 (에이전트가 스스로 돌림 — 판정 아님)`
  const sample = denied[0].cmd.slice(0, 80)
  return (
    `- **self-checks**: 시도 ${checks.length}건 중 **${ran}건만 실행** — ` +
    `${denied.length}건이 거부됐다(열어 준 패턴과 어긋난 명령).` +
    ` 첫 거부: \`${sample}\`` +
    (ran === 0 ? ' — **이 턴은 검증 없이 썼다**' : '')
  )
}

export interface ReportMeta {
  /**
   * 이 실행이 몇 번 이어받아졌는지. 0이거나 없으면 한 번에 돈 실행이다.
   *
   * 없으면 리포트가 `attempts: 1`만 말하고, 이 실행이 한 번 죽었다 이어 돈 것인지
   * 읽는 사람이 알 수 없다. 저널은 `run-resumed`로 알고 있는데 화면이 안 쓴 것이다.
   */
  resumeCount?: number
  /**
   * 첫 이벤트부터 마지막 이벤트까지. **재개한 실행에서는 멎어 있던 시간이 포함된다** —
   * 저널은 프로세스가 죽어 있던 구간을 모른다.
   *
   * 조합 비교의 축은 셋(비용·토큰·시간)인데 이것이 없어 재는 사람이 스톱워치를 따로 들었다.
   */
  elapsedMs?: number
  /**
   * 에이전트가 **시도한** 자기 확인. 러너가 판정으로 돌린 게이트와 **다른 층**이다.
   * 거부된 것은 `denied`로 갈린다 — 시도만 세면 리포트가 거짓말을 한다.
   */
  selfChecks?: SelfCheck[]
  /**
   * 실행 턴이 신고한 게이트 밖 주장. **`claimsReported`와 짝으로 읽어야 한다** —
   * 빈 배열에는 "없다고 말했다"와 "말하지 않았다" 두 뜻이 있고 둘은 전혀 다르다.
   */
  claims?: Claim[]
  /** 요구한 형식으로 답했는가. `undefined`면 이 실행에는 신고 요구가 없었다(옛 저널) */
  claimsReported?: boolean
  /**
   * 저널 무결성 검사 결과.
   *
   * **리포트에 있어야 하는 이유**: 이 파일은 나중에 이 실행을 판단할 때 읽히는 요약인데,
   * 요약이 근거의 신뢰도를 말하지 않으면 읽는 사람은 게이트 초록만 본다.
   * 증거 손실은 이미 적고 있었고, 변조는 손실보다 나쁘다 — 없는 것이 아니라 있는데 틀렸다.
   */
  audit?: JournalAudit
}

/**
 * 게이트가 확인해 주지 않는 주장을 리포트에 적는다.
 *
 * **리포트에 있어야 하는 이유**: `report.md`는 증거의 일부이고, 나중에 이 실행을 읽는
 * 사람이 게이트 결과만 보면 초록만 본다. 게이트가 **덮지 않은 자리**는 초록에 안 나타난다 —
 * 실측에서 에이전트가 게이트 밖 사실을 단언했고 그것이 틀렸는데, 리포트 어디에도
 * 그 단언이 검증되지 않았다는 표시가 없었다.
 */
function claimsLines(claims: Claim[] | undefined, reported: boolean | undefined): string[] {
  if (reported === undefined) return []
  if (reported === false)
    return [
      `- **unverified-claims**: 신고 없음 — 요구한 형식의 답이 없습니다.` +
        ` **"게이트 밖 주장이 없다"는 뜻이 아닙니다**`,
    ]
  const list = claims ?? []
  if (list.length === 0) return ['- **unverified-claims**: 없다고 신고함']
  return [
    `- **unverified-claims**: ${list.length}건 — 아래 주장은 게이트가 보증하지 않습니다`,
    ...list.map(c => `  - [${c.basis}] ${c.claim}${c.why ? ` — ${c.why}` : ''}`),
  ]
}

export function buildReport(
  result: LoopResult,
  intent: string,
  configChange?: ConfigChange,
  /**
   * 저장소가 아는 최신 손실. 루프가 끝난 뒤(최종 diff 저장 등)에도 증거는 사라질 수 있으므로
   * 결과에 박힌 값보다 이쪽이 최신이다.
   */
  losses?: EvidenceLoss[],
  /**
   * 저널만 아는 것들. **위치 인자로 늘리지 않는다** — 여기 실리는 값은 전부
   * "관측은 했는데 화면이 안 쓰던" 부류라 앞으로도 늘어날 자리다.
   */
  meta: ReportMeta = {},
): string {
  const { resumeCount, elapsedMs, selfChecks, claims, claimsReported, audit } = meta
  const lines = [
    `# zannabi run report`,
    ``,
    `- **intent**: ${intent}`,
    `- **status**: ${result.status}`,
    `- **attempts**: ${result.attempts}`,
  ]
  if (elapsedMs !== undefined)
    lines.push(
      `- **elapsed**: ${duration(elapsedMs)}` +
        (resumeCount ? ' (멎어 있던 시간 포함 — 저널은 죽어 있던 구간을 모른다)' : ''),
    )
  // **판정과 다른 층이라는 것이 이 줄의 전부다.** 자체 확인은 완료를 만들지 않는다.
  // 0건이면 그 사실을 적는다 — 에이전트가 자기가 쓴 것이 도는지 모르고 썼다는 뜻이라,
  // 아래 게이트 결과를 읽을 때 알아야 하는 배경이다
  /**
   * **판정 바로 아래, 다른 무엇보다 먼저.** 저널이 쓰인 그대로가 아니라면 아래 모든 줄이
   * 그 위에서 만들어진 것이므로, 읽는 순서에서 이것이 앞서야 한다.
   */
  if (audit && !audit.ok)
    lines.push(
      `- **integrity**: 🚨 변조 흔적 — ${audit.detail}.` +
        ` **아래 내용은 쓰인 그대로가 아닐 수 있습니다**`,
    )
  // 통과 사실도 적는다 — 아무 줄이 없으면 "검사하고 통과"와 "검사 안 함"이 같아 보인다.
  // 무결성은 없을 때가 아니라 있을 때 신뢰를 만드는 값이다
  else if (audit?.ok && !('unverifiable' in audit && audit.unverifiable))
    lines.push(`- **integrity**: 저널 ${audit.verified}줄 확인 — 쓰인 그대로`)
  if (selfChecks) lines.push(selfCheckLine(selfChecks))
  // 자기 확인 바로 아래에 둔다 — 위는 "무엇을 확인했나", 아래는 "무엇을 확인하지 못했나"
  lines.push(...claimsLines(claims, claimsReported))
  // 한 번에 돈 실행과 죽었다 이어 돈 실행은 다른 실행이다 — attempts만으로는 갈리지 않는다
  if (resumeCount)
    lines.push(
      `- **resumed**: ${resumeCount}회 이어받음` +
        ` — ⚠️ 죽은 실행 턴이 쓴 토큰은 아래 비용에 **빠져 있다**` +
        `(어댑터는 턴이 끝날 때 보고하므로 중단된 턴의 지출은 관측되지 않는다).` +
        ` 실제 지출은 여기 적힌 값보다 크고, \`--max-cost\`도 그만큼 적게 센다`,
    )
  // 어떤 조합으로 돌았는지 — 조합별 비교의 기본 축
  if (result.runtime)
    lines.push(`- **runtime**: plan=\`${result.runtime.plan}\` exec=\`${result.runtime.exec}\``)
  // 증거가 어느 리비전 위의 것인지. 이게 없으면 report는 재현 불가능한 주장이 된다
  const head = result.rounds.at(-1)?.revision.head
  if (head) lines.push(`- **head**: \`${head}\``)
  /**
   * **남은 일.** `attempts 4 / budget-exhausted`는 "네 번 시도하고 끝났다"만 말하지
   * **무엇이 남았는지**는 말하지 않는다. 게이트 5개 중 4개를 닫고 끝난 실행과
   * 하나도 못 닫은 실행이 같은 두 줄로 보였다 — 사람이 이어서 할 때 필요한 것은 그 차이다.
   */
  const work = remainingWork(result.rounds)
  if (work.open.length > 0) {
    lines.push(`- **remaining**: ${work.open.length}건 — ${work.open.map(g => `\`${g}\``).join(', ')}`)
    if (work.closed.length > 0)
      lines.push(`- **closed**: 마지막 라운드에 ${work.closed.map(g => `\`${g}\``).join(', ')}`)
    // 되열림은 개수로 안 드러난다 — 하나를 풀며 하나를 깨면 남은 일 수가 그대로다
    if (work.reopened.length > 0)
      lines.push(
        `- ⚠️ **reopened**: ${work.reopened.map(g => `\`${g}\``).join(', ')}` +
          ` — 앞 라운드에서 통과했다가 다시 실패했다. 고치다 깬 자리다`,
      )
  }
  // 실패 사유를 리포트에 싣는다 — transcript.jsonl을 파싱하지 않아도 원인이 보이게
  if (result.detail) lines.push(`- **detail**: ${result.detail}`)
  // 예산 소진으로 끝난 실행을 나중에 읽을 때, 정체 감지가 안 걸린 것인지 못 걸린 것인지 갈린다
  if (result.stallDead)
    lines.push(
      `- ⚠️ **정체 감지 꺼짐**: stall-limit이 예산 이상이라 이 실행에서는 발동할 수 없었다` +
        ` — 라운드가 제자리였더라도 예산 소진으로 끝난다`,
    )

  // 증거가 사라졌다는 사실은 리포트 맨 위에 온다. 이 실행의 다른 모든 주장이
  // 그만큼 덜 뒷받침된다는 뜻이라, 아래쪽 절에 묻히면 안 된다
  const lost = losses && losses.length > 0 ? losses : result.evidenceLoss
  if (lost && lost.length > 0) {
    lines.push(
      `- 🚨 **증거 소실 ${lost.length}건** — 실행 도중 증거가 사라졌다.` +
        ` 작업하는 에이전트가 \`.zannabi/\`를 지울 수 있다(실측 사례가 있다)`,
    )
  }

  const last = result.rounds.at(-1)
  lines.push(``, `## Gates (최종 라운드)`, ``)
  for (const e of last?.evidence ?? []) {
    const mark = e.outcome === 'pass' ? '✅' : e.outcome === 'fail' ? '❌' : '⚠️'
    // 출처를 적어야 "완료 기준이 안 됐다"와 "에이전트 자기 검사가 안 됐다"가 구별된다
    const unreproduced = last?.unreproduced?.includes(e.gate) ? ' · 🔁 재현 안 됨' : ''
    lines.push(
      `- ${mark} \`${e.gate}\` (\`${e.cmd}\`) → exit ${e.exitCode}, ${e.durationMs}ms` +
        ` · ${e.source === 'user' ? '사용자' : '제안'}${unreproduced}`,
    )
    // 실패 원인을 리포트에서 바로 읽게 한다. tail은 통과 로그에 밀려 원인이 잘리므로
    // 여기 실리는 것은 꼬리가 아니라 추려낸 신호다
    for (const signal of e.signals ?? []) lines.push(`  - \`${signal}\``)
  }

  // 재확인에서 갈린 게이트의 회차별 결과. status 한 줄로는 간헐인지 결정론인지 구별되지 않는다
  const unreproducedGates = last?.unreproduced ?? []
  if (unreproducedGates.length > 0 && last?.recheck) {
    lines.push(``, `## 재확인 회차별 결과`, ``)
    for (const gate of unreproducedGates) {
      const runs = last.recheck.filter(e => e.gate === gate)
      const marks = runs.map(r => (r.outcome === 'pass' ? '✅' : r.outcome === 'fail' ? '❌' : '⚠️'))
      lines.push(`- \`${gate}\` 첫 회 ✅ → 재확인 ${marks.join(' ')}`)
      for (const signal of runs.flatMap(r => r.signals ?? []).slice(0, 10))
        lines.push(`  - \`${signal}\``)
    }
    lines.push(
      ``,
      `> 2회차부터 일정하게 깨졌다면 간헐적 실패가 아니라 이전 실행이 남긴 상태를 의심한다` +
        ` — 실전 첫 사례가 그랬다.`,
    )
  }

  // 재확인이 헛돌았을 정황. 통과 자체는 유효하므로 게이트 줄을 바꾸지 않고 따로 적는다 —
  // "재확인했다"는 말이 실제로 무엇을 확인한 것인지 사람이 따져 볼 숫자를 남긴다
  const suspects = last?.recheckSuspects ?? []
  if (suspects.length > 0) {
    lines.push(``, `## 재확인이 헛돌았을 수 있는 게이트`, ``)
    // 사유를 섞지 않는다. 실측에서 재확인이 **더 느렸던** 행에
    // "훨씬 빨리 끝났다"는 사실과 반대인 문장이 붙었다 — 데이터에 reason이 있는데 화면이 안 썼다
    for (const s of suspects)
      lines.push(
        s.reason === 'clean-too-fast'
          ? `- ⏱️ \`${s.gate}\` 청소를 명시했는데 첫 회가 ${s.firstMs}ms에 끝났다` +
            ` (재확인 ${s.recheckMs}ms) — **처음부터** 일이 일어나지 않았을 수 있다`
          : `- ⏱️ \`${s.gate}\` 첫 회 ${s.firstMs}ms → 재확인 ${s.recheckMs}ms` +
            ` (${Math.round((s.recheckMs / s.firstMs) * 100)}%) — **두 번째**가 헛돌았을 수 있다`,
      )
    const kinds = new Set(suspects.map(s => s.reason))
    lines.push(``)
    if (kinds.has('ratio'))
      lines.push(
        `> **비율**: 같은 리비전에 같은 명령인데 훨씬 빨리 끝났다. 빌드 캐시로 스킵됐다면 그 재확인은` +
          ` 아무것도 확인하지 않은 것이다 — 데몬이 덥혀져 정직하게 빨라졌을 수도 있으니 판정은 사람이 한다.`,
      )
    if (kinds.has('clean-too-fast'))
      lines.push(
        `> **절대 시간**: 청소를 명시한 명령이 몇 초에 끝났다. 비율은 이것을 볼 수 없다 —` +
          ` 첫 회부터 헛돌면 두 회 모두 빠르고 비율은 1에 가깝다. 대상 저장소의 빌드 캐시 설정을 보라.`,
      )
  }

  // 밀려난 제안을 남긴다. 이게 없으면 "에이전트가 러너의 결함을 짚었는데 러너가 삼킨"
  // 실행이 리포트상으로는 아무 일도 없었던 실행과 구별되지 않는다
  if (result.dropped && result.dropped.length > 0) {
    lines.push(``, `## 반영되지 않은 제안 게이트`, ``)
    for (const d of result.dropped)
      lines.push(
        d.reason === 'rejected'
          ? `- 🚫 \`${d.name}\` (\`${d.cmd}\`) → --reject-suggested로 받지 않음`
          : `- ⚠️ \`${d.name}\` (\`${d.cmd}\`) → 같은 이름의 사용자 게이트에 밀림` +
            ` · 실제 실행: \`${d.keptCmd}\``,
      )
  }

  // 완료의 정의가 실행 도중에 바뀌었으면 세운다. 금지가 아니라 가시화다 — 게이트를 더한
  // 실행도 있었고 그건 좋은 방향이었다. 다만 줄어든 것을 모르고 지나가서는 안 된다
  if (configChange) {
    lines.push(``, `## 실행 중 ${CONFIG_FILENAME}이 바뀌었다`, ``)
    if (configChange.removed) lines.push(`- 🚨 설정 파일이 삭제됐다 — 게이트 전부가 사라진다`)
    if (configChange.created) lines.push(`- 🆕 실행 중에 설정 파일이 새로 생겼다`)
    for (const g of configChange.droppedGates)
      lines.push(`- 🚨 게이트 \`${g}\`가 사라졌다 — 다음 실행부터 완료 기준이 그만큼 약해진다`)
    for (const g of configChange.addedGates) lines.push(`- ➕ 게이트 \`${g}\`가 추가됐다`)
    for (const g of configChange.rewrittenGates) lines.push(`- ✏️ 게이트 \`${g}\`의 명령이 바뀌었다`)
    lines.push(
      ``,
      `> 이번 판정은 **시작 시 읽은 설정**으로 했으므로 위 변경에 영향받지 않는다.` +
        ` 문제는 다음 실행이다 — 작업하는 쪽이 합격선을 낮출 수 있다면 그것은 합격선이 아니다.`,
    )
  }

  // 무엇이 언제 사라졌는지. "증거가 없다"는 주장 자체가 증거를 남겨야 한다
  if (lost && lost.length > 0) {
    lines.push(``, `## 증거 소실`, ``)
    for (const l of lost) lines.push(`- \`${l.target}\` — ${l.at}`)
    lines.push(
      ``,
      `> 되살려 이어갔지만 **그 사이의 증거는 남아 있지 않다.** 게이트가 통과했더라도` +
        ` 통과의 근거가 지워진 실행이므로 완료로 보지 않는다(\`evidence-lost\`).` +
        ` 실측 사례: 작업 지시가 "파일을 만들지 마라"였고 러너의 증거 디렉토리는 untracked` +
        ` 새 파일이라, 에이전트가 그것을 지시의 대상으로 읽었다.`,
    )
  }

  // 어느 턴도 사용량을 보고하지 않았으면 표를 만들지 않는다 — 0으로 채운 표는
  // "공짜로 돌았다"로 읽히고, 그건 모른다는 사실과 다르다
  const reported = result.usage && result.usage.plan.turns + result.usage.exec.turns > 0
  if (result.usage && reported) lines.push(``, `## Usage`, ``, ...usageLines(result.usage))

  // 비용 상한을 건 실행에서는 **상한이 무엇을 봤는지**까지 적는다. 금액만 적으면
  // 비용을 보고하지 않는 런타임이 섞인 실행에서 "상한 안에서 끝났다"가 거짓이 된다
  if (result.cost) {
    const c = result.cost
    lines.push(``, `## 비용 상한`, ``)
    lines.push(
      `- 상한 **$${c.limitUsd}** · 보고된 누적 ` +
        `**${c.spentUsd === undefined ? '-' : `$${c.spentUsd.toFixed(4)}`}**` +
        `${c.exceeded ? ' → 🛑 도달해 중단' : ''}`,
    )
    if (c.coverage === 'full')
      lines.push(`- ✅ 자원을 쓴 모든 턴이 비용을 보고했다 — 상한이 지출 전체를 봤다`)
    if (c.coverage === 'partial')
      lines.push(
        `- ⚠️ **상한이 지출의 일부만 봤다** — 계획/실행 중 한쪽이 비용을 보고하지 않는다.` +
          ` 위 금액이 상한 아래라도 실제 지출은 그보다 크다`,
      )
    if (c.coverage === 'not-run')
      lines.push(
        `- 한 턴도 돌지 않아 상한이 관여할 일이 없었다 — 이 실행은 런타임의 비용 보고 여부에` +
          ` 대해 아무것도 말하지 않는다`,
      )
    if (c.coverage === 'none')
      lines.push(
        `- 🚨 **상한이 걸리지 않았다** — 이 실행의 런타임이 비용을 보고하지 않는다(codex가 그렇다).` +
          ` 상한을 건 사실이 지출을 제한했다는 뜻이 아니다`,
      )
    lines.push(
      ``,
      `> 라운드 예산(\`--budget\`)은 지출의 상한이 아니다 — 실측에서 같은 조합의 1라운드가` +
        ` $1.64~$4.53으로 2.8배 흩어졌다. 두 축은 서로를 대신하지 못한다.`,
    )
  }

  /**
   * **라운드마다 무엇이 달라졌나.** 라운드가 하나면 견줄 앞이 없어 그리지 않는다.
   *
   * 한동안 이 자리에 표가 둘이었다 — diff 해시와 통과 수를 적는 `## Rounds`,
   * 남은 일을 적는 표. **같은 조건에 같은 축(라운드)이라 읽는 사람이 두 번 훑어야 했고**,
   * `gates 2/4 pass`는 남은 일 건수에서 파생되는 값이라 정보도 겹쳤다.
   *
   * diff 해시가 함께 있어야 하는 이유: 남은 일이 그대로여도 **파일이 달라졌다면 다른 시도**다.
   * 정체 판정이 그 둘을 함께 보는 것과 같은 이유이고, 사람이 사후에 그 판정을 검증하는 근거다.
   */
  if (result.rounds.length > 1) {
    lines.push(
      ``, `## 라운드별 진행`, ``,
      `| 라운드 | 리비전 | 남은 일 | 닫힘 | 되열림 |`,
      `|---|---|---|---|---|`,
    )
    for (let i = 0; i < result.rounds.length; i++) {
      const r = result.rounds[i]!
      const w = remainingWork(result.rounds.slice(0, i + 1))
      const same = r.repeatOf === undefined ? '' : ` · 라운드 ${r.repeatOf}과 동일`
      const left =
        w.open.length === 0
          ? '없음'
          : `${w.open.length}/${r.evidence.length} — ${w.open.join(', ')}`
      lines.push(
        `| ${r.round} | \`${r.revision.diffHash ?? 'untracked'}\`${same} | ${left}` +
          ` | ${w.closed.join(', ') || '·'} | ${w.reopened.join(', ') || '·'} |`,
      )
    }
  }
  return lines.join('\n')
}
