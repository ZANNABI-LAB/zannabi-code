#!/usr/bin/env bun
// packages/cli/src/index.ts
import { parseArgs } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import {
  RunStore, runLoop, FakeAdapter, fakeResult, GateSchema, loadConfig,
  configFingerprint, compareConfig,
  PROFILES, PROFILE_NAMES, isProfileName,
  DEFAULT_STALL_LIMIT, DEFAULT_VERIFY_REPEAT, DEFAULT_GATE_TIMEOUT_MS, CONFIG_FILENAME,
  listRuns, resolveRun, readJournal, replay, RUNS_DIR, resumability, toRounds,
  createWorktree, removeWorktree, commitRound, commitCount, branchDiff, worktreeUsable, WorktreeError,
  type Worktree, type Round,
  type ResumeState,
  type Gate, type GateWarning, type AgentAdapter, type ApprovalDecision, type Profile,
} from '@zannabi-lab/core'
import { renderStatus, renderRunLine } from './status'
import { ClaudeAdapter } from '@zannabi-lab/adapter-claude'
import { CodexAdapter } from '@zannabi-lab/adapter-codex'

const AGENTS = ['claude', 'codex'] as const
type AgentName = (typeof AGENTS)[number]

function parseGateFlag(value: string): Gate {
  const idx = value.indexOf(':')
  if (idx < 1) throw new Error(`--gate 형식은 "name:cmd" 입니다: ${value}`)
  // 사람이 건 게이트는 완료의 정의다 — 에이전트의 자기 검사와 구별해 결과를 따로 집계한다
  return GateSchema.parse({ name: value.slice(0, idx), cmd: value.slice(idx + 1), source: 'user' })
}

interface RuntimeChoice {
  agent: AgentName
  model?: string
}

function pickAdapter({ agent, model }: RuntimeChoice): AgentAdapter {
  if (process.env.ZANNABI_ADAPTER === 'fake') {
    // E2E용: 계획(게이트 true 제안) + 실행 응답
    return new FakeAdapter([
      fakeResult('계획: 한다.\n```json\n{"gates":[{"name":"ok","cmd":"true"}]}\n```'),
      fakeResult('실행했습니다.'),
    ])
  }
  return agent === 'codex' ? new CodexAdapter({ model }) : new ClaudeAdapter({ model })
}

/** 증거에 남길 표기. 모델을 지정 안 했으면 CLI 기본값이라는 뜻으로 default를 적는다 */
function label({ agent, model }: RuntimeChoice): string {
  return `${agent}:${model ?? 'default'}`
}

function printPlan(plan: string, gates: Gate[], warnings: GateWarning[]) {
  console.log('\n===== 계획 =====\n')
  console.log(plan)
  console.log('\n===== 게이트 =====\n')
  for (const g of gates) console.log(`  - ${g.name}: ${g.cmd}`)
  if (warnings.length > 0) {
    console.log('\n===== 경고 =====\n')
    // 실행을 막는 경고와 조언을 눈으로도 구별되게 한다 — 사람이 승인 여부를 가르는 기준이 다르다
    for (const w of warnings)
      console.log(`  ${w.kind === 'blocking' ? '⛔' : '⚠️ '} ${w.gate}: ${w.reason}`)
  }
}

async function approveViaTerminal(
  plan: string, gates: Gate[], warnings: GateWarning[],
): Promise<ApprovalDecision> {
  printPlan(plan, gates, warnings)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('\n이 계획과 게이트로 진행할까요? [y/N] ')).trim().toLowerCase()
  rl.close()
  return answer === 'y' ? { action: 'approve' } : { action: 'abort', reason: '사람이 승인하지 않음' }
}

/**
 * --yes: 사람 승인을 건너뛴다. 대신 **실행 불가한** 게이트가 있으면 거부한다 —
 * 사람이 안 보는 만큼 기계가 최소한의 검사를 대신한다.
 *
 * 조언성 경고로는 거부하지 않는다. 배치 실행이 조언 때문에 죽으면 사용자는 조언을 읽는 대신
 * 경고 자체를 끄는 쪽으로 가고, 그러면 정작 막아야 할 경고까지 함께 꺼진다.
 */
async function approveAutomatically(
  plan: string, gates: Gate[], warnings: GateWarning[],
): Promise<ApprovalDecision> {
  printPlan(plan, gates, warnings)
  const blocking = warnings.filter(w => w.kind === 'blocking')
  if (blocking.length > 0)
    return {
      action: 'abort',
      reason: `--yes 모드에서 실행 불가한 게이트를 거부했습니다: ${blocking
        .map(w => `[${w.gate}] ${w.reason}`)
        .join('; ')}`,
    }
  console.log('\n[zannabi] --yes: 승인 없이 진행합니다.')
  return { action: 'approve' }
}

/**
 * 저널만 읽어 상태를 말한다. `report.md`도 `evidence.json`도 읽지 않는 것이 요점이다 —
 * 저널 하나에서 나오지 않는 정보는 여기 뜰 수 없고, 안 뜨면 계약이 부족한 것이다.
 */
async function status(cwd: string, name?: string) {
  if (name === undefined) {
    const runs = listRuns(cwd)
    if (runs.length === 0) {
      console.error(`[zannabi] ${RUNS_DIR} 에 실행 기록이 없습니다`)
      process.exit(1)
    }
    for (const runId of runs.slice(0, 20))
      console.log(renderRunLine(runId, replay(readJournal(`${cwd}/${RUNS_DIR}/${runId}`))))
    if (runs.length > 20) console.log(`... 외 ${runs.length - 20}건`)
    return
  }

  const found = resolveRun(cwd, name)
  if (!found.ok) {
    console.error(`[zannabi] ${found.reason}`)
    // 후보를 함께 보여준다 — 이름을 못 맞춘 사용자에게 "없습니다"만 주면 다음 수가 없다
    for (const c of found.candidates ?? []) console.error(`  ${c}`)
    process.exit(1)
  }
  const events = readJournal(found.dir)
  if (events.length === 0) {
    console.error(
      `[zannabi] ${found.runId} 에 저널이 없습니다 — 저널을 쓰기 전 판으로 돌린 실행이거나 지워졌습니다`,
    )
    process.exit(1)
  }
  console.log(renderStatus(replay(events)))
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string', default: '.' },
      budget: { type: 'string' },
      'max-cost': { type: 'string' },
      gate: { type: 'string', multiple: true, default: [] },
      model: { type: 'string' },
      agent: { type: 'string' },
      'plan-agent': { type: 'string' },
      'plan-model': { type: 'string' },
      'exec-agent': { type: 'string' },
      'exec-model': { type: 'string' },
      'stall-limit': { type: 'string' },
      'verify-repeat': { type: 'string' },
      'gate-timeout': { type: 'string' },
      'no-suggest': { type: 'boolean' },
      worktree: { type: 'boolean' },
      profile: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
  })
  const [command, intent] = positionals

  // status는 저널만 읽는다 — 설정도 어댑터도 필요 없으므로 run의 준비 과정 앞에서 갈린다
  if (command === 'status') return status(resolve(values.cwd), intent)

  // resume은 이름을 생략할 수 있다 — 대개 방금 죽은 그 실행을 이어가려는 것이다
  if ((command !== 'run' && command !== 'resume') || (command === 'run' && !intent)) {
    console.error(
      '사용법: zannabi run "<작업 설명>" [--cwd .] [--budget 3] [--gate "name:cmd"]' +
      ` [--agent ${AGENTS.join('|')}] [--model <이름>] [--yes]\n` +
      '  생성-검증 분리: [--plan-agent/--plan-model] [--exec-agent/--exec-model]\n' +
      `  루프 계측: [--stall-limit N] (기본 ${DEFAULT_STALL_LIMIT}, 0이면 끔)` +
      ` [--verify-repeat N] (통과 재확인 횟수, 기본 ${DEFAULT_VERIFY_REPEAT})\n` +
      '  비용 상한: [--max-cost <USD>] (예산과 별개 축 — 라운드 수는 지출을 제어하지 못한다)\n' +
      '  격리: [--worktree] (전용 워크트리에서 돌고 결과를 zannabi/<실행> 브랜치로 남긴다)\n' +
      '  게이트 고정: [--no-suggest] (제안 게이트 거부)' +
      ` [--gate-timeout <ms>] (기본 ${DEFAULT_GATE_TIMEOUT_MS})\n` +
      `  조합 프리셋: [--profile ${PROFILE_NAMES.join('|')}]\n` +
      PROFILE_NAMES.map(n => `    ${n.padEnd(9)} ${PROFILES[n].summary}`).join('\n') + '\n' +
      `  우선순위: 플래그 > ${CONFIG_FILENAME}의 개별 항목 > 프리셋 > 기본값\n` +
      '\n이어서 돌기: zannabi resume [<실행 이름 일부>] [--cwd .] [--budget N]\n' +
      '  중단된 지점의 다음 라운드부터 갑니다 — 계획과 승인은 다시 묻지 않습니다\n' +
      '\n상태 보기: zannabi status [<실행 이름 일부>] [--cwd .]\n' +
      '  저널(journal.jsonl)만 읽어 재구성합니다 — 실행 중에도, 러너가 죽은 뒤에도 볼 수 있습니다',
    )
    process.exit(1)
  }

  const cwd = resolve(values.cwd)
  const loaded = loadConfig(cwd)
  if (!loaded.ok) {
    // 설정이 있는데 깨졌으면 세운다 — 조용히 무시하면 사용자가 믿는 조건과 실제 조건이 갈린다
    console.error(`[zannabi] ${loaded.path} 을(를) 읽을 수 없습니다 — ${loaded.error}`)
    process.exit(1)
  }
  const config = loaded.config
  if (loaded.path) console.log(`[zannabi] 설정 사용: ${loaded.path}`)

  // 프리셋은 "기본값 묶음"이다 — 개별 지정을 덮어쓰지 않고 그 아래 층에 깔린다.
  // 그래야 프리셋으로 조합을 고정하면서 한 항목만 바꿔 실험하는 일이 가능하다
  const profileName = values.profile ?? config.profile
  if (profileName !== undefined && !isProfileName(profileName)) {
    console.error(`[zannabi] --profile은 ${PROFILE_NAMES.join(' | ')} 중 하나여야 합니다: ${profileName}`)
    process.exit(1)
  }
  const profile: Partial<Profile> = profileName ? PROFILES[profileName] : {}
  if (profileName) console.log(`[zannabi] 프리셋 ${profileName}: ${profile.summary}`)

  // 사용자가 실제로 쓴 플래그를 짚어야 고칠 자리를 안다
  for (const flag of ['agent', 'plan-agent', 'exec-agent'] as const) {
    const given = values[flag]
    if (given === undefined || AGENTS.includes(given as AgentName)) continue
    console.error(`[zannabi] --${flag}는 ${AGENTS.join(' | ')} 중 하나여야 합니다: ${given}`)
    process.exit(1)
  }
  for (const [key, given] of [
    ['agent', config.agent], ['planAgent', config.planAgent], ['execAgent', config.execAgent],
  ] as const) {
    if (given === undefined || AGENTS.includes(given as AgentName)) continue
    console.error(`[zannabi] ${CONFIG_FILENAME}의 ${key}는 ${AGENTS.join(' | ')} 중 하나여야 합니다: ${given}`)
    process.exit(1)
  }

  // 우선순위: 플래그 > 설정 파일 > 프리셋 > 기본값
  const agent = (values.agent ?? config.agent ?? 'claude') as AgentName
  const model = values.model ?? config.model
  // 계획 턴에는 프리셋이 개입하지 않는다 — 실측이 "계획은 낮추지 마라"였으므로
  // 값을 지정하는 대신 건드리지 않는 방식으로 그 방침을 지킨다
  const plan: RuntimeChoice = {
    agent: (values['plan-agent'] ?? config.planAgent ?? agent) as AgentName,
    model: values['plan-model'] ?? config.planModel ?? model,
  }
  const exec: RuntimeChoice = {
    agent: (values['exec-agent'] ?? config.execAgent ?? profile.execAgent ?? agent) as AgentName,
    model: values['exec-model'] ?? config.execModel ?? profile.execModel ?? model,
  }

  /** 숫자 플래그 하나를 검증해 꺼낸다. 잘못된 값은 기본값으로 조용히 흘리지 않고 세운다 */
  function number(flag: string, raw: string | undefined, fallback: number, min: number): number {
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min) {
      console.error(`[zannabi] --${flag}은(는) ${min} 이상의 정수여야 합니다: ${raw}`)
      process.exit(1)
    }
    return value
  }

  /**
   * 비용 상한만 정수가 아니다 — 돈은 $2.50처럼 쪼개진다.
   * 0은 "상한 없음"이 아니라 "한 푼도 쓰지 마라"로 읽히므로 받지 않는다. 안 쓰면 없는 것이다.
   */
  function usd(raw: string | undefined, fallback?: number): number | undefined {
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`[zannabi] --max-cost는 0보다 큰 금액이어야 합니다: ${raw}`)
      process.exit(1)
    }
    return value
  }

  const budget = number('budget', values.budget, config.budget ?? profile.budget ?? 3, 1)
  const maxCostUsd = usd(values['max-cost'], config.maxCostUsd)
  const stallLimit = number('stall-limit', values['stall-limit'], config.stallLimit ?? DEFAULT_STALL_LIMIT, 0)
  const verifyRepeat = number(
    'verify-repeat',
    values['verify-repeat'],
    config.verifyRepeat ?? profile.verifyRepeat ?? DEFAULT_VERIFY_REPEAT,
    1,
  )
  const gateTimeoutMs = number('gate-timeout', values['gate-timeout'], config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS, 1)
  const rejectSuggested = values['no-suggest'] ?? config.rejectSuggested ?? false

  let userGates: Gate[]
  try {
    // 설정 파일의 게이트가 먼저다 — 프로젝트의 완료 정의이고, 플래그는 그 위에 얹는 추가분이다.
    // 이름이 겹치면 그때그때 준 플래그가 이긴다
    const fromFlags = (values.gate as string[]).map(parseGateFlag)
    const fromConfig = (config.gates ?? []).map(g => GateSchema.parse({ ...g, source: 'user' }))
    userGates = [...fromConfig.filter(c => !fromFlags.some(f => f.name === c.name)), ...fromFlags]
  } catch (err) {
    console.error(`[zannabi] ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // 완료의 정의가 실행 도중에 바뀌는지 본다 — 설정 파일은 대상 저장소 안에 있어
  // 작업하는 에이전트가 쓸 수 있다. 실제로 게이트를 지운 실행이 있었다
  const configBefore = { fingerprint: configFingerprint(cwd), config }

  // 격리를 못 하는 자리인지 **증거 디렉토리를 만들기 전에** 본다. 거부할 실행이
  // 빈 디렉토리를 남기면 status 목록에 기록 없는 실행이 쌓이고, 측정에 노이즈가 된다
  if (values.worktree) {
    const usable = await worktreeUsable(cwd)
    if (!usable.ok) {
      console.error(`[zannabi] ${usable.reason}`)
      process.exit(1)
    }
  }

  /**
   * 재개면 저널에서 이어받을 것을 꺼낸다.
   *
   * 계획 본문만 `plan.md`에서 온다 — 저널에 계획 전문을 싣지 않기로 한 대가다.
   * 상태 재구성(`status`)은 저널 하나로 되고, 재개는 실행 디렉토리 전체를 쓴다.
   */
  let store: RunStore
  let runIntent = intent ?? ''
  let effectiveBudget = budget
  let resume: ResumeState | undefined

  if (command === 'resume') {
    const found = resolveRun(cwd, intent)
    if (!found.ok) {
      console.error(`[zannabi] ${found.reason}`)
      for (const c of found.candidates ?? []) console.error(`  ${c}`)
      process.exit(1)
    }
    const state = replay(readJournal(found.dir))
    // 예산을 늘려 이어가는 것은 허용한다 — 남은 것이 없어 멈춘 실행에 대고
    // "예산을 다 썼다"만 말하면 사용자에게 다음 수가 없다
    if (values.budget) effectiveBudget = budget
    else if (state.budget !== undefined) effectiveBudget = state.budget
    const can = resumability({ ...state, budget: effectiveBudget })
    if (!can.ok) {
      console.error(`[zannabi] ${found.runId} 을(를) 이어서 돌 수 없습니다 — ${can.reason}`)
      process.exit(1)
    }
    const planPath = join(found.dir, 'plan.md')
    if (!existsSync(planPath)) {
      console.error(
        `[zannabi] ${found.runId} 에 plan.md가 없습니다 — 승인된 계획 없이는 이어갈 수 없습니다`,
      )
      process.exit(1)
    }
    runIntent = state.intent ?? ''
    store = RunStore.open(cwd, found.runId)
    resume = {
      planText: readFileSync(planPath, 'utf-8'),
      gates: state.gates,
      rounds: toRounds(state.rounds),
      startRound: can.nextRound,
      usage: state.usage,
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    }
    console.log(
      `[zannabi] 재개: ${found.runId} · 완료된 라운드 ${state.rounds.length}개 · ` +
        `라운드 ${can.nextRound}부터 · 예산 ${effectiveBudget}` +
        (state.spentUsd === undefined ? '' : ` · 이월 지출 $${state.spentUsd.toFixed(4)}`),
    )
    if (state.partialRound !== undefined)
      console.log(
        `[zannabi] 라운드 ${state.partialRound}은 검증이 끝나지 않아 완료로 세지 않습니다 — 처음부터 다시 돕니다`,
      )
  } else {
    store = new RunStore(cwd, runIntent)
  }

  /**
   * 격리를 켰으면 전용 워크트리를 만들고 **루프에는 그 경로를 `cwd`로 준다.**
   * 루프는 워크트리를 모른다 — 어댑터도 게이트도 리비전도 `cwd` 하나만 보기 때문이다.
   * 증거(`.zannabi/`)는 원본 저장소에 남는다: 실행의 기록은 워크트리보다 오래 산다.
   */
  let worktree: Worktree | undefined
  if (values.worktree) {
    try {
      worktree = await createWorktree(cwd, store.runId)
    } catch (err) {
      console.error(
        `[zannabi] ${err instanceof WorktreeError ? err.message : `워크트리 준비 실패: ${err}`}`,
      )
      process.exit(1)
    }
    console.log(`[zannabi] 워크트리: ${worktree.path} (브랜치 ${worktree.branch})`)
    // 원본의 미커밋 작업은 딸려오지 않는다. 그것을 모르고 "왜 내 수정이 없지"를 겪게 두지 않는다
    if (worktree.uncommittedInOrigin > 0)
      console.log(
        `[zannabi] 원본에 미커밋 변경 ${worktree.uncommittedInOrigin}건이 있습니다 — ` +
          `워크트리는 HEAD(${worktree.base.slice(0, 8)})에서 갈라졌으므로 그 변경은 포함되지 않습니다`,
      )
  }
  const workDir = worktree?.path ?? cwd

  const { buildReport, captureDiff } = await import('./report')

  const result = await runLoop({
    intent: runIntent,
    userGates,
    budget: effectiveBudget,
    maxCostUsd,
    cwd: workDir,
    adapter: pickAdapter(plan),
    // 조합이 같으면 어댑터 하나만 쓴다 — 같은 런타임인데 세션이 끊기면 손해다
    execAdapter: label(plan) === label(exec) ? undefined : pickAdapter(exec),
    runtime: { plan: label(plan), exec: label(exec) },
    stallLimit,
    verifyRepeat,
    gateTimeoutMs,
    rejectSuggested,
    profile: profileName,
    store,
    ...(resume === undefined ? {} : { resume }),
    // 라운드마다 커밋한다 — 실패로 끝난 실행의 작업물도 사라지면 안 되고,
    // 라운드별 커밋은 "몇 번째 시도에서 무엇이 달라졌나"를 git 이력 자체로 말한다
    ...(worktree === undefined
      ? {}
      : {
          afterRound: async (round: Round) => {
            const pass = round.evidence.filter(e => e.outcome === 'pass').length
            const done = await commitRound(
              worktree!.path,
              round.round,
              `게이트 ${pass}/${round.evidence.length} 통과`,
            )
            if (done.committed)
              console.log(`[zannabi] 라운드 ${round.round} 커밋: ${done.sha?.slice(0, 8)}`)
          },
        }),
    approve: values.yes ? approveAutomatically : approveViaTerminal,
    log: message => console.log(`[zannabi] ${message}`),
  })

  // 설정 변조는 에이전트가 **작업한 자리**에서 본다 — 워크트리면 거기가 그 자리다
  const configChange = compareConfig(configBefore, workDir)
  // 워크트리는 라운드마다 커밋하므로 끝난 시점의 워킹트리는 깨끗하다.
  // 그때 워킹트리 diff를 쓰면 증거가 "아무것도 안 바꿨다"고 거짓말을 한다
  const diff = worktree ? await branchDiff(cwd, worktree) : await captureDiff(cwd)
  if (diff) store.writeDiff(diff)
  // 루프가 끝난 뒤 쓴 것(최종 diff)까지 포함한 최신 손실을 싣는다
  const report = buildReport(result, intent, configChange, store.losses)
  store.writeReport(report)

  console.log(`\n${report}\n`)
  console.log(`[zannabi] 증거: ${store.dir}`)

  if (worktree) {
    // 브랜치는 남기고 워크트리만 치운다 — 브랜치가 곧 사용자에게 돌려주는 결과다.
    // 실패로 끝난 실행의 브랜치도 지우지 않는다: 3라운드를 태운 시도에도 이어받을 것이 있다
    const commits = await commitCount(cwd, worktree)
    const cleanup = await removeWorktree(cwd, worktree)
    if (commits > 0) {
      console.log(`[zannabi] 결과: 브랜치 ${worktree.branch} (커밋 ${commits}개)`)
      console.log(`         git merge ${worktree.branch} 로 가져가세요`)
    } else {
      console.log(`[zannabi] 브랜치 ${worktree.branch}에 커밋이 없습니다 — 바뀐 파일이 없었습니다`)
    }
    if (!cleanup.removed)
      console.error(
        `[zannabi] 워크트리를 치우지 못했습니다: ${cleanup.leftAt} — git worktree prune 후 지우세요`,
      )
  }
  if (result.status === 'no-gates')
    console.error('[zannabi] 게이트가 없어 실행을 거부했습니다. --gate "name:cmd"로 지정하세요.')
  if (result.status === 'env-error')
    console.error('[zannabi] 게이트 환경 오류 — 명령이 이 환경에서 실행 가능한지 확인하세요.')
  if (result.status === 'agent-error')
    console.error('[zannabi] 에이전트 실행 실패 — 아래 사유를 확인하세요.')
  if (result.status === 'unreproduced-pass')
    console.error(
      '[zannabi] 게이트 통과가 재현되지 않았습니다. 원인은 간헐적 실패일 수도 있고, ' +
      '두 번째 실행부터 항상 깨지는 결정론적 결함일 수도 있습니다 — 실전 첫 사례는 후자였습니다' +
      '(이전 실행이 남긴 상태를 다음 실행이 함께 세는 종류). 재확인 증거의 회차별 결과를 ' +
      '먼저 보고, 재확인이 과하면 --verify-repeat 1로 끄세요.',
    )
  if (store.losses.length > 0)
    console.error(
      `[zannabi] 🚨 실행 도중 증거가 ${store.losses.length}건 사라졌습니다 — 작업하는 에이전트가 ` +
      '`.zannabi/`를 지울 수 있습니다. 되살려 이어갔지만 그 사이의 증거는 없습니다. ' +
      '리포트의 「증거 소실」 절을 확인하세요.',
    )
  if (result.status === 'evidence-lost')
    console.error(
      '[zannabi] 게이트는 전부 통과했지만 증거가 사라져 완료로 보지 않았습니다. ' +
      '증거 없으면 완료가 아니라는 것이 이 도구의 전제입니다 — 다시 돌려 증거를 남기세요.',
    )
  if (result.status === 'cost-exhausted')
    console.error(
      '[zannabi] 비용 상한에 도달해 멈췄습니다. 여기까지의 작업물은 워킹트리에 그대로 있고 ' +
      '증거도 남아 있습니다 — 이어서 하려면 --max-cost를 올려 다시 돌리세요. ' +
      '라운드 예산(--budget)은 지출을 제어하지 못하므로 두 축을 함께 보세요.',
    )
  if (result.cost && result.cost.coverage !== 'full' && result.cost.coverage !== 'not-run')
    console.error(
      result.cost.coverage === 'none'
        ? '[zannabi] 이 실행의 런타임이 비용을 보고하지 않아 --max-cost가 걸리지 않았습니다.'
        : '[zannabi] --max-cost가 지출의 일부만 봤습니다 — 한쪽 런타임이 비용을 보고하지 않습니다. ' +
          '보고된 금액이 상한 아래여도 실제 지출은 그보다 큽니다.',
    )
  if (result.status === 'no-progress')
    console.error(
      '[zannabi] 진전이 없어 예산을 남기고 중단했습니다. ' +
      '게이트가 실제로 달성 가능한지 보고, 필요하면 --stall-limit으로 조절하세요.',
    )
  if (result.stallDead && result.status === 'budget-exhausted')
    console.error(
      '[zannabi] 정체 감지가 이 조합에서는 발동할 수 없었습니다(stall-limit >= budget). ' +
      '라운드별 diff 해시가 같은데 예산까지 갔다면 감지가 안 걸린 게 아니라 못 걸린 것입니다.',
    )
  if (configChange && (configChange.droppedGates.length > 0 || configChange.removed))
    console.error(
      '[zannabi] 실행 도중 설정 파일에서 게이트가 사라졌습니다 — 이번 판정은 시작 시 읽은 ' +
      '원본으로 했지만, 다음 실행부터는 완료 기준이 약해집니다. 리포트를 확인하세요.',
    )
  if (result.detail) console.error(`[zannabi] 사유: ${result.detail}`)
  process.exit(result.status === 'success' ? 0 : 1)
}

main().catch(err => {
  // 처리되지 않은 예외가 조용한 비정상 종료로 새지 않게 한다
  console.error(`[zannabi] 예기치 못한 오류: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
  process.exit(1)
})
