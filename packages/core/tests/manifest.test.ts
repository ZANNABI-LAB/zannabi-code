import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { manifest, ManifestSchema } from '../src/manifest'
import { JournalEventSchema, CONTRACT_VERSION, JOURNAL_FILENAME } from '../src/journal'
import { RUN_STATUSES } from '../src/loop'
import { RUNS_DIR } from '../src/store'

const CONTRACT_DOC = join(import.meta.dir, '..', '..', '..', 'docs', 'contract-v1.md')
const doc = () => readFileSync(CONTRACT_DOC, 'utf-8')

/** 저널 어휘를 런타임에서 뽑는다 — 문서와 대조하려면 값이어야 한다 */
function journalTypes(): string[] {
  return JournalEventSchema.options.map(o => o.shape.type.value as string)
}

test('신고가 자기 스키마를 통과한다', () => {
  const parsed = ManifestSchema.safeParse(manifest('0.0.1'))
  expect(parsed.success).toBe(true)
})

test('신고한 경로가 러너가 실제로 쓰는 자리와 같다', () => {
  // 소비자가 이 값을 믿고 파일을 찾는다. 어긋나면 화면이 빈 채로 뜨고 이유를 알 수 없다
  const m = manifest('0.0.1')
  expect(m.evidenceLayout.runsDir).toBe(RUNS_DIR)
  expect(m.evidenceLayout.journal).toBe(JOURNAL_FILENAME)
  expect(m.contractVersion).toBe(CONTRACT_VERSION)
})

test('비용은 partial로 신고한다 — full로 적으면 화면이 $0.00을 그린다', () => {
  // claude는 비용을 주고 codex는 안 준다. 그 차이를 러너가 삼키면
  // 계약이 거짓말을 옮기는 통로가 된다
  expect(manifest('0.0.1').capabilities.cost).toBe('partial')
})

test('계약 문서의 저널 어휘가 코드의 어휘와 정확히 같다', () => {
  // 문서가 코드와 갈리면 소비자는 없는 이벤트를 기다리거나 있는 이벤트를 놓친다.
  // "증거 없으면 완료가 아니다"를 파는 도구의 계약 문서가 검증되지 않으면 앞뒤가 안 맞는다
  const text = doc()
  const types = journalTypes()
  for (const type of types) expect(text).toContain(`\`${type}\``)

  // 문서에만 있고 코드에 없는 이벤트도 잡는다 — 표의 첫 열에서 뽑는다.
  // 같은 형식의 표가 셋(저널 어휘·능력 축·판정값)이라 세 목록 전부와 대조한다
  const known = [...types, ...RUN_STATUSES, ...Object.keys(manifest('0.0.1').capabilities)]
  const documented = [...text.matchAll(/^\| `([a-zA-Z-]+)` \|/gm)].map(m => m[1])
  const unknown = documented.filter(d => !known.includes(d))
  expect(unknown).toEqual([])
})

test('계약 문서의 판정값이 코드의 판정값과 정확히 같다', () => {
  const text = doc()
  for (const status of RUN_STATUSES) expect(text).toContain(`\`${status}\``)
  expect(RUN_STATUSES).toHaveLength(10)
})

test('계약 문서가 능력 축을 빠짐없이 싣는다', () => {
  const text = doc()
  for (const axis of Object.keys(manifest('0.0.1').capabilities))
    expect(text).toContain(`\`${axis}\``)
})

test('계약 판이 문서에 적힌 판과 같다', () => {
  expect(doc()).toContain('# 러너 계약 v1')
  expect(CONTRACT_VERSION).toBe(1)
})
