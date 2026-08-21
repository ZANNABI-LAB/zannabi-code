/**
 * 워크트리 격리.
 *
 * **왜 필요한가**: 같은 저장소에서 두 실행이 동시에 돌면 서로의 변경을 자기 것으로 본다.
 * 리비전 결박(`diffHash`)도 no-progress 판정도 "이 워킹트리의 변경분"을 재는데, 그 워킹트리가
 * 공유되면 두 실행의 증거가 서로를 오염시킨다 — 판정이 틀리는 것을 넘어 **증거가 거짓이 된다.**
 *
 * **왜 브랜치로 돌려주는가**: 성공한 작업물을 사용자의 워킹트리에 자동으로 적용하면
 * 미커밋 변경과 충돌할 수 있고, 그 순간 러너가 사람의 작업을 건드린다. 이 도구의 전제는
 * "에이전트를 믿지 않는다"인데 그 에이전트의 결과물을 묻지도 않고 사람 책상에 올리는 것은
 * 앞뒤가 안 맞는다. 브랜치는 남기고 병합은 사람이 한다.
 *
 * **왜 라운드마다 커밋하는가**: 실패로 끝난 실행의 작업물도 사라지면 안 된다. 3라운드를
 * 태우고 실패한 실행에도 사람이 이어받을 만한 것이 남아 있을 수 있고, 무엇보다
 * 라운드별 커밋은 "몇 번째 시도에서 무엇이 달라졌나"를 git 이력 자체로 말한다.
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function git(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out, err }
}

export interface Worktree {
  /** 에이전트와 게이트가 도는 자리. 루프에는 이 경로가 `cwd`로 들어간다 */
  path: string
  /** 작업물이 쌓이는 브랜치. 실행이 끝나도 남는다 — 이것이 사용자에게 돌려주는 결과다 */
  branch: string
  /** 갈라져 나온 지점. 사람이 무엇 위의 작업인지 알아야 병합을 판단할 수 있다 */
  base: string
  /** 워크트리를 만들 때 원본에 남아 있던 미커밋 변경 파일 수. 0이 아니면 그 작업은 딸려오지 않았다 */
  uncommittedInOrigin: number
}

export class WorktreeError extends Error {}

/**
 * 이 프로젝트에서 워크트리를 쓸 수 있는지 본다.
 *
 * 커밋이 하나도 없는 저장소는 갈라 나올 지점이 없다 — 그 사실을 실행 전에 말한다.
 * 게이트를 다 돌고 나서 "사실 격리가 안 됐습니다"를 알리는 것이 최악이다.
 */
export async function worktreeUsable(cwd: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd)
  if (inside.code !== 0 || inside.out.trim() !== 'true')
    return { ok: false, reason: 'git 저장소가 아닙니다 — 워크트리 격리는 git 위에서만 됩니다' }
  const head = await git(['rev-parse', 'HEAD'], cwd)
  if (head.code !== 0)
    return {
      ok: false,
      reason: '커밋이 하나도 없는 저장소입니다 — 갈라져 나올 지점이 없어 워크트리를 만들 수 없습니다',
    }
  return { ok: true }
}

/** 원본에 남아 있는 미커밋 변경 파일 수 (미추적 포함) */
async function countUncommitted(cwd: string): Promise<number> {
  const status = await git(['status', '--porcelain', '--untracked-files=all'], cwd)
  if (status.code !== 0) return 0
  return status.out.split('\n').filter(l => l.trim() && !l.includes('.zannabi/')).length
}

/**
 * 실행 전용 워크트리를 만든다.
 *
 * 저장소 **밖**(시스템 임시 디렉토리)에 두는 이유: 저장소 안에 두면 그 디렉토리가
 * 원본의 미추적 파일로 잡혀 원본의 diff에 섞이고, 격리하려던 것이 도로 오염원이 된다.
 */
export async function createWorktree(cwd: string, runId: string): Promise<Worktree> {
  const usable = await worktreeUsable(cwd)
  if (!usable.ok) throw new WorktreeError(usable.reason)

  const base = (await git(['rev-parse', 'HEAD'], cwd)).out.trim()
  const uncommittedInOrigin = await countUncommitted(cwd)
  const branch = `zannabi/${runId}`
  const path = join(mkdtempSync(join(tmpdir(), 'zannabi-wt-')), 'work')

  const add = await git(['worktree', 'add', '-b', branch, path, 'HEAD'], cwd)
  if (add.code !== 0)
    throw new WorktreeError(`워크트리를 만들지 못했습니다: ${add.err.trim() || add.out.trim()}`)

  return { path, branch, base, uncommittedInOrigin }
}

/**
 * 한 라운드의 결과를 워크트리 브랜치에 커밋한다. 바뀐 것이 없으면 커밋하지 않는다.
 *
 * `user.name`/`user.email`을 명령마다 넘기는 이유: 러너가 도는 환경에 git 신원이 설정돼
 * 있으리라는 보장이 없고(CI 컨테이너가 흔히 그렇다), 없으면 커밋이 실패한다.
 * 사용자의 git 설정을 바꾸지 않으면서 이 커밋에만 신원을 주는 방법이 `-c`다.
 */
export async function commitRound(
  worktreePath: string,
  round: number,
  summary: string,
): Promise<{ committed: boolean; sha?: string }> {
  await git(['add', '-A'], worktreePath)
  const staged = await git(['diff', '--cached', '--name-only'], worktreePath)
  if (staged.out.trim() === '') return { committed: false }

  const message = `zannabi: round ${round}\n\n${summary}`
  const commit = await git(
    [
      '-c', 'user.name=zannabi',
      '-c', 'user.email=zannabi@localhost',
      'commit', '--no-verify', '-m', message,
    ],
    worktreePath,
  )
  if (commit.code !== 0) return { committed: false }
  const sha = (await git(['rev-parse', 'HEAD'], worktreePath)).out.trim()
  return { committed: true, sha }
}

/**
 * 이 실행이 만든 변경 전체 — 갈라진 지점부터 브랜치 끝까지.
 *
 * 워크트리에서는 라운드마다 커밋하므로 **끝난 시점의 워킹트리 diff는 비어 있다.**
 * 그대로 두면 성공한 실행의 `diff.patch`가 빈 파일이 되어, 증거가 "아무것도 안 바꿨다"고
 * 거짓말을 한다. 최종 변경분은 워킹트리가 아니라 브랜치에서 나와야 한다.
 */
export async function branchDiff(cwd: string, worktree: Worktree): Promise<string> {
  const diff = await git(['diff', `${worktree.base}..${worktree.branch}`], cwd)
  return diff.code === 0 ? diff.out : ''
}

/** 브랜치에 쌓인 커밋 수. 사람에게 "가져갈 것이 있는가"를 한 숫자로 말한다 */
export async function commitCount(cwd: string, worktree: Worktree): Promise<number> {
  const log = await git(['rev-list', '--count', `${worktree.base}..${worktree.branch}`], cwd)
  return log.code === 0 ? Number(log.out.trim()) || 0 : 0
}

/**
 * 워크트리를 치운다. **브랜치는 지우지 않는다** — 그것이 결과물이다.
 *
 * 실패해도 던지지 않는다: 정리에 실패했다는 이유로 실행 판정을 뒤집는 것은 뒤바뀐 우선순위다.
 * 대신 무엇이 남았는지 돌려줘 호출자가 사람에게 말할 수 있게 한다.
 */
export async function removeWorktree(
  cwd: string,
  worktree: Worktree,
): Promise<{ removed: boolean; leftAt?: string }> {
  const rm = await git(['worktree', 'remove', '--force', worktree.path], cwd)
  if (rm.code === 0) {
    // mkdtemp가 만든 부모 디렉토리는 git이 모른다 — 우리가 만들었으니 우리가 치운다
    const parent = join(worktree.path, '..')
    try {
      if (existsSync(parent)) rmSync(parent, { recursive: true, force: true })
    } catch {
      /* 정리 실패는 판정에 영향을 주지 않는다 */
    }
    return { removed: true }
  }
  return { removed: false, leftAt: worktree.path }
}
