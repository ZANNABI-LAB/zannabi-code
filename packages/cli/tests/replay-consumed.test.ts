/**
 * **replay가 복원하는 것을 아무도 안 쓰는 자리를 잡는다.**
 *
 * 이 결함 유형은 네 번 반복됐다 — 저널이 값을 담고 replay가 복원하는데 화면도 재개도
 * 그것을 읽지 않아, 밖에서 보면 러너가 그 사실을 모르는 것처럼 보였다.
 * (재개 흔적 · 소요시간 · 실행 런타임 · 계약 판)
 *
 * 사람이 매번 대조하면 다섯 번째가 온다. 필드가 늘 때 **소비하거나, 소비하지 않는 이유를
 * 여기 적거나** 둘 중 하나를 하게 만든다.
 */
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE = join(import.meta.dir, '..', '..', 'core', 'src')
const CLI = join(import.meta.dir, '..', 'src')
const read = (p: string) => readFileSync(p, 'utf-8')

/**
 * 소비하지 않는 것이 옳은 필드와 그 이유.
 *
 * **비워 두는 것이 기본이다.** 여기 적는 것은 "안 쓰는 게 맞다"는 판단이고,
 * 판단에는 이유가 따라야 한다 — 이유를 못 적겠으면 그 필드는 써야 하는 것이다.
 */
const DELIBERATELY_UNUSED: Record<string, string> = {}

function replayFields(): string[] {
  const src = read(join(CORE, 'replay.ts'))
  const body = src.slice(src.indexOf('export interface ReplayState {'))
  const iface = body.slice(0, body.indexOf('\n}'))
  // `이름?: 타입` / `이름: 타입` 형태의 선언만 — 주석과 중첩 타입은 걸리지 않는다
  return [...iface.matchAll(/^  (\w+)\??:/gm)].map(m => m[1])
}

test('replay가 복원하는 필드는 화면·재개 중 어딘가가 쓴다', () => {
  /**
   * **`state.` 접두로만 센다.**
   *
   * 처음에는 필드 이름만 찾았는데 `.cwd` 같은 흔한 이름이 다른 객체의 속성에도 걸려
   * **미탐이 났다** — 소비를 통째로 지워도 시험이 통과했다. 잡지 못하는 시험은 있는 것이
   * 없는 것보다 나쁘다(지켜지고 있다고 믿게 만든다).
   *
   * 좁힌 대가는 미탐이 아니라 오탐이다: 구조분해로 꺼내 쓰면 여기 안 걸려 "안 쓴다"고
   * 보고된다. 그쪽이 안전하다 — 사람이 한 번 보면 되고, 반대는 조용히 지나간다.
   */
  const consumers = [
    read(join(CLI, 'status.ts')),
    read(join(CLI, 'index.ts')),
    read(join(CLI, 'race.ts')),
    // resumability 는 core 안에서 상태를 읽는다. 소비자를 CLI 로만 보면 approved 가 오탐 난다
    (src => src.slice(src.indexOf('export function resumability')))(read(join(CORE, 'replay.ts'))),
  ].join('\n')

  const unused = replayFields().filter(
    f => !DELIBERATELY_UNUSED[f] && !new RegExp(`\\bstate\\.${f}\\b`).test(consumers),
  )
  expect(unused).toEqual([])

  // 예외 목록에 이름만 올리고 이유를 비우면 "검토했다"와 "미뤘다"가 구분되지 않는다.
  // **여기서 함께 본다** — 목록이 비어 있을 때 따로 도는 시험은 0회 순회라
  // 통과해도 아무것도 지키지 않으면서 통과 수만 올린다
  for (const [field, reason] of Object.entries(DELIBERATELY_UNUSED)) {
    expect(replayFields()).toContain(field)
    expect(reason.length).toBeGreaterThan(10)
  }
})
