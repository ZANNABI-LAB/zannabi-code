// packages/gateway-telegram/src/lock.ts
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/**
 * 이 시간이 지난 락은 주인이 죽은 것으로 본다 — **다른 기계가 잡은 락에만 쓴다.**
 * 같은 기계면 pid로 정확히 알 수 있으므로 시간에 기대지 않는다.
 *
 * 1시간인 이유: 승인 대기는 사람의 반응 시간이라 길 수 있다. 짧게 잡으면
 * 자리를 비운 사이 락을 빼앗기고, 그러면 두 프로세스가 동시에 폴링해 409가 난다 —
 * 락을 둔 목적 자체가 무너진다.
 */
export const STALE_MS = 60 * 60 * 1000

export interface LockHolder {
  pid: number
  host: string
  /** ISO 8601 */
  since: string
}

export type LockResult =
  | { ok: true; path: string; release(): void }
  | { ok: false; path: string; holder?: LockHolder }

/**
 * long polling 소유권을 파일 락으로 가른다.
 *
 * **왜 필요한가**: 텔레그램 Bot API는 같은 봇 토큰으로 `getUpdates`를 동시에 두 번 돌리면
 * 409 Conflict를 낸다. 이것은 우리가 설계로 피할 수 있는 것이 아니라 API의 제약이다.
 * gajae-code는 이 문제를 상주 데몬(`gjc daemon` — "봇 토큰당 안전한 long-poll 소유자 하나")으로
 * 풀었지만, 그러려면 데몬·브로커·컨트롤러 세 층과 **승인 응답을 되돌리는 별도 계약**이 필요하다.
 * 우리 계약은 단방향이므로 그 값을 치를 수 없다. 대신 **승인을 기다리는 프로세스만 락을 잡는다** —
 * 승인 창은 짧고 상주 프로세스는 0개다.
 *
 * **왜 저장소 밖인가**: 충돌은 봇 토큰 단위로 난다. 락이 저장소 안에 있으면 다른 저장소에서
 * 돌린 실행과의 충돌을 못 본다 — 정작 막아야 할 경우를 놓친다.
 *
 * **왜 토큰을 해시하는가**: 파일명은 `ls` 한 번에 보인다. 봇 토큰을 쥔 쪽이 계획 승인권을
 * 갖는다는 것이 이 게이트웨이의 보안 경계이므로, 토큰이 경로에 드러나서는 안 된다.
 */
export function acquirePollLock(token: string, opts: { dir?: string; now?: Date } = {}): LockResult {
  const dir = opts.dir ?? defaultLockDir()
  const path = join(dir, `telegram-${fingerprint(token)}.lock`)
  mkdirSync(dir, { recursive: true })

  const mine: LockHolder = {
    pid: process.pid,
    host: hostname(),
    since: (opts.now ?? new Date()).toISOString(),
  }

  const taken = (): LockResult => {
    const holder = readHolder(path)
    return { ok: false, path, ...(holder ? { holder } : {}) }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx`는 파일이 있으면 실패한다 — 검사와 생성이 한 번의 시스템 콜이라
      // 두 프로세스가 동시에 들어와도 하나만 성공한다
      writeFileSync(path, JSON.stringify(mine), { flag: 'wx' })
      return { ok: true, path, release: () => releaseIfMine(path, mine) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (!isStale(path, readHolder(path), opts.now ?? new Date())) return taken()
      // 주인이 죽었다 — 치우고 한 번만 더 시도한다. 무한 재시도는 두 프로세스가
      // 서로의 락을 지우며 도는 상황을 만들 수 있다
      try {
        unlinkSync(path)
      } catch {
        /* 다른 쪽이 먼저 치웠다 — 다음 시도가 답을 준다 */
      }
    }
  }
  return taken()
}

/** 락 파일이 **내 것일 때만** 지운다. 남의 락을 지우면 그 프로세스가 폴링 중에 짝을 잃는다 */
function releaseIfMine(path: string, mine: LockHolder) {
  const holder = readHolder(path)
  if (holder?.pid !== mine.pid || holder.host !== mine.host) return
  try {
    unlinkSync(path)
  } catch {
    /* 이미 없으면 목적은 달성됐다 */
  }
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LockHolder>
    if (typeof raw.pid !== 'number' || typeof raw.host !== 'string' || typeof raw.since !== 'string')
      return undefined
    return { pid: raw.pid, host: raw.host, since: raw.since }
  } catch {
    // 읽을 수 없는 락은 판단할 수 없다. 회수는 stale 검사가 시간으로 결정한다
    return undefined
  }
}

/**
 * 주인이 사라졌는지 본다.
 *
 * **같은 기계면 pid로 정확히 알 수 있다** — `kill(pid, 0)`은 신호를 보내지 않고 존재만 묻는다.
 * 다른 기계(공유 홈 디렉터리)면 알 방법이 없으므로 시간에 기댄다. 내용을 못 읽는 락도
 * 시간으로만 판단한다 — 깨진 파일 하나가 영원히 승인을 막아서는 안 된다.
 */
function isStale(path: string, holder: LockHolder | undefined, now: Date): boolean {
  if (holder && holder.host === hostname()) {
    try {
      process.kill(holder.pid, 0)
      return false
    } catch (err) {
      // EPERM은 프로세스가 살아 있는데 내 권한이 없다는 뜻이다 — 죽었다고 보면 안 된다
      return (err as NodeJS.ErrnoException).code !== 'EPERM'
    }
  }
  try {
    return now.getTime() - statSync(path).mtimeMs > STALE_MS
  } catch {
    return true
  }
}

function defaultLockDir(): string {
  return join(homedir(), '.zannabi', 'locks')
}

/** 토큰을 파일명에 쓸 수 있는 지문으로 줄인다. 되돌릴 수 없어야 한다는 것이 요점이다 */
export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

export function describeHolder(holder: LockHolder | undefined): string {
  if (!holder) return '알 수 없는 프로세스'
  return `pid ${holder.pid} @ ${holder.host} (${holder.since}부터)`
}

