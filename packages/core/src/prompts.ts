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

export function failureSummary(evidence: Evidence[]): string {
  return evidence
    .filter(e => e.outcome !== 'pass')
    .map(e => `[${e.gate}] ${e.cmd} → exit ${e.exitCode}\n${e.stderrTail || e.stdoutTail}`)
    .join('\n\n')
}
