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

test('partial로 신고한 축은 계약 문서가 그 조건을 밝힌다', () => {
  // **이 테스트가 있는 이유**: `full`은 예외가 없다는 뜻이라고 문서에 써 놓고 두 번 어겼다.
  // 처음에는 비용만 partial로 적었다가 외부 리뷰에 잡혔고, 그 뒤에도 isolation·bestOfN이
  // git 저장소를 요구하면서 full로 남아 있었다. 규칙을 사람의 성실함에 맡기면 또 어긴다.
  //
  // 조건표는 "partial로 신고하는 …과 그 조건:" 아래에 있다. 그 아래에서만 찾는 이유는
  // 위쪽 축 설명표가 같은 행 형식이라, 문서 전체를 보면 조건 없이도 통과해 버리기 때문이다
  const text = doc()
  const table = text.slice(text.indexOf('`partial`로 신고하는'))
  const documented = new Set([...table.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map(m => m[1]))
  const partials = Object.entries(manifest('0.0.1').capabilities)
    .filter(([, v]) => v === 'partial')
    .map(([axis]) => axis)
  expect(partials.filter(axis => !documented.has(axis))).toEqual([])
})

test('격리와 best-of-N은 같은 전제를 신고한다', () => {
  // race는 조마다 워크트리를 만든다. 격리가 조건부인데 race만 무조건이라고 신고하면,
  // 소비자는 git이 아닌 프로젝트에서 race 버튼을 그렸다가 실행 시점에 깨진다
  const c = manifest('0.0.1').capabilities
  expect(c.isolation).toBe('partial')
  expect(c.bestOfN).toBe('partial')
})
