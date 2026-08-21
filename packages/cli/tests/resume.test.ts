import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns, resolveRun, readJournal, replay, JOURNAL_FILENAME } from '@zannabi-lab/core'

const CLI = join(import.meta.dir, '..', 'src', 'index.ts')

function spawnRun(cwd: string, args: string[]) {
  return Bun.spawn(['bun', 'run', CLI, ...args, '--cwd', cwd], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function output(proc: ReturnType<typeof spawnRun>) {
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out, err }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 진짜 kill -9로 죽인 실행을 이어서 돌린다.
 *
 * 저널을 손으로 자르는 테스트(replay.test.ts)와 따로 두는 이유: 잘라 만든 파일은
 * **우리가 상상한 중단 지점**이고, 실제로 죽은 프로세스가 남기는 것은 다를 수 있다.
 * Phase 5의 완료 기준이 "kill -9 후 재개"라면 그것을 그대로 해 봐야 한다.
 */
test('kill -9로 죽인 실행을 이어서 돌면 성공으로 끝난다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-kill9-'))
  // 게이트를 돌리는 도중에 죽이려면 게이트가 충분히 느려야 한다
  const proc = spawnRun(cwd, ['run', '죽었다 살아나기', '--yes', '--gate', 'slow:sleep 5'])
  await sleep(2500)
  proc.kill(9)
  await proc.exited

  const runId = listRuns(cwd)[0]
  expect(runId).toBeDefined()

  // 1) 죽은 직후: 상태가 재구성되고, 중단된 라운드는 완료로 세지 않는다
  const dead = replay(readJournal(join(cwd, '.zannabi', 'runs', runId)))
  expect(dead.phase).toBe('interrupted')
  expect(dead.rounds).toHaveLength(0)
  expect(dead.partialRound).toBe(1)

  // 2) 이어서 돌린다
  const resumed = await output(spawnRun(cwd, ['resume', runId]))
  expect(resumed.code).toBe(0)
  expect(resumed.out).toContain('재개')

  // 3) 같은 실행 디렉토리에 이어졌고, 성공으로 끝났다
  expect(listRuns(cwd)).toHaveLength(1)
  const after = replay(readJournal(join(cwd, '.zannabi', 'runs', runId)))
  expect(after.phase).toBe('finished')
  expect(after.status).toBe('success')
  expect(after.resumeCount).toBe(1)

  // 4) 계획과 승인은 다시 묻지 않았다 — 재개의 정의가 이것이다
  const events = readJournal(join(cwd, '.zannabi', 'runs', runId))
  const afterResume = events.slice(events.findIndex(e => e.type === 'run-resumed'))
  expect(afterResume.some(e => e.type === 'plan-finished')).toBe(false)
  expect(afterResume.some(e => e.type === 'approval-requested')).toBe(false)
}, 60_000)

test('끝난 실행은 이어서 돌 수 없고, 그 이유를 말한다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-resume-done-'))
  await output(spawnRun(cwd, ['run', '이미 끝남', '--yes']))
  const runId = listRuns(cwd)[0]

  const again = await output(spawnRun(cwd, ['resume', runId]))
  expect(again.code).toBe(1)
  expect(again.err).toContain('이미 success로 끝난 실행입니다')
  // 새 실행 디렉토리를 만들지 않는다 — 거부는 거부여야 한다
  expect(listRuns(cwd)).toHaveLength(1)
}, 30_000)

test('승인 전에 죽은 실행은 이어받지 않는다 — 이어받을 완료 기준이 없다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-resume-noapprove-'))
  // --yes를 주지 않으면 승인 프롬프트에서 멈춘다. 그 상태로 죽인다
  const proc = spawnRun(cwd, ['run', '승인 전 사망'])
  await sleep(2000)
  proc.kill(9)
  await proc.exited

  const runId = listRuns(cwd)[0]
  const state = replay(readJournal(join(cwd, '.zannabi', 'runs', runId)))
  expect(state.phase).toBe('awaiting-approval')

  const resumed = await output(spawnRun(cwd, ['resume', runId]))
  expect(resumed.code).toBe(1)
  expect(resumed.err).toContain('승인 전에 중단된 실행입니다')
}, 30_000)

test('plan.md가 없으면 이어갈 수 없다고 말한다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-resume-noplan-'))
  const proc = spawnRun(cwd, ['run', '계획 유실', '--yes', '--gate', 'slow:sleep 5'])
  await sleep(2500)
  proc.kill(9)
  await proc.exited

  const found = resolveRun(cwd)
  if (!found.ok) throw new Error('run not found')
  expect(existsSync(join(found.dir, 'plan.md'))).toBe(true)
  await Bun.write(join(found.dir, 'plan.md.bak'), readFileSync(join(found.dir, 'plan.md')))
  await Bun.$`rm ${join(found.dir, 'plan.md')}`.quiet()

  const resumed = await output(spawnRun(cwd, ['resume', found.runId]))
  expect(resumed.code).toBe(1)
  expect(resumed.err).toContain('plan.md가 없습니다')
}, 60_000)

test('이월된 지출은 재개 후에도 상한이 같은 총액을 본다', async () => {
  // fake 어댑터는 비용을 보고하지 않으므로 여기서는 저널의 이월 자체를 본다:
  // 재생한 usage가 재개 실행의 출발점이 되는지
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-resume-cost-'))
  const proc = spawnRun(cwd, ['run', '비용 이월', '--yes', '--gate', 'slow:sleep 5'])
  await sleep(2500)
  proc.kill(9)
  await proc.exited

  const found = resolveRun(cwd)
  if (!found.ok) throw new Error('run not found')
  const before = replay(readJournal(found.dir))
  await output(spawnRun(cwd, ['resume', found.runId]))
  const after = replay(readJournal(found.dir))

  // 재개가 usage를 0에서 다시 세지 않는다 — 턴 수가 줄어들면 안 된다
  expect(after.usage.plan.turns).toBeGreaterThanOrEqual(before.usage.plan.turns)
  const journal = readFileSync(join(found.dir, JOURNAL_FILENAME), 'utf-8')
  expect(journal.split('\n').filter(Boolean).length).toBeGreaterThan(8)
}, 60_000)
