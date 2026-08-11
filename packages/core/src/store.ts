import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Goal, Evidence } from './goal'
import type { AgentEvent } from './adapter'

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'run'
}

export class RunStore {
  readonly dir: string

  constructor(projectDir: string, intent: string, now: Date = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    this.dir = join(projectDir, '.zannabi', 'runs', `${stamp}-${slugify(intent)}`)
    mkdirSync(this.dir, { recursive: true })
  }

  writeGoal(goal: Goal) {
    writeFileSync(join(this.dir, 'goal.json'), JSON.stringify(goal, null, 2))
  }
  writePlan(text: string) {
    writeFileSync(join(this.dir, 'plan.md'), text)
  }
  appendTranscript(event: AgentEvent) {
    appendFileSync(join(this.dir, 'transcript.jsonl'), JSON.stringify(event) + '\n')
  }
  writeEvidence(rounds: Evidence[][]) {
    writeFileSync(join(this.dir, 'evidence.json'), JSON.stringify(rounds, null, 2))
  }
  writeDiff(patch: string) {
    writeFileSync(join(this.dir, 'diff.patch'), patch)
  }
  writeReport(text: string) {
    writeFileSync(join(this.dir, 'report.md'), text)
  }
}
