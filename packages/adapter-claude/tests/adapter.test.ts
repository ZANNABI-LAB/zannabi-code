import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { ClaudeAdapter, allowedToolPatterns, openableCommands } from '../src/index'

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

test('게이트 명령만 열고, 접두 매칭으로 옵션 하나에 막히지 않게 한다', () => {
  expect(allowedToolPatterns(['./gradlew :csms:test', './gradlew build'])).toEqual([
    'Bash(./gradlew :csms:test*)',
    'Bash(./gradlew build*)',
  ])
  // 같은 명령이 게이트 둘에 걸려 있어도 패턴은 하나다
  expect(allowedToolPatterns(['bun test', 'bun test'])).toEqual(['Bash(bun test*)'])
  // 열 것이 없으면 아무것도 열지 않는다 — 빈 배열이 "전부 허용"이 되면 안 된다
  expect(allowedToolPatterns([])).toEqual([])
  expect(allowedToolPatterns(undefined)).toEqual([])
})

test('접두로 표현되지 않는 형태는 열 수 없다고 답한다', () => {
  // 실측에서 막힌 셋. 둘은 에이전트가 제안하고 러너가 승인한 게이트였다 —
  // 자기가 쓴 문자열을 자기가 그대로 쳤는데 막혔다
  const denied = [
    `! sed -n '35,$p' docs/CONFORMANCE.md | grep -nP '[\\x{AC00}-\\x{D7A3}]'`,
    `grep -q '^## 4' docs/X.md && test $(git ls-files 'schemas/*.json' | wc -l) -eq 181`,
    'sh -c "(cd x && make)"',
    'echo `date`',
  ]
  expect(openableCommands(denied)).toEqual([])
  // 열 수 있는 것은 그대로 통과한다
  expect(openableCommands([...denied, 'bun test'])).toEqual(['bun test'])
  // 패턴도 같은 판정을 쓴다 — 둘이 갈리면 프롬프트가 못 쓰는 것을 쓸 수 있다고 말한다
  expect(allowedToolPatterns(denied)).toEqual([])
})

test('열어 준 명령이 CLI 인자에 실린다', () => {
  const adapter = new ClaudeAdapter({ binary })
  const args = adapter.buildArgs({
    prompt: 'p', cwd: '/x', allowedCommands: ['bun test'],
  })
  expect(args).toContain('--allowedTools')
  expect(args).toContain('Bash(bun test*)')

  // 안 넘기면 플래그 자체가 없다 — 빈 --allowedTools가 무엇을 뜻하는지는 그쪽 규칙이고,
  // 우리가 그 해석에 기대면 CLI가 바뀔 때 조용히 넓어질 수 있다
  expect(adapter.buildArgs({ prompt: 'p', cwd: '/x' })).not.toContain('--allowedTools')
})
