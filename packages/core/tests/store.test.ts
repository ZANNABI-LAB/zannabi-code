import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore, slugify } from '../src/store'

test('slugify: 소문자화, 특수문자 → 하이픈, 40자 제한', () => {
  expect(slugify('결제 API에 재시도 로직 추가!')).toBe('결제-api에-재시도-로직-추가')
  expect(slugify('###')).toBe('run')
})

test('런 디렉토리 생성 및 산출물 기록', () => {
  const project = mkdtempSync(join(tmpdir(), 'zannabi-'))
  const store = new RunStore(project, '테스트 작업', new Date('2026-08-11T09:30:00Z'))
  expect(store.dir).toContain('.zannabi/runs/')
  expect(store.dir).toContain('2026-08-11')

  store.writePlan('# 계획')
  store.appendTranscript({ type: 'assistant', timestamp: 't1', payload: { a: 1 } })
  store.appendTranscript({ type: 'result', timestamp: 't2', payload: { b: 2 } })
  store.writeEvidence([[{
    gate: 'test', cmd: 'true', outcome: 'pass', exitCode: 0,
    stdoutTail: '', stderrTail: '', durationMs: 10, timestamp: 't',
  }]])

  expect(readFileSync(join(store.dir, 'plan.md'), 'utf8')).toBe('# 계획')
  const lines = readFileSync(join(store.dir, 'transcript.jsonl'), 'utf8').trim().split('\n')
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines[0]).type).toBe('assistant')
  expect(existsSync(join(store.dir, 'evidence.json'))).toBe(true)
})
