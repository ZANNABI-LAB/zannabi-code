import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, CONFIG_FILENAME } from '../src/config'

function withConfig(content: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-config-'))
  writeFileSync(join(cwd, CONFIG_FILENAME), content)
  return cwd
}

test('설정 파일이 없으면 빈 설정이고 오류가 아니다', () => {
  const load = loadConfig(mkdtempSync(join(tmpdir(), 'zannabi-noconfig-')))
  expect(load).toEqual({ ok: true, config: {} })
})

test('게이트는 사용자 게이트로 읽힌다 — 프로젝트가 정한 완료 기준이기 때문', () => {
  const cwd = withConfig('{"gates":[{"name":"test","cmd":"bun test"}],"budget":5}')
  const load = loadConfig(cwd)
  if (!load.ok) throw new Error(load.error)
  expect(load.config.gates?.[0]).toMatchObject({ name: 'test', source: 'user' })
  expect(load.config.budget).toBe(5)
})

test('깨진 JSON은 조용히 무시하지 않고 오류로 세운다', () => {
  const load = loadConfig(withConfig('{ not json'))
  expect(load.ok).toBe(false)
  if (load.ok) return
  expect(load.error).toContain('JSON 파싱 실패')
})

test('스키마에 안 맞으면 어느 필드인지 알려준다', () => {
  const load = loadConfig(withConfig('{"budget":0}'))
  expect(load.ok).toBe(false)
  if (load.ok) return
  expect(load.error).toContain('budget')
})
