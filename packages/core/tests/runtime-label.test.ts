import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop } from '../src/loop'
import { RunStore, readJournal } from '../src/store'
import { replay } from '../src/replay'
import type { AgentAdapter } from '../src/adapter'

const PLAN = '계획.\n```json\n{"gates":[{"name":"g","cmd":"true"}]}\n```'

/** 런타임이 "실제로 쓴" 모델을 보고한다 — 환경변수로 모델이 정해진 상황 */
function reportingAdapter(model: string): AgentAdapter {
  return {
    name: 'claude',
    async run({ prompt }) {
      return {
        ok: true,
        finalText: prompt.includes('planning') ? PLAN : '했음',
        events: [],
        sessionId: 's',
        model,
      }
    },
  }
}

test('저널과 리포트가 같은 런타임을 말한다 — 실제로 돈 모델로', async () => {
  // 2차 실측의 계약 위반: 리포트는 claude:claude-opus-5, 저널은 claude:default.
  // status.ts가 "저널에서 나오지 않는 정보는 뜰 수 없다"고 적어 뒀는데
  // 리포트가 저널에 없는 것을 말하고 있었다 — 표시 문제가 아니라 계약 위반이다
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-runtime-'))
  const store = new RunStore(cwd, '런타임 라벨')
  const result = await runLoop({
    intent: '런타임 라벨',
    userGates: [],
    budget: 1,
    cwd,
    adapter: reportingAdapter('claude-opus-5'),
    store,
    runtime: { plan: 'claude:default', exec: 'claude:default' }, // 지정값은 default
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  })

  expect(result.runtime).toEqual({ plan: 'claude:claude-opus-5', exec: 'claude:claude-opus-5' })
  // 저널만 읽는 소비자도 같은 답에 이르러야 한다
  expect(replay(readJournal(store.dir)).runtime).toEqual(result.runtime)
})

test('런타임이 모델을 보고하지 않으면 지정값 그대로 남는다', async () => {
  // 없는 것을 지어내지 않는다 — codex처럼 안 알려주는 쪽이 있다
  const cwd = mkdtempSync(join(tmpdir(), 'zannabi-runtime-silent-'))
  const store = new RunStore(cwd, '침묵')
  const silent: AgentAdapter = {
    name: 'codex',
    async run({ prompt }) {
      return { ok: true, finalText: prompt.includes('planning') ? PLAN : '했음', events: [] }
    },
  }
  const result = await runLoop({
    intent: '침묵',
    userGates: [],
    budget: 1,
    cwd,
    adapter: silent,
    store,
    runtime: { plan: 'codex:default', exec: 'codex:default' },
    approve: async () => ({ action: 'approve' }),
    log: () => {},
  })

  expect(result.runtime).toEqual({ plan: 'codex:default', exec: 'codex:default' })
  expect(replay(readJournal(store.dir)).runtime).toEqual(result.runtime)
})
