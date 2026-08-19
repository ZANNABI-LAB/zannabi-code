import { z } from 'zod'

export const GateSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  timeoutMs: z.number().int().positive().default(300_000),
})
export type Gate = z.infer<typeof GateSchema>

export const GoalSchema = z.object({
  intent: z.string().min(1),
  gates: z.array(GateSchema),
  budget: z.number().int().min(1).default(3),
})
export type Goal = z.infer<typeof GoalSchema>

export const EvidenceSchema = z.object({
  gate: z.string(),
  cmd: z.string(),
  outcome: z.enum(['pass', 'fail', 'error']),
  exitCode: z.number().nullable(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  durationMs: z.number(),
  timestamp: z.string(),
})
export type Evidence = z.infer<typeof EvidenceSchema>

const gatesBlock = z.object({ gates: z.array(GateSchema) })

/**
 * 계획 본문에서 게이트 제안을 뽑는다.
 *
 * 프롬프트는 "답변 끝에 JSON 블록 하나"를 요구하므로 **마지막 블록부터** 훑는다.
 * 계획 안에 예시나 인용 블록이 먼저 나오면 첫 블록을 집는 쪽은 엉뚱한 것을 읽는다.
 */
export function extractGates(text: string): Gate[] | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const result = gatesBlock.safeParse(JSON.parse(blocks[i][1]))
      if (result.success) return result.data.gates
    } catch {
      // 이 블록은 게이트가 아니다 — 앞쪽 블록을 계속 본다
    }
  }
  return null
}
