/**
 * CLI 시험이 공유하는 준비물.
 *
 * `repo()`가 네 파일에, `git()`이 두 파일에, CLI를 띄우는 헬퍼가 두 파일에 같은 모양으로
 * 있었다. 시험 준비물이 갈리면 **같은 것을 지키는 척하면서 다른 조건을 재게 된다** —
 * 실제로 한쪽 `repo()`는 `writeFileSync`로, 다른 쪽은 `sh -c echo`로 같은 파일을 만들고 있었다.
 *
 * 파일 이름이 `.test.ts`가 아니므로 러너가 시험으로 잡지 않는다.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CLI = join(import.meta.dir, '..', 'src', 'index.ts')

/** 커밋 하나가 든 git 저장소. 워크트리·race는 git 없이는 성립하지 않는다 */
export function repo(prefix = 'cli'): string {
  const dir = mkdtempSync(join(tmpdir(), `zannabi-${prefix}-`))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.name', 'test'], { cwd: dir })
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
  Bun.spawnSync(['git', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

/** git 한 줄. 출력만 필요할 때 쓴다 */
export function git(args: string[], cwd: string): string {
  return Bun.spawnSync(['git', ...args], { cwd }).stdout.toString().trim()
}

export interface CliRun {
  code: number
  out: string
  err: string
}

/**
 * CLI를 fake 어댑터로 띄우고 종료코드와 출력을 받는다.
 *
 * `--cwd`를 여기서 붙이지 않는다 — `status`처럼 대상 없이 도는 명령이 있고,
 * 붙이는 쪽을 헬퍼가 정하면 그 명령들이 이 헬퍼를 못 쓴다.
 */
export async function cli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out, err }
}
