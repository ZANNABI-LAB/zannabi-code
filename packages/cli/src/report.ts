import { addUsage, emptyUsage, type LoopResult, type Usage } from '@zannabi-lab/core'

// diff 캡처는 core로 옮겼다 — 루프가 라운드마다 워킹트리를 찍어야 하기 때문이다.
// CLI는 최종 diff 저장에만 쓰므로 여기서는 재수출만 한다
export { captureDiff } from '@zannabi-lab/core'

/**
 * 사용량 표. 계획과 실행을 나눠 적는 것이 요점이다 — "강한 계획 + 약한 실행"의 값을
 * 재려면 어느 쪽이 얼마를 썼는지가 갈려 있어야 한다.
 *
 * 비용을 보고하지 않는 러너(codex)는 `-`로 남긴다. 0원으로 적으면 공짜라는 거짓이 된다.
 */
function usageLines(usage: { plan: Usage; exec: Usage }): string[] {
  const cost = (u: Usage) => (u.costUsd === undefined ? '-' : `$${u.costUsd.toFixed(4)}`)
  const row = (name: string, u: Usage) =>
    `| ${name} | ${u.turns} | ${u.inputTokens.toLocaleString()} | ` +
    `${(u.cachedInputTokens ?? 0).toLocaleString()} | ${u.outputTokens.toLocaleString()} | ${cost(u)} |`
  const total = addUsage(addUsage(emptyUsage(), usage.plan), usage.exec)
  return [
    `| 턴 | 횟수 | in | cached | out | cost |`,
    `|---|---|---|---|---|---|`,
    row('plan', usage.plan),
    row('exec', usage.exec),
    row('합계', total),
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
