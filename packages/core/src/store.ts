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
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Goal, Round } from './goal'
import type { AgentEvent } from './adapter'
import {
  JOURNAL_FILENAME,
  parseJournal,
  serializeJournalEvent,
  type JournalEvent,
  type JournalInput,
} from './journal'

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
  /** 이 실행의 이름 = 증거 디렉토리 이름. 저널과 리포트가 같은 값을 가리켜야 한다 */
  readonly runId: string
  /**
   * 이 실행에서 증거가 사라진 기록. 비어 있는 것이 정상이고,
   * 하나라도 있으면 **그 실행의 판정은 증거로 뒷받침되지 않는다.**
   */
  readonly losses: EvidenceLoss[] = []
  /** 우리가 실제로 쓴 파일. "쓴 적 있는데 지금 없다"가 곧 삭제됐다는 뜻이다 */
  private written = new Set<string>()
  /**
   * 손실을 저널에도 적는 중인지. 저널 쓰기가 다시 손실을 발견해 자기를 부르는 재진입을 막는다 —
   * 저널 파일 자체가 지워진 경우가 정확히 그 모양이다.
   */
  private reporting = false

  constructor(projectDir: string, intent: string, now: Date = new Date(), runId?: string) {
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    this.runId = runId ?? `${stamp}-${slugify(intent)}`
    this.dir = join(projectDir, '.zannabi', 'runs', this.runId)
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 이미 있는 실행 디렉토리를 연다 — 재개가 쓴다.
   *
   * 이어받는 실행이 **같은 디렉토리에 계속 쓰는** 이유: 새 디렉토리로 가르면 한 작업의
   * 증거가 두 곳에 나뉘고, "이 작업이 몇 라운드 돌았나"에 답이 두 개 생긴다.
   * 손실 추적(`written`)이 비어 있는 채로 시작하는 것은 의도한 것이다 —
   * 이 프로세스가 실제로 쓴 파일만 "사라졌다"고 말할 수 있다.
   */
  static open(projectDir: string, runId: string): RunStore {
    return new RunStore(projectDir, '', new Date(), runId)
  }

  /**
   * 쓰기 직전에 증거가 아직 거기 있는지 본다.
   *
   * 없으면 되살리되 **그 사실을 기록한다.** 순서가 중요하다 — 기록 없이 되살리면
   * 다음 쓰기가 성공하면서 아무 일도 없었던 것처럼 보인다.
   */
  private guard(name: string) {
    if (!existsSync(this.dir)) {
      const loss = { at: new Date().toISOString(), target: WHOLE_RUN }
      this.losses.push(loss)
      mkdirSync(this.dir, { recursive: true })
      // 디렉토리가 통째로 날아갔으면 안에 있던 것도 전부 사라졌다
      this.written.clear()
      this.reportLoss(loss.target)
      return
    }
    if (this.written.has(name) && !existsSync(join(this.dir, name))) {
      const loss = { at: new Date().toISOString(), target: name }
      this.losses.push(loss)
      this.written.delete(name)
      this.reportLoss(loss.target)
    }
  }

  /**
   * 손실을 저널에도 남긴다. **밖에서 tail하는 쪽은 `losses` 배열을 볼 수 없기 때문이다** —
   * 그 배열은 러너 메모리에 있고 리포트가 쓰일 때까지 나오지 않는데, 증거가 사라지는 사건은
   * 실행이 끝난 뒤에 알아 봐야 늦다.
   */
  private reportLoss(target: string) {
    if (this.reporting) return
    this.reporting = true
    try {
      this.appendJournal({ type: 'evidence-lost', target })
    } finally {
      this.reporting = false
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
  /**
   * 저널 한 줄. 시각은 여기서 찍는다 — 호출부가 `at`을 빠뜨릴 여지를 없앤다.
   *
   * 다른 증거와 같은 `write` 경로를 쓰므로 저널 파일이 지워지는 것도 손실로 잡힌다.
   * 다만 그 손실 기록이 다시 저널 쓰기를 부르므로 {@link reporting}으로 한 번만 돈다.
   */
  appendJournal(input: JournalInput): JournalEvent {
    const event = { ...input, at: new Date().toISOString() } as JournalEvent
    this.write(JOURNAL_FILENAME, serializeJournalEvent(event), true)
    return event
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

export const RUNS_DIR = join('.zannabi', 'runs')

/**
 * 이 프로젝트의 실행들. 최신이 앞이다.
 *
 * 디렉토리 이름이 `<ISO 시각>-<슬러그>` 라서 문자열 역순이 곧 시간 역순이다 —
 * 파일 시스템 시각(mtime)을 믿지 않는 이유는 복사·체크아웃이 그것을 바꾸기 때문이다.
 * 이름은 실행이 만든 사실이고 mtime은 파일이 겪은 사건이다.
 */
export function listRuns(projectDir: string): string[] {
  const dir = join(projectDir, RUNS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .reverse()
}

/**
 * 실행 이름을 디렉토리 경로로. 이름이 정확히 맞지 않으면 **접미사로도 찾는다** —
 * `2026-08-21T...-슬러그` 전체를 손으로 치게 하는 것은 도구가 할 일이 아니다.
 * 여러 개가 걸리면 고르지 않고 후보를 돌려준다: 임의로 하나를 집으면 사용자가
 * 자기가 무엇을 보고 있는지 모르게 된다.
 */
export function resolveRun(
  projectDir: string,
  name?: string,
): { ok: true; runId: string; dir: string } | { ok: false; reason: string; candidates?: string[] } {
  const runs = listRuns(projectDir)
  if (runs.length === 0) return { ok: false, reason: `${join(projectDir, RUNS_DIR)} 에 실행 기록이 없습니다` }
  if (name === undefined) return { ok: true, runId: runs[0], dir: join(projectDir, RUNS_DIR, runs[0]) }
  if (runs.includes(name)) return { ok: true, runId: name, dir: join(projectDir, RUNS_DIR, name) }
  const matches = runs.filter(r => r.includes(name))
  if (matches.length === 1) return { ok: true, runId: matches[0], dir: join(projectDir, RUNS_DIR, matches[0]) }
  if (matches.length === 0) return { ok: false, reason: `그런 실행이 없습니다: ${name}`, candidates: runs.slice(0, 5) }
  return { ok: false, reason: `이름이 여러 실행에 걸립니다: ${name}`, candidates: matches }
}

/** 실행 디렉토리의 저널을 읽는다. 저널이 없으면 빈 배열 — 옛 실행에는 아예 없다 */
export function readJournal(runDir: string) {
  const path = join(runDir, JOURNAL_FILENAME)
  if (!existsSync(path)) return []
  return parseJournal(readFileSync(path, 'utf-8'))
}
