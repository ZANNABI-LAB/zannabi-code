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

export function extractGates(text: string): Gate[] | null {
  const match = text.match(/```json\s*([\s\S]*?)```/)
  if (!match) return null
  try {
    const result = gatesBlock.safeParse(JSON.parse(match[1]))
    return result.success ? result.data.gates : null
  } catch {
    return null
  }
}
