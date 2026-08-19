import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { CodexAdapter } from '../src/index'

const binary = join(import.meta.dir, 'fixtures/fake-codex.sh')

test('spawn → 파싱 → AgentResult 변환', async () => {
  const result = await new CodexAdapter({ binary }).run({ prompt: '작업해줘', cwd: process.cwd() })
  expect(result.ok).toBe(true)
  expect(result.finalText).toBe('pong')
  expect(result.sessionId).toBe('01a0189b-9d9b-7c00-9819-b0ffa06aacbe')
})

test('기본 인자 — exec · --json · workspace-write · -C cwd', () => {
  const args = new CodexAdapter().buildArgs({ prompt: '해줘', cwd: '/proj' })
  expect(args[0]).toBe('exec')
  expect(args).toContain('--json')
  expect(args).toContain('workspace-write')
  expect(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2)).toEqual(['-C', '/proj'])
  expect(args.at(-1)).toBe('해줘') // 프롬프트는 마지막 위치 인자
})

test('이어가기는 resume 서브커맨드이고 세션·프롬프트가 마지막 두 위치 인자다', () => {
  const args = new CodexAdapter().buildArgs({ prompt: '계속', cwd: '/proj', resumeSessionId: 'abc' })
  expect(args).toEqual(['exec', 'resume', '--json', 'abc', '계속'])
})

test('resume은 --sandbox·-C·--skip-git-repo-check를 받지 않는다 (붙이면 exit 2)', () => {
  const adapter = new CodexAdapter({ sandbox: 'read-only', skipGitRepoCheck: true })
  const args = adapter.buildArgs({ prompt: 'p', cwd: '/proj', resumeSessionId: 'abc' })
  expect(args).not.toContain('--sandbox')
  expect(args).not.toContain('-C')
  expect(args).not.toContain('--skip-git-repo-check')
})

test('resume에도 모델 지정은 전달된다', () => {
  const args = new CodexAdapter({ model: 'gpt-5.4' })
    .buildArgs({ prompt: 'p', cwd: '/proj', resumeSessionId: 'abc' })
  expect(args).toEqual(['exec', 'resume', '--json', '-m', 'gpt-5.4', 'abc', 'p'])
})

test('모델·샌드박스 옵션이 인자에 반영된다', () => {
  const args = new CodexAdapter({ model: 'gpt-5.4', sandbox: 'read-only' })
    .buildArgs({ prompt: 'p', cwd: '/proj' })
  expect(args).toContain('-m')
  expect(args).toContain('gpt-5.4')
  expect(args).toContain('read-only')
  expect(args).not.toContain('workspace-write')
})

test('turn.failed → ok false + 사유', async () => {
  const result = await new CodexAdapter({
    binary: join(import.meta.dir, 'fixtures/fake-codex-failed.sh'),
  }).run({ prompt: 'p', cwd: process.cwd() })

  expect(result.ok).toBe(false)
  expect(result.errorReason).toContain('turn.failed')
  expect(result.events.some(e => e.type === 'stderr')).toBe(true)
})

test('바이너리 없음 → ok false (throw 아님)', async () => {
  const result = await new CodexAdapter({ binary: '/nonexistent/codex' })
    .run({ prompt: 'p', cwd: process.cwd() })
  expect(result.ok).toBe(false)
  expect(result.errorReason).toContain('codex 실행 실패')
})

test('출력이 끊긴 채 멈추면 종료시키고 사유를 남긴다', async () => {
  const adapter = new CodexAdapter({
    binary: join(import.meta.dir, 'fixtures/fake-codex-hang.sh'),
    idleTimeoutMs: 300,
  })
  const started = Date.now()
  const result = await adapter.run({ prompt: 'p', cwd: process.cwd() })

  expect(result.ok).toBe(false)
  expect(result.errorReason).toContain('에이전트 행')
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(result.sessionId).toBe('hung-thread') // 끊기기 전 증거는 보존
})
