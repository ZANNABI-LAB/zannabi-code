import { test, expect } from 'bun:test'
import { mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI } from './_fixture'

test('E2E: fake 어댑터로 전체 루프 — 승인 → 실행 → 검증 → 증거', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdin: new Response('y\n').body!, // 승인
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(exitCode).toBe(0)
  expect(out).toContain('success')
  const runs = readdirSync(join(project, '.zannabi', 'runs'))
  expect(runs).toHaveLength(1)
  const runDir = join(project, '.zannabi', 'runs', runs[0])
  expect(existsSync(join(runDir, 'plan.md'))).toBe(true)
  expect(existsSync(join(runDir, 'evidence.json'))).toBe(true)
  expect(existsSync(join(runDir, 'report.md'))).toBe(true)
})

test('E2E: 승인 거부 → 종료 코드 1, 실행 없음', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-abort-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdin: new Response('n\n').body!,
      stdout: 'pipe',
    },
  )
  expect(await proc.exited).toBe(1)
})

test('E2E: --budget이 정수가 아니면 → 종료 코드 1, 안내 메시지', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-budget-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--budget', 'abc'],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('--budget')
})

test('E2E: --gate 형식이 잘못되면 → 종료 코드 1, 안내 메시지', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-gate-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'badformat'],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('--gate')
})

/**
 * `--yes`는 stdin 없이 통과한다. **사용자 게이트를 주므로 제안 게이트가 섞여도 진행한다** —
 * 막는 것은 완료 기준 **전체**가 제안일 때뿐이고, 그쪽은 아래 전용 시험이 본다.
 * (제안 게이트가 섞이는 것 자체는 값을 냈다: 실측에서 계획 에이전트가 산문 제약을 게이트로 바꿔 붙였다)
 */
test('E2E: --yes → stdin 없이 승인 통과', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-yes-'))
  const proc = Bun.spawn(['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdin: 'ignore', // 파이프로 y를 밀어넣지 않아도 진행되어야 한다
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(exitCode).toBe(0)
  expect(out).toContain('success')
})

test('E2E: --yes는 실행 불가한 게이트를 거부한다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-yes-bad-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes',
     '--gate', 'broken:definitely-not-a-command-xyz'],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('aborted')
  expect(out).toContain('definitely-not-a-command-xyz') // 어느 게이트 때문인지 보인다
})

test('E2E: --agent 값이 잘못되면 → 종료 코드 1, 안내 메시지', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-agent-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--agent', 'gpt'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('--agent')
})

test('E2E: --exec-agent 값이 잘못되면 그 플래그를 짚어준다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-exec-agent-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--exec-agent', 'gpt'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('--exec-agent')
})

test('E2E: 분리 실행이면 runtime 표기가 report.md에 남는다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-runtime-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes',
     '--plan-agent', 'claude', '--exec-agent', 'codex'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('plan=`claude:default`')
  expect(out).toContain('exec=`codex:default`')
})

test('E2E: .zannabi.json의 게이트와 예산이 적용된다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-config-'))
  writeFileSync(
    join(project, '.zannabi.json'),
    JSON.stringify({ gates: [{ name: 'always', cmd: 'true' }], budget: 1 }),
  )
  const proc = Bun.spawn(['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(exitCode).toBe(0)
  expect(out).toContain('.zannabi.json')
  expect(out).toContain('always') // 설정 파일 게이트가 실제로 걸렸다
  expect(out).toContain('사용자') // 설정 파일 게이트는 사용자 게이트로 집계된다
})

test('E2E: 설정 파일이 깨졌으면 조용히 무시하지 않고 세운다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-badconfig-'))
  writeFileSync(join(project, '.zannabi.json'), '{ broken')
  const proc = Bun.spawn(['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('JSON 파싱 실패')
})

test('E2E: 플래그가 설정 파일을 이긴다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-override-'))
  writeFileSync(join(project, '.zannabi.json'), JSON.stringify({ planModel: 'from-config' }))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes', '--plan-model', 'from-flag'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('plan=`claude:from-flag`')
})

test('E2E: --profile cheap은 실행 턴만 낮추고 계획 턴은 건드리지 않는다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-profile-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes', '--profile', 'cheap'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('프리셋 cheap')
  expect(out).toContain('exec=`claude:claude-haiku-4-5`')
  expect(out).toContain('plan=`claude:default`') // 계획은 사용자 기본값 그대로
})

test('E2E: 개별 플래그가 프리셋을 이긴다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-profile-override-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes',
     '--profile', 'cheap', '--exec-agent', 'codex'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()

  // 프리셋은 기본값 묶음이므로 명시한 항목만 갈아끼워진다 — 모델은 프리셋 값이 남는다
  expect(out).toContain('exec=`codex:claude-haiku-4-5`')
})

test('E2E: 설정 파일의 개별 항목이 프리셋을 이긴다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-profile-config-'))
  writeFileSync(
    join(project, '.zannabi.json'),
    JSON.stringify({ profile: 'cheap', execModel: 'from-config' }),
  )
  const proc = Bun.spawn(['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('프리셋 cheap') // 설정 파일로도 프리셋을 걸 수 있다
  expect(out).toContain('exec=`claude:from-config`')
})

test('E2E: 모르는 프리셋 이름은 고를 수 있는 것을 알려준다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-profile-bad-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes', '--profile', 'turbo'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('cheap | balanced | safe')
})

test('E2E: --profile safe는 런타임을 낮추지 않고 재확인을 켠다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-profile-safe-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes', '--profile', 'safe'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('plan=`claude:default` exec=`claude:default`')
  expect(out).toContain('통과 재확인 중 (총 2회)')
  const runs = readdirSync(join(project, '.zannabi', 'runs'))
  const goal = JSON.parse(
    readFileSync(join(project, '.zannabi', 'runs', runs[0], 'goal.json'), 'utf-8'),
  )
  expect(goal.loop.profile).toBe('safe') // 어떤 프리셋으로 돌았는지가 증거에 남는다
})

test('E2E: --yes는 조언성 경고로는 멈추지 않는다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-advisory-'))
  // fake 계획은 `ok: true`를 제안한다. 같은 이름에 다른 명령을 사용자 게이트로 주면
  // 제안이 밀리고 조언 경고가 뜬다 — 실행을 막을 일은 아니다
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes',
     '--gate', 'ok:printf done'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('같은 이름의 사용자 게이트') // 경고는 보인다
  expect(exitCode).toBe(0) // 그래도 진행한다
  expect(out).toContain('success')
})

test('E2E: --yes는 실행 불가한 게이트에는 여전히 멈춘다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-blocking-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes',
     '--gate', 'broken:definitely-not-a-command-xyz', '--verify-repeat', '2'],
    { env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())

  expect(exitCode).toBe(1)
  expect(out).toContain('aborted')
})

test('E2E: 실행 중 .zannabi.json이 바뀌면 리포트와 stderr가 그것을 세운다', async () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-config-'))
  // 게이트가 자기 설정 파일을 지우는 상황을 만든다 — 실전에서는 에이전트가 그렇게 했다
  writeFileSync(
    join(project, '.zannabi.json'),
    JSON.stringify({
      gates: [{ name: 'recovery', cmd: `printf '%s' '{"gates":[]}' > .zannabi.json` }],
    }),
  )
  const proc = Bun.spawn(['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'user:true', '--yes'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()

  // 이번 판정은 시작 시 읽은 설정으로 했으므로 유효하다 — 문제는 다음 실행이다
  expect(exitCode).toBe(0)
  expect(out).toContain('실행 중 .zannabi.json이 바뀌었다')
  expect(out).toContain('게이트 `recovery`가 사라졌다')
  expect(err).toContain('다음 실행부터는 완료 기준이 약해집니다')
})


test('--yes: 완료 기준이 전부 에이전트 제안이면 실행을 거부한다', async () => {
  // **실증된 거짓 초록의 회귀 방지.** 계획 에이전트가 게이트로 `true`를 제안하면
  // 사전점검은 통과시키고(그 명령은 실재한다) 러너는 그것을 돌려 exit 0을 받는다.
  // 코드를 한 줄도 안 쓴 실행이 success로 끝났다.
  //
  // 판정이 러너 밖 종료코드라는 주장은, 그 종료코드를 낼 명령을 누가 골랐는지까지
  // 말해야 성립한다. 사람이 보는 실행에서는 승인 화면이 막고, --yes에서는 이것이 막는다
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-suggested-only-'))
  const proc = Bun.spawn(['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--yes'], {
    env: { ...process.env, ZANNABI_ADAPTER: 'fake' }, stdout: 'pipe', stderr: 'pipe',
  })
  await proc.exited
  const out = await new Response(proc.stdout).text()

  expect(out).toContain('aborted')
  expect(out).toContain('사용자 게이트 없이는 진행하지 않습니다')
  // 게이트를 한 번도 돌리지 않았어야 한다 — 거부는 실행 전에 난다
  expect(out).not.toContain('status**: success')
})

test('승인 화면이 게이트 출처를 보인다 — 판단이 필요한 유일한 순간이다', async () => {
  // **실측 지적**: 리포트와 status 는 출처를 찍는데 승인 화면에는 없었다. 그런데 사용자가
  // "이 게이트를 내가 정했나, 에이전트가 제안했나"를 판단하는 순간이 바로 여기다.
  // fake 어댑터의 계획이 게이트 하나를 제안하므로, 사용자 게이트와 섞여 나온다
  const project = mkdtempSync(join(tmpdir(), 'zannabi-e2e-source-'))
  const proc = Bun.spawn(
    ['bun', CLI, 'run', '테스트 작업', '--cwd', project, '--gate', 'mine:true'],
    {
      env: { ...process.env, ZANNABI_ADAPTER: 'fake' },
      stdin: new Response('y\n').body!,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('[사용자] mine:')
  expect(out).toContain('[에이전트 제안] ok:')
  expect(out).toContain('승인하면 이것으로도 완료가 판정됩니다')
})
