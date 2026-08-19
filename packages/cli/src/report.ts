import { mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoopResult } from '@zannabi-lab/core'

export function buildReport(result: LoopResult, intent: string): string {
  const lines = [
    `# zannabi run report`,
    ``,
    `- **intent**: ${intent}`,
    `- **status**: ${result.status}`,
    `- **attempts**: ${result.attempts}`,
  ]
  // 어떤 조합으로 돌았는지 — 조합별 비교의 기본 축
  if (result.runtime)
    lines.push(`- **runtime**: plan=\`${result.runtime.plan}\` exec=\`${result.runtime.exec}\``)
  // 실패 사유를 리포트에 싣는다 — transcript.jsonl을 파싱하지 않아도 원인이 보이게
  if (result.detail) lines.push(`- **detail**: ${result.detail}`)
  lines.push(``, `## Gates (최종 라운드)`, ``)
  const last = result.evidence.at(-1) ?? []
  for (const e of last) {
    const mark = e.outcome === 'pass' ? '✅' : e.outcome === 'fail' ? '❌' : '⚠️'
    lines.push(`- ${mark} \`${e.gate}\` (\`${e.cmd}\`) → exit ${e.exitCode}, ${e.durationMs}ms`)
  }
  return lines.join('\n')
}

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
