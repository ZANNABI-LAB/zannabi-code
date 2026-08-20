import { addUsage, emptyUsage, type LoopResult, type Usage } from '@zannabi-lab/core'

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

export function buildReport(result: LoopResult, intent: string): string {
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

  const last = result.rounds.at(-1)
  lines.push(``, `## Gates (최종 라운드)`, ``)
  for (const e of last?.evidence ?? []) {
    const mark = e.outcome === 'pass' ? '✅' : e.outcome === 'fail' ? '❌' : '⚠️'
    // 출처를 적어야 "완료 기준이 안 됐다"와 "에이전트 자기 검사가 안 됐다"가 구별된다
    const flaky = last?.flaky?.includes(e.gate) ? ' · 🎲 flaky' : ''
    lines.push(
      `- ${mark} \`${e.gate}\` (\`${e.cmd}\`) → exit ${e.exitCode}, ${e.durationMs}ms` +
        ` · ${e.source === 'user' ? '사용자' : '제안'}${flaky}`,
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
