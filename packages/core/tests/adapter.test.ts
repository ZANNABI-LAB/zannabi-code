import { test, expect } from 'bun:test'
import { FakeAdapter, fakeResult } from '../src/testing'

test('큐 순서대로 응답하고 요청을 기록한다', async () => {
  const fake = new FakeAdapter([fakeResult('첫째'), fakeResult('둘째')])
  const r1 = await fake.run({ prompt: 'p1', cwd: '/tmp' })
  const r2 = await fake.run({ prompt: 'p2', cwd: '/tmp' })
  expect(r1.finalText).toBe('첫째')
  expect(r2.finalText).toBe('둘째')
  expect(fake.requests.map(r => r.prompt)).toEqual(['p1', 'p2'])
})

test('onRun 훅이 호출 인덱스와 함께 실행된다', async () => {
  const calls: number[] = []
  const fake = new FakeAdapter([fakeResult('a')], (_req, i) => calls.push(i))
  await fake.run({ prompt: 'p', cwd: '/tmp' })
  expect(calls).toEqual([0])
})

test('큐 소진 시 throw', async () => {
  const fake = new FakeAdapter([])
  expect(fake.run({ prompt: 'p', cwd: '/tmp' })).rejects.toThrow()
})
