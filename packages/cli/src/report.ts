import {
  addUsage, emptyUsage, CONFIG_FILENAME,
  type ConfigChange, type LoopResult, type Usage,
} from '@zannabi-lab/core'

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

export function buildReport(
  result: LoopResult,
  intent: string,
  configChange?: ConfigChange,
): string {
  const lines = [
    `# zannabi run report`,
    ``,
    `- **intent**: ${intent}`,
    `- **status**: ${result.status}`,
    `- **attempts**: ${result.attempts}`,
  ]
  // 어떤 조합으로 돌았는지 — 조합별 비교의 기본 축
  if (result.runtime)
    lines.push(`- **runtime**: plan=\`${result.runtime.plan}\` exec=\`${result.runtime.exec}\``)
  // 증거가 어느 리비전 위의 것인지. 이게 없으면 report는 재현 불가능한 주장이 된다
  const head = result.rounds.at(-1)?.revision.head
  if (head) lines.push(`- **head**: \`${head}\``)
  // 실패 사유를 리포트에 싣는다 — transcript.jsonl을 파싱하지 않아도 원인이 보이게
  if (result.detail) lines.push(`- **detail**: ${result.detail}`)
  // 예산 소진으로 끝난 실행을 나중에 읽을 때, 정체 감지가 안 걸린 것인지 못 걸린 것인지 갈린다
  if (result.stallDead)
    lines.push(
      `- ⚠️ **정체 감지 꺼짐**: stall-limit이 예산 이상이라 이 실행에서는 발동할 수 없었다` +
        ` — 라운드가 제자리였더라도 예산 소진으로 끝난다`,
    )

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
    for (const s of suspects)
      lines.push(
        `- ⏱️ \`${s.gate}\` 첫 회 ${s.firstMs}ms → 재확인 ${s.recheckMs}ms` +
          ` (${Math.round((s.recheckMs / s.firstMs) * 100)}%)`,
      )
    lines.push(
      ``,
      `> 같은 리비전에 같은 명령인데 훨씬 빨리 끝났다. 빌드 캐시로 스킵됐다면 이 재확인은` +
        ` 아무것도 확인하지 않은 것이다 — 데몬이 덥혀져 정직하게 빨라졌을 수도 있으니 판정은 사람이 한다.`,
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

  // 어느 턴도 사용량을 보고하지 않았으면 표를 만들지 않는다 — 0으로 채운 표는
  // "공짜로 돌았다"로 읽히고, 그건 모른다는 사실과 다르다
  const reported = result.usage && result.usage.plan.turns + result.usage.exec.turns > 0
  if (result.usage && reported) lines.push(``, `## Usage`, ``, ...usageLines(result.usage))

  // 라운드별 diff 해시. 어느 라운드에서 파일이 실제로 달라졌는지가 한눈에 보여야
  // no-progress 판정을 사람이 사후 검증할 수 있다
  if (result.rounds.length > 1) {
    lines.push(``, `## Rounds`, ``)
    for (const r of result.rounds) {
      const passed = r.evidence.filter(e => e.outcome === 'pass').length
      const repeat = r.repeatOf !== undefined ? ` — 라운드 ${r.repeatOf}과 동일` : ''
      lines.push(
        `- ${r.round}: diff \`${r.revision.diffHash ?? 'untracked'}\`` +
          `, gates ${passed}/${r.evidence.length} pass${repeat}`,
      )
    }
  }
  return lines.join('\n')
}
