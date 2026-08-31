/**
 * 게이트 밖 주장의 자기 신고 (Phase 15).
 *
 * **왜 만들었나**: 실행 턴에 셸을 열어 주자(Phase 11) 라운드 낭비는 줄었지만
 * "확인 못 한 자리"를 스스로 지목하는 일이 사라졌고, 정확히 그 자리에서 틀렸다.
 * 산문으로 요구해 봤고(실측 지시서에 있었다) 실패했으므로 형식을 강제한다.
 */
import { test, expect } from 'bun:test'
import { extractClaims } from '../src/goal'
import { executePrompt } from '../src/prompts'

const block = (body: string) => `작업을 마쳤습니다.\n\n\`\`\`json\n${body}\n\`\`\``

test('신고 없음과 빈 신고는 다른 상태다', () => {
  // **이 시험이 이 기능의 전부다.** 실측에서 "확인하지 못한 것" 절이 비었는데,
  // 그것이 회피인지 정말 없는 것인지 구별할 수 없어 판단이 막혔다.
  // "없다고 말했다"는 검증 가능한 진술이고 "말하지 않았다"는 아니다
  expect(extractClaims('다 했습니다.')).toEqual({ reported: false })
  expect(extractClaims(block('{"claims": []}'))).toEqual({ reported: true, claims: [] })
})

test('신고를 뽑는다 — 근거와 이유까지', () => {
  const report = extractClaims(
    block('{"claims": [{"claim": "설정 화면은 여전히 뜬다", "basis": "read", "why": "HTML을 여는 게이트가 없다"}]}'),
  )
  expect(report.reported).toBe(true)
  if (report.reported) {
    expect(report.claims).toHaveLength(1)
    expect(report.claims[0].basis).toBe('read')
    expect(report.claims[0].why).toContain('게이트가 없다')
  }
})

test('마지막 블록을 읽는다 — 답변 안의 예시 블록에 속지 않는다', () => {
  // extractGates 와 같은 이유다. 앞에서부터 집는 쪽은 인용된 예시를 신고로 읽는다
  const text =
    '예를 들면 이런 모양입니다:\n```json\n{"claims": [{"claim": "예시", "basis": "inferred"}]}\n```\n' +
    '실제 신고:\n```json\n{"claims": [{"claim": "진짜", "basis": "read"}]}\n```'
  const report = extractClaims(text)
  expect(report.reported).toBe(true)
  if (report.reported) expect(report.claims[0].claim).toBe('진짜')
})

test('계획 턴의 게이트 블록을 신고로 오해하지 않는다', () => {
  // 같은 파서가 두 종류의 JSON 블록을 본다. 스키마가 다르므로 서로의 블록은 건너뛰어야 한다
  expect(extractClaims(block('{"gates": [{"name": "t", "cmd": "bun test"}]}'))).toEqual({
    reported: false,
  })
})

test('형식이 어긋난 신고는 신고로 치지 않는다', () => {
  // basis 가 없거나 claim 이 빈 문자열이면 읽을 수 없다 — 반쯤 맞은 것을 통과시키면
  // "무엇을 확인 못 했나"의 답이 반쯤 맞은 것이 된다
  expect(extractClaims(block('{"claims": [{"claim": "x"}]}'))).toEqual({ reported: false })
  expect(extractClaims(block('{"claims": [{"claim": "", "basis": "read"}]}'))).toEqual({
    reported: false,
  })
})

test('실행 프롬프트가 빈 목록과 무응답의 차이를 말한다', () => {
  // 형식만 요구하고 이 차이를 안 알리면, 게이트 밖 주장이 없는 실행에서 에이전트는
  // 그냥 아무것도 안 낸다 — 그러면 다시 두 상태가 하나로 뭉개진다
  const prompt = executePrompt('계획', undefined, [], [])
  expect(prompt).toContain('"claims"')
  expect(prompt).toContain('an empty list and a missing block are not the same thing')
  // 판정에 쓰지 않는다는 것을 밝힌다 — 완료를 좌우한다고 오해하면 신고를 줄이는 쪽으로 움직인다
  expect(prompt).toContain('does NOT decide completion')
  // 셸을 열어 준 것이 이 문제를 만들었다는 사실 자체가 지시의 요점이다
  expect(prompt).toContain('stop standing out')
})

test('루프가 신고를 저널에 적는다 — 신고하지 않은 것도 적는다', async () => {
  // **신고가 없을 때 이벤트를 아예 안 쓰면** "요구를 무시했다"와 "이 실행에는 그 요구가
  // 없었다"가 저널에서 같아 보인다. 요구했는데 답이 없었다는 사실 자체가 기록되어야 한다
  const { runLoop, RunStore, FakeAdapter, fakeResult, readJournal } = await import('../src/index')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const run = async (execText: string) => {
    const cwd = mkdtempSync(join(tmpdir(), 'claims-'))
    const store = new RunStore(cwd, 'claims-probe')
    await runLoop({
      intent: '신고 시험',
      userGates: [{ name: 'user', cmd: 'true', timeoutMs: 60_000, source: 'user' }],
      budget: 1,
      cwd,
      adapter: new FakeAdapter([fakeResult('계획: 한다.'), fakeResult(execText)]),
      store,
      approve: async () => ({ action: 'approve' }),
      log: () => {},
    })
    const event = readJournal(store.dir).find(e => e.type === 'claims-reported')
    return event?.type === 'claims-reported' ? event : undefined
  }

  const silent = await run('다 했습니다.')
  expect(silent?.reported).toBe(false)
  expect(silent?.claims).toEqual([])

  const said = await run(
    '했습니다.\n```json\n{"claims": [{"claim": "화면은 그대로다", "basis": "inferred"}]}\n```',
  )
  expect(said?.reported).toBe(true)
  expect(said?.claims).toHaveLength(1)
}, 30_000)
