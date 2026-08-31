import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { acquirePollLock, fingerprint, describeHolder, STALE_MS } from '../src/lock'

const TOKEN = '123456:AAHfake-token-value'
const dir = () => mkdtempSync(join(tmpdir(), 'zannabi-lock-'))

describe('폴링 소유권 락', () => {
  test('한 번에 하나만 잡는다 — 409가 나는 조건 자체를 막는다', () => {
    const d = dir()
    const first = acquirePollLock(TOKEN, { dir: d })
    expect(first.ok).toBe(true)
    const second = acquirePollLock(TOKEN, { dir: d })
    expect(second.ok).toBe(false)
  })

  test('놓으면 다음 실행이 잡는다', () => {
    const d = dir()
    const first = acquirePollLock(TOKEN, { dir: d })
    expect(first.ok).toBe(true)
    if (first.ok) first.release()
    expect(acquirePollLock(TOKEN, { dir: d }).ok).toBe(true)
  })

  test('토큰이 다르면 서로를 막지 않는다 — 충돌은 토큰 단위로만 난다', () => {
    const d = dir()
    expect(acquirePollLock(TOKEN, { dir: d }).ok).toBe(true)
    expect(acquirePollLock('999:other', { dir: d }).ok).toBe(true)
  })

  test('★ 락 파일명에 토큰이 드러나지 않는다 — 승인권이 ls 한 번에 새면 안 된다', () => {
    const d = dir()
    const lock = acquirePollLock(TOKEN, { dir: d })
    expect(lock.path).not.toContain(TOKEN)
    expect(lock.path).toContain(fingerprint(TOKEN))
    expect(fingerprint(TOKEN)).not.toContain('AAHfake')
  })

  test('죽은 프로세스의 락은 회수한다 — 같은 기계면 pid로 정확히 안다', () => {
    const d = dir()
    const path = join(d, `telegram-${fingerprint(TOKEN)}.lock`)
    // 존재할 수 없는 pid. 커널 최대치를 넘는 값을 쓴다
    writeFileSync(path, JSON.stringify({ pid: 2 ** 30, host: hostname(), since: new Date().toISOString() }))
    const lock = acquirePollLock(TOKEN, { dir: d })
    expect(lock.ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8')).pid).toBe(process.pid)
  })

  test('살아 있는 프로세스의 락은 회수하지 않는다', () => {
    const d = dir()
    const path = join(d, `telegram-${fingerprint(TOKEN)}.lock`)
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() }))
    const lock = acquirePollLock(TOKEN, { dir: d })
    expect(lock.ok).toBe(false)
    expect(lock.ok === false && lock.holder?.pid).toBe(process.pid)
  })

  test('다른 기계의 락은 오래되면 회수한다 — pid로는 알 수 없으므로 시간에 기댄다', () => {
    const d = dir()
    const path = join(d, `telegram-${fingerprint(TOKEN)}.lock`)
    writeFileSync(path, JSON.stringify({ pid: 1, host: 'other-machine', since: '2020-01-01T00:00:00.000Z' }))
    const old = (Date.now() - STALE_MS - 60_000) / 1000
    utimesSync(path, old, old)
    expect(acquirePollLock(TOKEN, { dir: d }).ok).toBe(true)
  })

  test('다른 기계의 신선한 락은 존중한다', () => {
    const d = dir()
    const path = join(d, `telegram-${fingerprint(TOKEN)}.lock`)
    writeFileSync(path, JSON.stringify({ pid: 1, host: 'other-machine', since: new Date().toISOString() }))
    expect(acquirePollLock(TOKEN, { dir: d }).ok).toBe(false)
  })

  test('★ release는 남의 락을 지우지 않는다 — 지우면 그쪽이 폴링 중에 짝을 잃는다', () => {
    const d = dir()
    const lock = acquirePollLock(TOKEN, { dir: d })
    expect(lock.ok).toBe(true)
    // 그 사이 다른 프로세스가 락을 가져간 것으로 꾸민다
    writeFileSync(lock.path, JSON.stringify({ pid: 4242, host: 'other', since: new Date().toISOString() }))
    if (lock.ok) lock.release()
    expect(existsSync(lock.path)).toBe(true)
    expect(JSON.parse(readFileSync(lock.path, 'utf-8')).pid).toBe(4242)
  })

  test('내용이 깨진 락은 시간으로 판단한다 — 깨진 파일 하나가 승인을 영원히 막으면 안 된다', () => {
    const d = dir()
    const path = join(d, `telegram-${fingerprint(TOKEN)}.lock`)
    writeFileSync(path, 'not json')
    expect(acquirePollLock(TOKEN, { dir: d }).ok).toBe(false)
    const old = (Date.now() - STALE_MS - 60_000) / 1000
    utimesSync(path, old, old)
    expect(acquirePollLock(TOKEN, { dir: d }).ok).toBe(true)
  })

  test('주인을 사람이 읽을 수 있게 적는다 — 폴백 사유가 화면에 뜬다', () => {
    expect(describeHolder({ pid: 7, host: 'box', since: '2026-08-31T00:00:00.000Z' })).toContain('pid 7')
    expect(describeHolder(undefined)).toBe('알 수 없는 프로세스')
  })
})
