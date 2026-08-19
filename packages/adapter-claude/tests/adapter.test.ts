import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { ClaudeAdapter } from '../src/index'

const binary = join(import.meta.dir, 'fixtures/fake-claude.sh')

test('spawn → 파싱 → AgentResult 변환', async () => {
  const adapter = new ClaudeAdapter({ binary })
  const result = await adapter.run({ prompt: '작업해줘', cwd: process.cwd() })
  expect(result.ok).toBe(true)
  expect(result.finalText).toBe('done by fake')
  expect(result.sessionId).toBe('fake-session')
  expect(result.events.length).toBeGreaterThan(0)
})

test('resumeSessionId가 있으면 --resume 플래그 전달', async () => {
  const adapter = new ClaudeAdapter({ binary })
  // fake-claude가 인자를 stderr로 출력하므로 spawn을 직접 검증하는 대신
  // 어댑터의 인자 조립 함수를 분리해 검증한다
  const args = adapter.buildArgs({ prompt: 'p', cwd: '/tmp', resumeSessionId: 'abc' })
  expect(args).toContain('--resume')
  expect(args).toContain('abc')
  expect(args).toContain('--output-format')
  expect(args).toContain('stream-json')
  expect(args).toContain('--permission-mode')
})

test('바이너리 없음 → ok false (throw 아님)', async () => {
  const adapter = new ClaudeAdapter({ binary: '/nonexistent/claude' })
  const result = await adapter.run({ prompt: 'p', cwd: process.cwd() })
  expect(result.ok).toBe(false)
})

test('exitCode 1이면 parsed.ok가 true여도 ok false', async () => {
  const binaryExit1 = join(import.meta.dir, 'fixtures/fake-claude-exit1.sh')
  const adapter = new ClaudeAdapter({ binary: binaryExit1 })
  const result = await adapter.run({ prompt: 'p', cwd: process.cwd() })
  expect(result.ok).toBe(false)
  expect(result.finalText).toBe('done by fake')
  // 실패 시 stderr 진단이 events에 추가됨
  expect(result.events.some(e => e.type === 'stderr')).toBe(true)
})

test('출력이 끊긴 채 멈추면 종료시키고 사유를 남긴다', async () => {
  const adapter = new ClaudeAdapter({
    binary: join(import.meta.dir, 'fixtures/fake-claude-hang.sh'),
    idleTimeoutMs: 300,
  })
  const started = Date.now()
  const result = await adapter.run({ prompt: 'p', cwd: process.cwd() })

  expect(result.ok).toBe(false)
  expect(result.errorReason).toContain('에이전트 행')
  expect(Date.now() - started).toBeLessThan(10_000) // 30초를 기다리지 않는다
  expect(result.sessionId).toBe('hung-session') // 끊기기 전까지의 증거는 보존
})

test('--model 옵션이 인자로 전달된다', () => {
  const args = new ClaudeAdapter({ model: 'claude-opus-5' }).buildArgs({ prompt: 'p', cwd: '/tmp' })
  expect(args).toContain('--model')
  expect(args).toContain('claude-opus-5')
})

test('행 감시가 정상 실행을 방해하지 않는다', async () => {
  const adapter = new ClaudeAdapter({ binary, idleTimeoutMs: 5_000 })
  const result = await adapter.run({ prompt: 'p', cwd: process.cwd() })
  expect(result.ok).toBe(true)
})
