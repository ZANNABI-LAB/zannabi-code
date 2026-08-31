import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { fingerprint } from '@zannabi-lab/gateway-telegram'

const cliPath = join(import.meta.dir, '../src/index.ts')
const TOKEN = '123456:AAH-e2e-fake-token'
const CHAT = '4242'

function project(prefix: string) {
  return mkdtempSync(join(tmpdir(), `zannabi-${prefix}-`))
}

/**
 * 폴링 락을 미리 **살아 있는 프로세스 이름으로** 선점한다 — 시험 프로세스 자신이다.
 *
 * 이렇게 하면 CLI는 텔레그램에 접속하지 않고 폴백 경로로 간다. 네트워크 없이
 * **CLI가 승인 콜백을 실제로 텔레그램 쪽에 꽂았는지**만 관측할 수 있다.
 */
function holdLock(home: string) {
  const dir = join(home, '.zannabi', 'locks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `telegram-${fingerprint(TOKEN)}.lock`),
    JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() }),
  )
}

const telegramEnv = (home: string) => ({
  ...process.env,
  HOME: home,
  ZANNABI_ADAPTER: 'fake',
  ZANNABI_TELEGRAM_BOT_TOKEN: TOKEN,
  ZANNABI_TELEGRAM_CHAT_ID: CHAT,
})

test('E2E: --approve에 모르는 채널을 주면 세운다', async () => {
  const proc = Bun.spawn(['bun', cliPath, 'run', '작업', '--cwd', project('ch'), '--approve', 'carrier-pigeon'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(1)
  expect(await new Response(proc.stderr).text()).toContain('terminal | telegram')
})

test('★ E2E: 환경변수가 없으면 조용히 터미널로 내려가지 않고 세운다', async () => {
  const env: Record<string, string | undefined> = { ...process.env, ZANNABI_ADAPTER: 'fake' }
  delete env.ZANNABI_TELEGRAM_BOT_TOKEN
  delete env.ZANNABI_TELEGRAM_CHAT_ID
  const proc = Bun.spawn(['bun', cliPath, 'run', '작업', '--cwd', project('env'), '--approve', 'telegram'], {
    env,
    // 터미널로 내려갔다면 이 승인으로 실행이 진행돼 버린다 — 그것을 잡는 시험이다
    stdin: new Response('y\n').body!,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(1)
  const err = await new Response(proc.stderr).text()
  expect(err).toContain('ZANNABI_TELEGRAM_BOT_TOKEN')
  expect(err).toContain('ZANNABI_TELEGRAM_CHAT_ID')
  // 원격 승인을 지정한 사람은 자리를 뜰 참이다. 실행이 시작됐으면 안 된다
  expect(await new Response(proc.stdout).text()).not.toContain('success')
})

test('E2E: --yes와 --approve telegram은 함께 쓸 수 없다', async () => {
  const home = project('yes-home')
  const proc = Bun.spawn(
    ['bun', cliPath, 'run', '작업', '--cwd', project('yes'), '--approve', 'telegram', '--yes'],
    { env: telegramEnv(home), stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await proc.exited).toBe(1)
  expect(await new Response(proc.stderr).text()).toContain('함께 쓸 수 없습니다')
})

test('E2E: --approve-timeout이 정수가 아니면 세운다', async () => {
  const home = project('to-home')
  const proc = Bun.spawn(
    ['bun', cliPath, 'run', '작업', '--cwd', project('to'), '--approve', 'telegram', '--approve-timeout', 'soon'],
    { env: telegramEnv(home), stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await proc.exited).toBe(1)
  expect(await new Response(proc.stderr).text()).toContain('approve-timeout')
})

/**
 * ★ **이 시험이 이 파일의 이유다.**
 *
 * 게이트웨이 단위 시험은 `approveViaTelegram`을 자기가 만들어 부르므로 **CLI가 그것을
 * 승인 자리에 꽂지 않아도 통과한다.** 같은 층의 결함이 실제로 있었다 — `--no-exec-shell`이
 * race까지 전달되지 않았는데 race 시험 아홉이 전부 통과했다.
 */
test('★ E2E: run이 --approve telegram을 실제 승인 경로에 꽂는다 (락 선점 → 터미널 폴백)', async () => {
  const home = project('wire-home')
  holdLock(home)
  const proc = Bun.spawn(
    ['bun', cliPath, 'run', '작업', '--cwd', project('wire'), '--approve', 'telegram'],
    { env: telegramEnv(home), stdin: new Response('y\n').body!, stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()
  // 텔레그램 경로에 들어갔다는 증거 — 터미널 승인만 꽂혔다면 이 줄은 뜰 수 없다
  expect(out).toContain('승인을 텔레그램으로 묻습니다')
  expect(out).toContain('다른 실행이 쓰고 있습니다')
  // 그리고 폴백이 실제로 사람에게 물어 실행이 이어졌다
  expect(out).toContain('success')
  expect(exitCode).toBe(0)
})

test('★ E2E: race도 같은 승인 경로를 쓴다 — 조마다 묻지 않고 한 번만 묻는다', async () => {
  const home = project('race-home')
  holdLock(home)
  // race는 워크트리 격리가 전제라 git 저장소여야 한다
  const cwd = project('race')
  for (const args of [
    ['git', 'init', '-q', '-b', 'main', '.'],
    ['git', 'config', 'user.email', 'test@test'],
    ['git', 'config', 'user.name', 'test'],
    ['sh', '-c', 'echo base > base.txt'],
    ['git', 'add', '-A'],
    ['git', 'commit', '-qm', 'init'],
  ]) Bun.spawnSync(args, { cwd })

  const proc = Bun.spawn(
    ['bun', cliPath, 'race', '작업', '--cwd', cwd,
     '--arm', 'claude', '--arm', 'codex', '--gate', 'user:true', '--approve', 'telegram'],
    { env: telegramEnv(home), stdin: new Response('y\n').body!, stdout: 'pipe', stderr: 'pipe' },
  )
  const code = await proc.exited
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('승인을 텔레그램으로 묻습니다')
  // 계획은 한 번만 세우고 조가 공유하므로 승인도 한 번뿐이다 —
  // 조마다 묻는 도구는 원격 승인을 붙일 수 없다
  expect(out.match(/승인을 텔레그램으로 묻습니다/g)).toHaveLength(1)
  // 그리고 실제로 race가 돌았다 (조 2개의 집계가 나온다)
  expect(out).toContain('claude')
  expect(out).toContain('codex')
  expect(code).toBe(0)
}, 60_000)
