/**
 * 프로젝트 설정 파일 `.zannabi.json`.
 *
 * 존재 이유는 편의가 아니라 **재현성**이다. 완료 기준과 예산이 사람의 기억이나 셸 히스토리에
 * 있으면 같은 조건으로 두 번 돌릴 수 없고, 실행끼리 비교하는 이 프로젝트의 측정이 성립하지 않는다.
 *
 * 우선순위는 CLI 플래그 > 설정 파일 > 기본값이다. 파일이 명시적 플래그를 이기면
 * 그때그때 다른 조건으로 한 번 돌려보는 일이 불가능해진다.
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { GateSchema } from './goal'

export const CONFIG_FILENAME = '.zannabi.json'

export const ConfigSchema = z.object({
  /** 조합 프리셋 이름. 개별 필드가 이것을 이긴다 — 프리셋은 기본값 묶음이지 지정을 덮어쓰는 것이 아니다 */
  profile: z.string().optional(),
  /** 항상 걸리는 게이트. 여기 적힌 것은 사용자 게이트로 취급한다 — 완료의 정의이기 때문이다 */
  gates: z.array(GateSchema.extend({ source: z.literal('user').default('user') })).optional(),
  budget: z.number().int().min(1).optional(),
  /** 비용 상한(USD). 예산과 다른 축이다 — 라운드 수는 지출을 제어하지 못한다 */
  maxCostUsd: z.number().positive().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  planAgent: z.string().optional(),
  planModel: z.string().optional(),
  execAgent: z.string().optional(),
  execModel: z.string().optional(),
  stallLimit: z.number().int().min(0).optional(),
  verifyRepeat: z.number().int().min(1).optional(),
  gateTimeoutMs: z.number().int().positive().optional(),
  rejectSuggested: z.boolean().optional(),
})
export type Config = z.infer<typeof ConfigSchema>

export type ConfigLoad =
  | { ok: true; config: Config; path?: string }
  | { ok: false; path: string; error: string }

/**
 * `.zannabi.json`을 읽는다. 없으면 빈 설정이고 그것은 오류가 아니다.
 *
 * 반대로 **있는데 깨졌으면 오류로 세운다.** 조용히 무시하면 사용자는 설정이 걸린 줄 알고
 * 돌리는데 실제로는 다른 조건으로 도는, 측정에서 가장 나쁜 실패가 된다.
 */
export function loadConfig(cwd: string): ConfigLoad {
  const path = join(cwd, CONFIG_FILENAME)
  if (!existsSync(path)) return { ok: true, config: {} }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { ok: false, path, error: `JSON 파싱 실패: ${err instanceof Error ? err.message : err}` }
  }
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      path,
      error: parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    }
  return { ok: true, config: parsed.data, path }
}

/**
 * 설정 파일의 지문. 파일이 없으면 없다 — 없는 것과 빈 것은 다른 사실이다.
 *
 * 왜 필요한가: 이 파일은 **대상 저장소 안에** 있으므로 작업하는 에이전트가 쓸 수 있다.
 * 실전에서 에이전트가 `recovery` 게이트를 지우고 자기 작업용 게이트를 넣은 실행이 있었다.
 * 그 실행은 시작 시 읽은 원본으로 판정돼 결과가 유효했지만, **다음 실행부터 완료의 정의가
 * 조용히 약해진다.** 작업하는 쪽이 합격선을 낮출 수 있다면 그것은 합격선이 아니다.
 */
export function configFingerprint(cwd: string): string | undefined {
  const path = join(cwd, CONFIG_FILENAME)
  if (!existsSync(path)) return undefined
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return undefined
  }
}

/** 실행 도중 설정 파일에 무슨 일이 있었는지 */
export interface ConfigChange {
  /** 파일이 사라졌으면 true — 게이트 전부가 사라진 것과 같다 */
  removed: boolean
  /** 실행 시작 이후 없던 파일이 생겼으면 true */
  created: boolean
  /** 없어진 사용자 게이트 이름. 완료의 정의가 줄어든 것이라 가장 위험하다 */
  droppedGates: string[]
  /** 새로 생긴 게이트 이름. 대개 좋은 방향이지만 그래도 사람이 알아야 한다 */
  addedGates: string[]
  /** 이름은 그대로인데 명령이 바뀐 게이트 */
  rewrittenGates: string[]
}

/**
 * 실행 전후의 설정을 비교한다. 바뀐 것이 없으면 undefined.
 *
 * 금지하지 않고 **가시화**하는 이유: 게이트를 지운 실행도 있었지만 **더한** 실행도 있었고
 * 그건 좋은 방향이었다. 무엇이 옳은 변경인지는 도구가 판단할 수 없다. 다만 완료의 정의가
 * 실행 도중에 바뀌었다면 그 사실이 사람 눈에 띄지 않은 채 지나가서는 안 된다.
 */
export function compareConfig(
  before: { fingerprint?: string; config: Config },
  cwd: string,
): ConfigChange | undefined {
  const after = configFingerprint(cwd)
  if (before.fingerprint === after) return undefined
  if (before.fingerprint !== undefined && after === undefined)
    return {
      removed: true,
      created: false,
      droppedGates: (before.config.gates ?? []).map(g => g.name),
      addedGates: [],
      rewrittenGates: [],
    }
  // 지금 파일이 깨졌다면 게이트를 읽을 수 없다. 그래도 "바뀌었다"는 사실은 남긴다
  const loaded = loadConfig(cwd)
  const nowGates = loaded.ok ? (loaded.config.gates ?? []) : []
  const wasGates = before.config.gates ?? []
  const byName = (gates: { name: string; cmd: string }[]) =>
    new Map(gates.map(g => [g.name, g.cmd]))
  const was = byName(wasGates)
  const now = byName(nowGates)
  return {
    removed: false,
    created: before.fingerprint === undefined,
    droppedGates: [...was.keys()].filter(n => !now.has(n)),
    addedGates: [...now.keys()].filter(n => !was.has(n)),
    rewrittenGates: [...was.entries()].filter(([n, cmd]) => now.has(n) && now.get(n) !== cmd).map(([n]) => n),
  }
}
