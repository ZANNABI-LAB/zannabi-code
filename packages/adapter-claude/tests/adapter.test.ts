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
