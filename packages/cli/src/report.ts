import type { LoopResult } from '@zannabi-lab/core'

export function buildReport(result: LoopResult, intent: string): string {
  const lines = [
    `# zannabi run report`,
    ``,
    `- **intent**: ${intent}`,
    `- **status**: ${result.status}`,
    `- **attempts**: ${result.attempts}`,
    ``,
    `## Gates (최종 라운드)`,
    ``,
  ]
  const last = result.evidence.at(-1) ?? []
  for (const e of last) {
    const mark = e.outcome === 'pass' ? '✅' : e.outcome === 'fail' ? '❌' : '⚠️'
    lines.push(`- ${mark} \`${e.gate}\` (\`${e.cmd}\`) → exit ${e.exitCode}, ${e.durationMs}ms`)
  }
  return lines.join('\n')
}

export async function captureDiff(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(['git', 'diff', 'HEAD'], { cwd, stdout: 'pipe', stderr: 'ignore' })
    if ((await proc.exited) !== 0) return ''
    return await new Response(proc.stdout).text()
  } catch {
    return '' // git 없음/저장소 아님 — diff는 부가 증거라 조용히 스킵
  }
}
