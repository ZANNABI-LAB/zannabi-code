import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop, type LoopOptions } from '../src/loop'
import { RunStore } from '../src/store'
import { FakeAdapter, fakeResult } from '../src/testing'
import {
  createWorktree,
  removeWorktree,
  commitRound,
  commitCount,
  branchDiff,
  worktreeUsable,
  WorktreeError,
} from '../src/worktree'

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

/** 커밋 하나가 있는 저장소를 만든다 */
function repo(prefix = 'zannabi-wt-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.name', 'test'], { cwd: dir })
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
  Bun.spawnSync(['git', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const planText = (cmd: string) =>
  `계획: 한다.\n\`\`\`json\n{"gates":[{"name":"g","cmd":"${cmd}"}]}\n\`\`\``

test('워크트리는 원본의 미커밋 작업을 딸고 가지 않고, 그 사실을 세어 둔다', async () => {
  const cwd = repo()
  writeFileSync(join(cwd, 'mywork.txt'), '사람이 편집 중\n')

  const wt = await createWorktree(cwd, 'run-1')
  expect(wt.branch).toBe('zannabi/run-1')
  // 원본에 남아 있던 작업은 HEAD 기준으로 갈라진 워크트리에 없다. 그 사실을 알려야
  // 사용자가 "왜 내 수정이 반영 안 됐지"를 겪지 않는다
  expect(wt.uncommittedInOrigin).toBe(1)
  expect(existsSync(join(wt.path, 'base.txt'))).toBe(true)
  expect(existsSync(join(wt.path, 'mywork.txt'))).toBe(false)

  await removeWorktree(cwd, wt)
  // 원본 워킹트리는 무손상이다 — 러너가 사람의 작업을 건드리지 않는다는 것이 이 기능의 전부다
  expect(readFileSync(join(cwd, 'mywork.txt'), 'utf-8')).toBe('사람이 편집 중\n')
})

test('라운드마다 커밋되고, 브랜치는 워크트리를 치운 뒤에도 남는다', async () => {
  const cwd = repo()
  const wt = await createWorktree(cwd, 'run-2')

  writeFileSync(join(wt.path, 'a.txt'), '1라운드\n')
  const first = await commitRound(wt.path, 1, '게이트 0/1 통과')
  expect(first.committed).toBe(true)

  // 바뀐 것이 없으면 빈 커밋을 만들지 않는다 — 없는 진전을 이력으로 지어내지 않는다
  const empty = await commitRound(wt.path, 2, '변화 없음')
  expect(empty.committed).toBe(false)

  writeFileSync(join(wt.path, 'a.txt'), '2라운드\n')
  expect((await commitRound(wt.path, 3, '게이트 1/1 통과')).committed).toBe(true)

  expect(await commitCount(cwd, wt)).toBe(2)
  const diff = await branchDiff(cwd, wt)
  expect(diff).toContain('a.txt')
  expect(diff).toContain('2라운드')

  await removeWorktree(cwd, wt)
  expect(existsSync(wt.path)).toBe(false)
  // 브랜치는 결과물이므로 남는다. 실패한 실행의 것도 지우지 않는다
  expect(await git(['rev-parse', '--verify', wt.branch], cwd)).not.toBe('')
})

test('실행이 워크트리 안에서만 파일을 바꾼다', async () => {
  const cwd = repo()
  const wt = await createWorktree(cwd, 'run-3')

  // 에이전트가 작업하는 시늉 — cwd로 받은 자리에 파일을 쓴다
  const adapter = new FakeAdapter(
    [fakeResult(planText('test -f made.txt')), fakeResult('만들었음')],
    (req, i) => {
      if (i === 1) writeFileSync(join(req.cwd, 'made.txt'), 'agent\n')
    },
  )
  const opts: LoopOptions = {
    intent: '워크트리에서 작업',
    userGates: [],
    budget: 2,
    adapter,
    cwd: wt.path, // ← 격리의 전부: 루프에 다른 cwd를 준다
    store: new RunStore(cwd, '워크트리에서 작업'), // 증거는 원본에 남는다
    approve: async () => ({ action: 'approve' }),
    log: () => {},
    afterRound: async round => {
      await commitRound(wt.path, round.round, 'x')
    },
  }
  const result = await runLoop(opts)

  expect(result.status).toBe('success')
  expect(existsSync(join(wt.path, 'made.txt'))).toBe(true)
  // 원본은 건드려지지 않았다
  expect(existsSync(join(cwd, 'made.txt'))).toBe(false)
  // 증거는 원본 저장소에 남는다 — 실행의 기록은 워크트리보다 오래 산다
  expect(existsSync(join(opts.store.dir, 'journal.jsonl'))).toBe(true)
  expect(await commitCount(cwd, wt)).toBe(1)

  await removeWorktree(cwd, wt)
})

test('같은 저장소에서 두 실행이 동시에 돌아도 증거가 섞이지 않는다', async () => {
  // Phase 6의 완료 기준 그 자체
  const cwd = repo()
  const [wtA, wtB] = await Promise.all([createWorktree(cwd, 'run-A'), createWorktree(cwd, 'run-B')])

  function job(wt: { path: string }, mark: string) {
    const adapter = new FakeAdapter(
      [fakeResult(planText(`test -f ${mark}.txt`)), fakeResult('했음')],
      (req, i) => {
        if (i === 1) writeFileSync(join(req.cwd, `${mark}.txt`), `${mark}\n`)
      },
    )
    return runLoop({
      intent: `동시 실행 ${mark}`,
      userGates: [],
      budget: 2,
      adapter,
      cwd: wt.path,
      store: new RunStore(cwd, `동시-${mark}`),
      approve: async () => ({ action: 'approve' }),
      log: () => {},
      afterRound: async round => {
        await commitRound(wt.path, round.round, mark)
      },
    })
  }

  const [a, b] = await Promise.all([job(wtA, 'alpha'), job(wtB, 'beta')])
  expect(a.status).toBe('success')
  expect(b.status).toBe('success')

  // 각자 자기 것만 본다. 공유 워킹트리였다면 서로의 파일이 자기 diff에 섞였을 것이다
  expect(existsSync(join(wtA.path, 'alpha.txt'))).toBe(true)
  expect(existsSync(join(wtA.path, 'beta.txt'))).toBe(false)
  expect(existsSync(join(wtB.path, 'beta.txt'))).toBe(true)
  expect(existsSync(join(wtB.path, 'alpha.txt'))).toBe(false)

  // 리비전 결박도 갈린다 — 같은 diffHash가 나오면 증거가 서로를 오염시킨 것이다
  expect(a.rounds[0].revision.diffHash).not.toBe(b.rounds[0].revision.diffHash)

  const diffA = await branchDiff(cwd, wtA)
  expect(diffA).toContain('alpha.txt')
  expect(diffA).not.toContain('beta.txt')

  await Promise.all([removeWorktree(cwd, wtA), removeWorktree(cwd, wtB)])
})

test('커밋이 없는 저장소에는 워크트리를 만들지 않고 이유를 말한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zannabi-wt-empty-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })

  const usable = await worktreeUsable(dir)
  expect(usable.ok).toBe(false)
  if (!usable.ok) expect(usable.reason).toContain('커밋이 하나도 없는')

  // 게이트를 다 돌고 나서 "사실 격리가 안 됐습니다"를 알리는 것이 최악이다
  expect(createWorktree(dir, 'run-x')).rejects.toThrow(WorktreeError)
})

test('git 저장소가 아니면 거부한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zannabi-wt-nogit-'))
  const usable = await worktreeUsable(dir)
  expect(usable.ok).toBe(false)
  if (!usable.ok) expect(usable.reason).toContain('git 저장소가 아닙니다')
})
