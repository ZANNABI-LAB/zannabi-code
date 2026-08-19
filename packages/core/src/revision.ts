/**
 * 워킹트리 스냅샷. 증거를 "언제/무엇 위에서" 찍었는지에 결박하는 재료다(설계 §5).
 *
 * git이 없거나 저장소가 아니면 조용히 비활성 상태를 돌려준다 — 리비전은 부가 증거이지
 * 루프의 전제 조건이 아니다. 대신 그 사실을 `tracked: false`로 명시해,
 * 이 축에 의존하는 판정(no-progress)이 근거 없이 돌지 않게 한다.
 */
import { mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Revision } from './goal'

async function git(
  args: string[],
  cwd: string,
  indexFile?: string,
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
    env: indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env,
  })
  const out = await new Response(proc.stdout).text()
  return { code: await proc.exited, out }
}

/**
 * 저장소 전체를 대상으로 하되 `.zannabi/`는 뺀다.
 * 미추적 파일을 담기 시작하면 증거 디렉토리 자신이 증거에 섞여 들어가기 때문이다.
 */
const PATHSPEC = [':/', ':(exclude,top).zannabi']

/**
 * 신규(미추적) 파일까지 포함한 변경분.
 *
 * `git add -A -N`이 필요하지만 대상 저장소의 인덱스를 러너가 바꾸면 안 되므로
 * 실제 인덱스를 임시 파일로 복사해 GIT_INDEX_FILE로 가리킨다. 사용자의 스테이징 상태는 무손상.
 */
export async function captureDiff(cwd: string): Promise<string> {
  let tmp: string | undefined
  try {
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'], cwd)).out.trim()
    if (!gitDir) return ''

    tmp = mkdtempSync(join(tmpdir(), 'zannabi-index-'))
    const scratchIndex = join(tmp, 'index')
    const realIndex = join(gitDir, 'index')
    if (existsSync(realIndex)) copyFileSync(realIndex, scratchIndex)

    // 복사에 실패했거나 인덱스가 없으면 미추적 파일 포함을 포기하고 기존 동작으로 되돌린다
    if (!existsSync(scratchIndex)) {
      const plain = await git(['diff', 'HEAD', '--', ...PATHSPEC], cwd)
      return plain.code === 0 ? plain.out : ''
    }

    await git(['add', '-A', '-N', '--', ...PATHSPEC], cwd, scratchIndex)
    const diff = await git(['diff', 'HEAD', '--', ...PATHSPEC], cwd, scratchIndex)
    return diff.code === 0 ? diff.out : ''
  } catch {
    return '' // git 없음/저장소 아님 — diff는 부가 증거라 조용히 스킵
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 16)
}

/** 리비전을 못 읽는 상태. 이 값이면 diff 축에 기대는 판정은 스스로를 끈다 */
export const UNTRACKED_REVISION: Revision = { tracked: false, head: null, diffHash: null }

/**
 * 지금 이 순간의 워킹트리 상태.
 *
 * HEAD와 변경분 해시를 함께 둔다 — 해시만으로는 "무엇 위의 변경분인지"를 못 밝히고,
 * HEAD만으로는 커밋되지 않은 작업이 안 잡히기 때문이다. 둘이 한 쌍이라야 재현 가능하다.
 */
export async function captureRevision(cwd: string): Promise<Revision & { diff: string }> {
  let head: string | null = null
  try {
    const rev = await git(['rev-parse', 'HEAD'], cwd)
    head = rev.code === 0 && rev.out.trim() ? rev.out.trim() : null
  } catch {
    head = null
  }
  const diff = await captureDiff(cwd)
  // HEAD도 diff도 못 얻었다면 git이 없거나 저장소가 아니다.
  // 커밋 없는 새 저장소는 HEAD가 없어도 diff는 나오므로 여기서 걸리지 않는다.
  if (head === null && diff === '') {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd).catch(() => ({
      code: 1,
      out: '',
    }))
    if (inside.code !== 0 || inside.out.trim() !== 'true')
      return { ...UNTRACKED_REVISION, diff: '' }
  }
  return { tracked: true, head, diffHash: hashDiff(diff), diff }
}
