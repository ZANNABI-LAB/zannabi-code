import { test, expect } from 'bun:test'
import { executePrompt } from '../src/prompts'

test('열어 준 명령을 문자 그대로 프롬프트에 싣는다', () => {
  // 실측 1차가 여기서 깨졌다. 러너는 정확한 문자열을 아는데 열어만 놓고 말을 안 했고,
  // 에이전트는 계획서에 적힌 사람 판(따옴표가 바뀐)을 베껴 13번 전부 거부당했다
  const cmd = `./gradlew :csms:test --tests '*ApiAuthTest*'`
  const prompt = executePrompt('1. 고친다', undefined, [cmd])

  expect(prompt).toContain(cmd)
  // 왜 그대로 쳐야 하는지까지 말해야 한다 — 조용히 거부되고 사유가 안 오기 때문이다
  expect(prompt).toContain('EXACTLY')
  expect(prompt).toContain('silently denied')
  // 접두 확장이 된다는 사실도 — 모르면 파이프를 못 붙여 출력을 못 본다
  expect(prompt).toContain('append arguments and pipes')
  // 판정과 다른 층이라는 것을 에이전트도 알아야 한다
  expect(prompt).toContain('NOT count as the verdict')
})

test('열어 준 것이 없으면 그 절 자체가 없다', () => {
  // 빈 목록에 "아래 명령을 쓸 수 있다"를 붙이면 없는 권한을 있다고 말하는 것이 된다
  const prompt = executePrompt('1. 고친다')
  expect(prompt).not.toContain('verification commands yourself')
  expect(prompt).toContain('Plan:')
})

test('재시도 피드백과 자기 확인 절이 함께 실린다', () => {
  const prompt = executePrompt('1. 고친다', '[build] exit 1', ['bun test'])
  expect(prompt).toContain('bun test')
  expect(prompt).toContain('Previous attempt FAILED')
})
