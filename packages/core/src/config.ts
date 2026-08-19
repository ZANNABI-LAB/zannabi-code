/**
 * 프로젝트 설정 파일 `.zannabi.json`.
 *
 * 존재 이유는 편의가 아니라 **재현성**이다. 완료 기준과 예산이 사람의 기억이나 셸 히스토리에
 * 있으면 같은 조건으로 두 번 돌릴 수 없고, 실행끼리 비교하는 이 프로젝트의 측정이 성립하지 않는다.
 *
 * 우선순위는 CLI 플래그 > 설정 파일 > 기본값이다. 파일이 명시적 플래그를 이기면
 * 그때그때 다른 조건으로 한 번 돌려보는 일이 불가능해진다.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { GateSchema } from './goal'

export const CONFIG_FILENAME = '.zannabi.json'

export const ConfigSchema = z.object({
  /** 항상 걸리는 게이트. 여기 적힌 것은 사용자 게이트로 취급한다 — 완료의 정의이기 때문이다 */
  gates: z.array(GateSchema.extend({ source: z.literal('user').default('user') })).optional(),
  budget: z.number().int().min(1).optional(),
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
