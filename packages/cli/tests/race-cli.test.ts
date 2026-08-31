/**
 * **CLI 경로의 race.** 다른 race 시험 아홉은 전부 `runRace()`를 직접 부른다 —
 * 인자를 자기가 만들어 넘기므로 **CLI의 인자 구성이 틀려도 통과한다.**
 *
 * 실제로 그런 결함이 있었다: `--no-exec-shell`이 race에서만 조용히 무시됐는데, 원인은
 * `execShell` 선언이 race 호출보다 **뒤에 있어 넘길 수조차 없던 것**이었다. 그 층을
 * 보는 시험이 없어서 실전에서야 드러났고, 실전에서도 그 플래그를 안 써서 또 못 봤다.
 *
 * 여기서는 어댑터가 **실제로 받은 요청**을 추적 파일로 받아 대조한다.
 */
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'src', 'index.ts')

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zannabi-race-cli-'))
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test'], { cwd: dir })
  Bun.spawnSync(['git', 'config', 'user.name', 'test'], { cwd: dir })
  Bun.spawnSync(['sh', '-c', 'echo base > base.txt'], { cwd: dir })
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
  Bun.spawnSync(['git', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

/** race를 CLI로 돌리고, 어댑터가 실제로 받은 요청들을 돌려준다 */
async function raceWithTrace(extraArgs: string[]) {
  const cwd = repo()
  const trace = join(cwd, 'trace.jsonl')
  const proc = Bun.spawn(
    ['bun', CLI, 'race', '확인', '--arm', 'claude', '--arm', 'codex',
     '--gate', 'user:true', ...extraArgs, '--yes', '--cwd', cwd],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake', ZANNABI_FAKE_TRACE: trace },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  const requests = existsSync(trace)
    ? readFileSync(trace, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : []
  return { code, out, requests, cwd }
}

test('CLI의 race가 실행 턴에 게이트 명령을 연다', async () => {
  const { code, requests } = await raceWithTrace([])
  expect(code).toBe(0)
  // 계획 1회 + 조 2개의 실행 턴 = 3건 이상
  expect(requests.length).toBeGreaterThanOrEqual(3)
  const opened = requests.filter(r => r.allowedCommands !== null)
  expect(opened.length).toBeGreaterThanOrEqual(2)
}, 60_000)

test('CLI의 race가 --no-exec-shell을 조까지 넘긴다', async () => {
  // **회귀 방지**: 이 플래그가 race에서만 무시됐다. 단위 시험은 `runRace`에 execShell을
  // 직접 넘겨 확인하므로, CLI가 그것을 구성하지 못하는 결함을 원리적으로 못 잡는다
  const { code, requests } = await raceWithTrace(['--no-exec-shell'])
  expect(code).toBe(0)
  expect(requests.length).toBeGreaterThanOrEqual(3)
  // 어느 턴에도 명령이 열려서는 안 된다
  expect(requests.every(r => r.allowedCommands === null)).toBe(true)
}, 60_000)

test('CLI의 race가 조마다 다른 워크트리를 준다 — 격리 없이는 비교가 성립하지 않는다', async () => {
  // 조들이 워킹트리를 공유하면 서로의 변경을 자기 것으로 본다. 그 순간 판정이 틀리는 것을
  // 넘어 **증거가 거짓이 된다.** cwd 는 어댑터가 받는 값이라 여기서만 실물로 확인된다
  const { requests, cwd } = await raceWithTrace([])
  const execCwds = new Set(requests.map(r => r.cwd))
  // 계획 턴은 원본에서, 조들은 각자의 워크트리에서 돈다 → 서로 다른 경로가 셋
  expect(execCwds.size).toBeGreaterThanOrEqual(3)
  // 조의 작업 자리는 원본 저장소 밖이어야 한다
  const outside = [...execCwds].filter(c => !c.startsWith(cwd))
  expect(outside.length).toBeGreaterThanOrEqual(2)
}, 60_000)
