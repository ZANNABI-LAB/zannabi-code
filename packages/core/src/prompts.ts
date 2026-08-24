import type { Evidence } from './goal'

/**
 * 러너의 증거 저장소를 건드리지 말라는 한 줄.
 *
 * 감지(`store.ts`)가 본체고 이건 예방이다 — 지시는 강제가 아니므로 이것만 믿을 수 없다.
 * 다만 실측에서 지운 에이전트는 **어긋난 것이 아니라 지시를 따른 것**이었다(작업 지시가
 * "파일을 만들지 마라"였고 `.zannabi/`는 untracked 새 파일이었다). 그런 오해는 한 줄로 막힌다.
 */
const PROTECT_EVIDENCE =
  'The `.zannabi/` directory is the runner\'s evidence store, not part of the project. ' +
  'Never delete, move, clean, or commit it, even when asked to keep the working tree clean ' +
  'or to avoid creating files.'

export function planPrompt(intent: string): string {
  return `You are planning a coding task. Do NOT modify any files yet.

Task: ${intent}

${PROTECT_EVIDENCE}

1. Write a short implementation plan (numbered steps).
2. Propose verification gates: shell commands that prove the task is done
   (tests, build, lint). Prefer commands that exist in this project.

End your reply with exactly one JSON code block:
\`\`\`json
{"gates": [{"name": "test", "cmd": "bun test"}]}
\`\`\``
}

/**
 * 자기 확인용으로 열어 준 명령을 **문자 그대로** 알려주는 절.
 *
 * 이것이 없으면 열어 놓고 말을 안 한 것이 된다. 에이전트는 계획서에 적힌 명령을 베끼는데,
 * 계획서의 명령은 **사람이 지시서에 다시 타이핑한 판**이라 원본과 조금씩 다르다.
 * 실측에서 따옴표 종류 하나(`'*ApiAuthTest*'` → `"*ApiAuthTest*"`)가 달라 13번의 시도가
 * 전부 거부됐고, 에이전트는 거부 사유를 못 받으므로 그대로 눈 감고 404줄을 썼다.
 * 그 실행은 라운드를 하나 더 쓰고 $7.01로 끝났다 — 정상 동작한 쪽은 $2.87이었다.
 *
 * **정규화가 아니라 이쪽이 근본이다.** 따옴표 스타일을 맞춰 주는 것은 다음 변형(인자 순서·
 * 앞에 붙는 플래그)에서 또 뚫린다. 러너는 정확한 문자열을 알고 있으므로 그것을 주면 된다.
 */
function selfCheckSection(open: string[], closed: string[]): string {
  if (open.length === 0 && closed.length === 0) return ''
  let out = ''
  if (open.length > 0)
    out +=
      `\n\nYou may run these verification commands yourself while working, to check your ` +
      `own changes before finishing:\n` +
      open.map(c => `  ${c}`).join('\n') +
      `\n\nCopy them EXACTLY as written above — quote characters included. ` +
      `A command that differs even slightly will be silently denied, and you will not be told why. ` +
      `You may append arguments and pipes (e.g. \` 2>&1 | tail -30\`); the prefix must match.\n` +
      `These are the SAME commands the runner will use to judge completion, but your runs do ` +
      `NOT count as the verdict — the runner re-runs them itself afterwards.`
  // **못 여는 것을 감추지 않는다.** 완료 기준의 일부인데 목록에서 빠지면 에이전트는 그것이
  // 존재하는 줄도 모르고, 알더라도 "왜 나만 빼놨나"를 알 수 없다
  if (closed.length > 0)
    out +=
      `\n\nThese verification commands will ALSO decide completion, but you cannot run them ` +
      `yourself — their shape (command substitution, leading \`!\`, …) cannot be granted:\n` +
      closed.map(c => `  ${c}`).join('\n') +
      `\n\nDo not attempt them; the attempt will be denied. Reason about them from the code, ` +
      `or check the same thing with a simpler command of your own.`
  return out
}

export function executePrompt(
  plan: string,
  feedback?: string,
  /** 에이전트가 직접 돌릴 수 있는 명령 */
  openCmds: string[] = [],
  /** 완료를 정하지만 에이전트는 돌릴 수 없는 명령 */
  closedCmds: string[] = [],
): string {
  const retry = feedback
    ? `\n\nPrevious attempt FAILED verification. Evidence:\n${feedback}\n\nFix the issues and try again.`
    : ''
  return (
    `Execute this plan. Modify files as needed.\n\n${PROTECT_EVIDENCE}` +
    selfCheckSection(openCmds, closedCmds) +
    `\n\nPlan:\n${plan}${retry}`
  )
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
