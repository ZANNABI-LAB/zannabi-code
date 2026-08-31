import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns } from '@zannabi-lab/core'

const CLI = join(import.meta.dir, '..', 'src', 'index.ts')

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zannabi-cli-wt-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.name', 'test'], { cwd: dir })
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
  Bun.spawnSync(['git', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

async function cli(cwd: string, args: string[]) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args, '--cwd', cwd], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out, err }
}

function git(args: string[], cwd: string): string {
  return Bun.spawnSync(['git', ...args], { cwd }).stdout.toString().trim()
}

test('--worktree는 전용 워크트리에서 돌고 원본 워킹트리를 건드리지 않는다', async () => {
  const cwd = repo()
  writeFileSync(join(cwd, 'mywork.txt'), '사람이 편집 중\n')

  // 게이트가 워크트리 안에서 파일을 만든다 — 그 파일이 어디에 생기는지가 격리의 증거다
  const run = await cli(cwd, [
    'run', '격리 실행', '--yes', '--worktree',
    '--gate', 'make:touch gate-made.txt',
  ])
  expect(run.code).toBe(0)
  expect(run.out).toContain('워크트리:')
  expect(run.out).toContain('미커밋 변경 1건')

  // 원본에는 게이트가 만든 파일이 없고, 사람의 작업은 그대로다
  expect(existsSync(join(cwd, 'gate-made.txt'))).toBe(false)
  expect(readFileSync(join(cwd, 'mywork.txt'), 'utf-8')).toBe('사람이 편집 중\n')

  // 결과는 브랜치로 남는다
  const runId = listRuns(cwd)[0]
  const branch = `zannabi/${runId}`
  expect(git(['rev-parse', '--verify', branch], cwd)).not.toBe('')
  expect(run.out).toContain(`git merge ${branch}`)
  // 브랜치에는 게이트가 만든 파일이 들어 있다
  expect(git(['show', `${branch}:gate-made.txt`], cwd)).toBe('')
  expect(git(['log', '--oneline', `main..${branch}`], cwd)).toContain('zannabi: round 1')

  // 워크트리는 치워졌다 — 브랜치만 남는다
  expect(git(['worktree', 'list'], cwd).split('\n').filter(Boolean)).toHaveLength(1)
}, 30_000)

test('워크트리 실행의 diff.patch는 비어 있지 않다', async () => {
  // 라운드마다 커밋하므로 끝난 시점의 워킹트리는 깨끗하다.
  // 그때 워킹트리 diff를 쓰면 증거가 "아무것도 안 바꿨다"고 거짓말을 한다
  const cwd = repo()
  await cli(cwd, ['run', '패치 확인', '--yes', '--worktree', '--gate', 'make:touch made.txt'])

  const runId = listRuns(cwd)[0]
  const patch = readFileSync(join(cwd, '.zannabi', 'runs', runId, 'diff.patch'), 'utf-8')
  expect(patch).toContain('made.txt')
}, 30_000)

test('git 저장소가 아니면 --worktree를 실행 전에 거부한다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-cli-nogit-'))
  const run = await cli(cwd, ['run', '거부될 실행', '--yes', '--worktree'])

  expect(run.code).toBe(1)
  expect(run.err).toContain('git 저장소가 아닙니다')
  // 계획 턴도 돌지 않았다 — 실패를 알면서 돈을 쓰지 않는다
  expect(listRuns(cwd)).toHaveLength(0)
}, 30_000)

test('실행 턴이 실패해도 에이전트가 쓴 것은 브랜치에 건져진다', async () => {
  // **데이터 손실 회귀 방지.** 라운드 커밋은 라운드가 완성돼야 도는데, 실행 턴이 실패하면
  // 루프가 라운드를 만들지 않고 끝나 커밋이 한 번도 일어나지 않았다. 그 상태로 워크트리를
  // 지우면서 에이전트가 쓴 파일이 통째로 사라졌고, 화면에는 "바뀐 파일이 없었습니다"가 떴다.
  // worktree.ts 첫머리가 "실패로 끝난 실행의 작업물도 사라지면 안 된다"고 적어 놓은 그 자리다
  const cwd = repo()
  const proc = Bun.spawn(
    ['bun', 'run', CLI, 'run', '실행 실패', '--yes', '--worktree', '--gate', 'user:true', '--cwd', cwd],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake-exec-error' }, stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('agent-error')
  expect(out).toContain('브랜치에 건졌습니다')
  // 화면이 "바뀐 파일이 없었습니다"라고 말해서는 안 된다 — 실제로 있었다
  expect(out).not.toContain('바뀐 파일이 없었습니다')

  // 실물 확인: 에이전트가 쓴 파일이 브랜치에 살아 있다
  const runId = listRuns(cwd)[0]
  const branch = `zannabi/${runId}`
  expect(git(['show', `${branch}:agent-wrote.txt`], cwd)).toBe('에이전트가 쓴 것')
})
