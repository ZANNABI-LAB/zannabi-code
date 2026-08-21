/**
 * 실행 증거 저장소.
 *
 * **이 디렉토리는 대상 저장소 안에 있고, 작업하는 에이전트가 지울 수 있다.**
 * 가정이 아니라 관측이다 — 2026-08-20 실측에서 haiku 실행이 `.zannabi/` 전체를 삭제했고
 * 러너가 `appendTranscript`의 ENOENT로 죽었다. 에이전트가 어긋난 것도 아니었다:
 * 의도가 "어떤 파일도 만들거나 수정하거나 삭제하지 않는다"였고, 러너가 만든 증거 디렉토리는
 * **untracked 새 파일**이므로 그 지시의 사정권 안에 있었다. 에이전트가 제안한 게이트 이름이
 * 그 해석을 증언한다 — `worktree-clean`, `untracked-unchanged`.
 *
 * 그래서 두 가지를 한다. **죽지 않고**, **삼키지 않는다.**
 * 조용히 재생성만 하면 증거 공백이 감춰지고, 앞 라운드 증거가 사라진 채 마지막에 리포트만
 * 새로 쓰인 실행이 완결돼 보인다 — 그것은 거짓 초록이다. 사라졌다는 **사실**을 기록해
 * 루프가 판정을 강등할 수 있게 한다.
 */
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Goal, Round } from './goal'
import type { AgentEvent } from './adapter'

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'run'
}

/** 증거가 사라진 사건 하나. 무엇이 언제 없어졌는지 */
export interface EvidenceLoss {
  at: string
  /** 사라진 대상. 실행 디렉토리 전체가 날아갔으면 {@link WHOLE_RUN} */
  target: string
}

export const WHOLE_RUN = '(실행 디렉토리 전체)'

export class RunStore {
  readonly dir: string
  /**
   * 이 실행에서 증거가 사라진 기록. 비어 있는 것이 정상이고,
   * 하나라도 있으면 **그 실행의 판정은 증거로 뒷받침되지 않는다.**
   */
  readonly losses: EvidenceLoss[] = []
  /** 우리가 실제로 쓴 파일. "쓴 적 있는데 지금 없다"가 곧 삭제됐다는 뜻이다 */
  private written = new Set<string>()

  constructor(projectDir: string, intent: string, now: Date = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    this.dir = join(projectDir, '.zannabi', 'runs', `${stamp}-${slugify(intent)}`)
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 쓰기 직전에 증거가 아직 거기 있는지 본다.
   *
   * 없으면 되살리되 **그 사실을 기록한다.** 순서가 중요하다 — 기록 없이 되살리면
   * 다음 쓰기가 성공하면서 아무 일도 없었던 것처럼 보인다.
   */
  private guard(name: string) {
    if (!existsSync(this.dir)) {
      this.losses.push({ at: new Date().toISOString(), target: WHOLE_RUN })
      mkdirSync(this.dir, { recursive: true })
      // 디렉토리가 통째로 날아갔으면 안에 있던 것도 전부 사라졌다
      this.written.clear()
      return
    }
    if (this.written.has(name) && !existsSync(join(this.dir, name))) {
      this.losses.push({ at: new Date().toISOString(), target: name })
      this.written.delete(name)
    }
  }

  private write(name: string, body: string, append = false) {
    this.guard(name)
    const path = join(this.dir, name)
    if (append) appendFileSync(path, body)
    else writeFileSync(path, body)
    this.written.add(name)
  }

  writeGoal(goal: Goal) {
    this.write('goal.json', JSON.stringify(goal, null, 2))
  }
  writePlan(text: string) {
    this.write('plan.md', text)
  }
  appendTranscript(event: AgentEvent) {
    this.write('transcript.jsonl', JSON.stringify(event) + '\n', true)
  }
  writeEvidence(rounds: Round[]) {
    this.write('evidence.json', JSON.stringify(rounds, null, 2))
  }
  writeDiff(patch: string) {
    this.write('diff.patch', patch)
  }
  /**
   * 라운드별 변경분. 최종 diff 하나만 남기면 "몇 라운드째에 무엇이 달라졌나"를
   * 사후에 확인할 방법이 없다 — no-progress 판정의 근거도 여기서 검증된다.
   */
  writeRoundDiff(round: number, patch: string) {
    const name = join('rounds', `round-${round}.patch`)
    this.guard(name)
    mkdirSync(join(this.dir, 'rounds'), { recursive: true })
    writeFileSync(join(this.dir, name), patch)
    this.written.add(name)
  }
  writeReport(text: string) {
    this.write('report.md', text)
  }
}
