/**
 * 루프 시험이 공유하는 준비물.
 *
 * `options` 헬퍼가 네 파일에 **완전히 같은 모양으로** 있었다(cost·journal·loop·replay).
 * 차이는 임시 디렉터리 접두와 기본 예산뿐인데, 한 벌을 고치면 나머지 셋이 조용히 갈린다 —
 * `LoopOptions`에 필수 필드가 늘 때 시험 파일마다 따로 고쳐야 하는 것도 같은 문제다.
 *
 * 파일 이름이 `.test.ts`가 아니므로 러너가 시험으로 잡지 않는다.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop, type LoopOptions } from '../src/loop'
import { RunStore } from '../src/store'

export type PartialOptions = Partial<LoopOptions> & { adapter: LoopOptions['adapter'] }

/**
 * 돌릴 수 있는 최소 `LoopOptions`. 승인은 자동이고 로그는 버린다.
 *
 * `cwd`를 주면 그것을 쓴다 — 같은 작업 디렉터리에서 두 번 돌려야 하는 시험(재개·저널 이어쓰기)이
 * 있기 때문이다. 증거 저장소의 이름은 `intent`를 따라간다: 둘이 갈리면 리포트와 저널이
 * 서로 다른 실행을 가리키는 것처럼 보인다.
 */
export function loopOptions(prefix: string, partial: PartialOptions): LoopOptions {
  const cwd = partial.cwd ?? mkdtempSync(join(tmpdir(), `zannabi-${prefix}-`))
  const intent = partial.intent ?? '테스트 작업'
  return {
    intent,
    userGates: [],
    budget: 3,
    cwd,
    store: new RunStore(cwd, intent),
    approve: async () => ({ action: 'approve' }),
    log: () => {},
    ...partial,
  }
}

/** 한 줄로 돌리고 결과만 받는다 */
export function runWith(prefix: string, partial: PartialOptions) {
  return runLoop(loopOptions(prefix, partial))
}
