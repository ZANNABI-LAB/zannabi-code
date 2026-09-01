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

/**
 * 게이트 밖 주장을 신고하게 하는 절.
 *
 * **산문으로 요구해 봤고 실패했다.** 실측 지시서에 "확인한 것과 확인하지 못한 것을 나눠
 * 적어라"가 있었는데도 뒤쪽이 비었고, 바로 그 자리에서 에이전트가 틀렸다.
 * 그래서 형식을 강제하고, 러너가 파싱한다 — 빈 목록을 **내는 것**과 아무것도 안 내는 것이
 * 갈려야 "없다고 말했다"가 검증 가능한 진술이 된다.
 *
 * **셸을 열어 준 것이 이 문제를 만들었다는 사실을 프롬프트가 말한다.** 대부분 돌릴 수 있게
 * 되면 돌릴 수 없는 나머지가 눈에 안 띈다 — 그것을 알려 주는 것이 지시의 요점이다.
 *
 * 판정에 쓰지 않는다는 것도 함께 밝힌다. 신고가 완료를 좌우한다고 오해하면 에이전트는
 * 신고를 줄이는 쪽으로 움직이고, 그러면 이 절이 정확히 반대 효과를 낸다.
 */
const CLAIMS_SECTION =
  `\n\nBefore finishing, report what the gates do NOT cover.\n\n` +
  `The runner will re-run the verification commands itself, so anything they check is already ` +
  `covered — do not list it. What matters is the opposite: statements you are making that no ` +
  `command in this project will confirm. Typical sources are files no gate touches (UI markup, ` +
  `docs, config), claims about what code does NOT do ("nothing else reads this value"), and ` +
  `behaviour you reasoned about but did not execute.\n\n` +
  `Being able to run commands makes this harder to notice, not easier: when most things are ` +
  `checkable, the few that are not stop standing out. Those are the ones that tend to be wrong.\n\n` +
  `This report does NOT decide completion — the runner's gate results do. Listing more does not ` +
  `hurt you. Listing nothing when something exists does hurt the person reading your work.\n\n` +
  `End your reply with exactly one JSON code block. If everything you claim is gate-covered, ` +
  `say so with an empty list — an empty list and a missing block are not the same thing:\n` +
  '```json\n' +
  `{"claims": [{"claim": "the settings page still renders after the rename", ` +
  `"basis": "read", "why": "no gate loads the HTML"}]}\n` +
  '```\n' +
  `basis: "read" = you read the relevant code; "inferred" = you reasoned without reading it ` +
  `end to end; "unverified" = you are not sure.`

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
    `\n\nPlan:\n${plan}${retry}` +
    CLAIMS_SECTION
  )
}

/**
 * 다음 라운드에 전할 말. **실패 로그가 아니라 남은 일 목록으로 시작한다.**
 *
 * 여기가 Phase 14의 자리다 — 예산은 "몇 번 더 시도할 수 있는가"만 말하지 **무엇이 남았는지**는
 * 말하지 않는다. 게이트 실패는 그 자체로 "할 일 하나"의 객관 버전인데(gajae `ultragoal`의
 * blocker와 달리 에이전트의 판단이 아니라 종료코드가 만든다), 지금까지는 stderr 더미로만
 * 전달돼 목표가 아니라 증상으로 읽혔다.
 *
 * `repeated`는 직전 라운드와 변경분·게이트 결과가 모두 같았다는 뜻이다.
 * 같은 접근을 한 번 더 시키는 것은 예산 낭비라, 그 사실을 프롬프트에 명시해 방향을 틀게 한다.
 */
export function failureSummary(
  evidence: Evidence[],
  repeated = false,
  work?: { open: string[]; closed: string[]; reopened: string[] },
): string {
  const head: string[] = []
  if (work && work.open.length > 0) {
    head.push(`REMAINING WORK — ${work.open.length} gate(s) still failing: ${work.open.join(', ')}`)
    if (work.closed.length > 0) head.push(`Closed in the last round: ${work.closed.join(', ')}`)
    /**
     * 회귀는 남은 일 **개수**로는 드러나지 않는다 — 하나를 풀며 하나를 깨면 개수가 그대로다.
     * 그런데 그때 필요한 행동은 "계속 고치기"가 아니라 "접근을 다시 보기"라 따로 말한다.
     */
    if (work.reopened.length > 0)
      head.push(
        `⚠️ REGRESSION: ${work.reopened.join(', ')} passed in the previous round and fail now.` +
          ' Your last change fixed one thing and broke another — reconsider the approach' +
          ' instead of patching forward.',
      )
  }
  const body = evidence
    .filter(e => e.outcome !== 'pass')
    .map(e => `[${e.gate}] ${e.cmd} → exit ${e.exitCode}\n${e.stderrTail || e.stdoutTail}`)
    .join('\n\n')
  const summary = head.length > 0 ? `${head.join('\n')}\n\n${body}` : body
  if (!repeated) return summary
  return `${summary}\n\nNOTE: your last attempt changed no files and produced identical gate results.\nRepeating the same approach will not help — diagnose why the fix is not taking effect, or try a different approach.`
}
