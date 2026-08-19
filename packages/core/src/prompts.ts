import type { Evidence } from './goal'

export function planPrompt(intent: string): string {
  return `You are planning a coding task. Do NOT modify any files yet.

Task: ${intent}

1. Write a short implementation plan (numbered steps).
2. Propose verification gates: shell commands that prove the task is done
   (tests, build, lint). Prefer commands that exist in this project.

End your reply with exactly one JSON code block:
\`\`\`json
{"gates": [{"name": "test", "cmd": "bun test"}]}
\`\`\``
}

export function executePrompt(plan: string, feedback?: string): string {
  const retry = feedback
    ? `\n\nPrevious attempt FAILED verification. Evidence:\n${feedback}\n\nFix the issues and try again.`
    : ''
  return `Execute this plan. Modify files as needed.\n\nPlan:\n${plan}${retry}`
}

/**
 * `repeated`는 직전 라운드와 변경분·게이트 결과가 모두 같았다는 뜻이다.
 * 같은 접근을 한 번 더 시키는 것은 예산 낭비라, 그 사실을 프롬프트에 명시해 방향을 틀게 한다.
 */
export function failureSummary(evidence: Evidence[], repeated = false): string {
  const body = evidence
    .filter(e => e.outcome !== 'pass')
    .map(e => `[${e.gate}] ${e.cmd} → exit ${e.exitCode}\n${e.stderrTail || e.stdoutTail}`)
    .join('\n\n')
  if (!repeated) return body
  return `${body}\n\nNOTE: your last attempt changed no files and produced identical gate results.\nRepeating the same approach will not help — diagnose why the fix is not taking effect, or try a different approach.`
}
