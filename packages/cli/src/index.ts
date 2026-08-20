#!/usr/bin/env bun
// packages/cli/src/index.ts
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import {
  RunStore, runLoop, FakeAdapter, fakeResult, GateSchema, loadConfig,
  configFingerprint, compareConfig,
  PROFILES, PROFILE_NAMES, isProfileName,
  DEFAULT_STALL_LIMIT, DEFAULT_VERIFY_REPEAT, DEFAULT_GATE_TIMEOUT_MS, CONFIG_FILENAME,
  type Gate, type GateWarning, type AgentAdapter, type ApprovalDecision, type Profile,
} from '@zannabi-lab/core'
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

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string', default: '.' },
      budget: { type: 'string' },
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
      profile: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
  })
  const [command, intent] = positionals
  if (command !== 'run' || !intent) {
    console.error(
      '사용법: zannabi run "<작업 설명>" [--cwd .] [--budget 3] [--gate "name:cmd"]' +
      ` [--agent ${AGENTS.join('|')}] [--model <이름>] [--yes]\n` +
      '  생성-검증 분리: [--plan-agent/--plan-model] [--exec-agent/--exec-model]\n' +
      `  루프 계측: [--stall-limit N] (기본 ${DEFAULT_STALL_LIMIT}, 0이면 끔)` +
      ` [--verify-repeat N] (통과 재확인 횟수, 기본 ${DEFAULT_VERIFY_REPEAT})\n` +
      '  게이트 고정: [--no-suggest] (제안 게이트 거부)' +
      ` [--gate-timeout <ms>] (기본 ${DEFAULT_GATE_TIMEOUT_MS})\n` +
      `  조합 프리셋: [--profile ${PROFILE_NAMES.join('|')}]\n` +
      PROFILE_NAMES.map(n => `    ${n.padEnd(9)} ${PROFILES[n].summary}`).join('\n') + '\n' +
      `  우선순위: 플래그 > ${CONFIG_FILENAME}의 개별 항목 > 프리셋 > 기본값`,
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

  const budget = number('budget', values.budget, config.budget ?? profile.budget ?? 3, 1)
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

  const store = new RunStore(cwd, intent)
  const { buildReport, captureDiff } = await import('./report')

  const result = await runLoop({
    intent,
    userGates,
    budget,
    cwd,
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
    approve: values.yes ? approveAutomatically : approveViaTerminal,
    log: message => console.log(`[zannabi] ${message}`),
  })

  const configChange = compareConfig(configBefore, cwd)
  const diff = await captureDiff(cwd)
  if (diff) store.writeDiff(diff)
  const report = buildReport(result, intent, configChange)
  store.writeReport(report)

  console.log(`\n${report}\n`)
  console.log(`[zannabi] 증거: ${store.dir}`)
  if (result.status === 'no-gates')
    console.error('[zannabi] 게이트가 없어 실행을 거부했습니다. --gate "name:cmd"로 지정하세요.')
  if (result.status === 'env-error')
    console.error('[zannabi] 게이트 환경 오류 — 명령이 이 환경에서 실행 가능한지 확인하세요.')
  if (result.status === 'agent-error')
    console.error('[zannabi] 에이전트 실행 실패 — 아래 사유를 확인하세요.')
  if (result.status === 'flaky-gate')
    console.error(
      '[zannabi] 게이트 통과가 재현되지 않았습니다. 간헐적으로 실패하는 게이트를 ' +
      '고치거나, 재확인이 과하면 --verify-repeat 1로 끄세요.',
    )
  if (result.status === 'no-progress')
    console.error(
      '[zannabi] 진전이 없어 예산을 남기고 중단했습니다. ' +
      '게이트가 실제로 달성 가능한지 보고, 필요하면 --stall-limit으로 조절하세요.',
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
