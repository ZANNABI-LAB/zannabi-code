import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, compareConfig, configFingerprint, CONFIG_FILENAME } from '../src/config'

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

/** 실행 시작 시점의 상태를 찍고, 그 사이 파일이 바뀐 상황을 만든다 */
function snapshot(cwd: string) {
  const load = loadConfig(cwd)
  if (!load.ok) throw new Error(load.error)
  return { fingerprint: configFingerprint(cwd), config: load.config }
}

const twoGates = '{"gates":[{"name":"recovery","cmd":"a"},{"name":"build","cmd":"b"}]}'

test('설정이 그대로면 변경 없음 — 없는 사건을 만들지 않는다', () => {
  const cwd = withConfig(twoGates)
  expect(compareConfig(snapshot(cwd), cwd)).toBeUndefined()
})

test('에이전트가 게이트를 지우면 어느 게이트인지 짚는다', () => {
  const cwd = withConfig(twoGates)
  const before = snapshot(cwd)
  // 실전 사례: recovery를 지우고 자기 작업용 게이트를 넣었다
  writeFileSync(
    join(cwd, CONFIG_FILENAME),
    '{"gates":[{"name":"build","cmd":"b"},{"name":"basic-auth","cmd":"c"}]}',
  )
  expect(compareConfig(before, cwd)).toEqual({
    removed: false,
    created: false,
    droppedGates: ['recovery'],
    addedGates: ['basic-auth'],
    rewrittenGates: [],
  })
})

test('이름은 그대로인데 명령이 바뀐 것도 잡는다 — 이름만 보면 놓친다', () => {
  const cwd = withConfig(twoGates)
  const before = snapshot(cwd)
  writeFileSync(join(cwd, CONFIG_FILENAME), '{"gates":[{"name":"recovery","cmd":"true"},{"name":"build","cmd":"b"}]}')
  expect(compareConfig(before, cwd)?.rewrittenGates).toEqual(['recovery'])
})

test('파일이 통째로 사라지면 게이트 전부가 사라진 것으로 본다', () => {
  const cwd = withConfig(twoGates)
  const before = snapshot(cwd)
  rmSync(join(cwd, CONFIG_FILENAME))
  expect(compareConfig(before, cwd)).toMatchObject({
    removed: true,
    droppedGates: ['recovery', 'build'],
  })
})

test('설정이 깨진 채로 바뀌어도 바뀌었다는 사실은 남긴다', () => {
  const cwd = withConfig(twoGates)
  const before = snapshot(cwd)
  writeFileSync(join(cwd, CONFIG_FILENAME), '{ not json')
  expect(compareConfig(before, cwd)?.droppedGates).toEqual(['recovery', 'build'])
})

test('설정 파일이 없던 실행에서는 지문도 없다 — 빈 설정과 구별한다', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-config-'))
  expect(configFingerprint(cwd)).toBeUndefined()
  writeFileSync(join(cwd, CONFIG_FILENAME), twoGates)
  expect(compareConfig({ fingerprint: undefined, config: {} }, cwd)).toMatchObject({
    created: true,
    addedGates: ['recovery', 'build'],
  })
})
