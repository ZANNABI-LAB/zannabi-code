/**
 * 능력 신고 — 러너가 자기가 무엇을 보고하는지 선언한다.
 *
 * **이것이 왜 계약의 세 번째 축인가.** 소비자(millim 같은 화면)는 여러 러너를 붙일 수 있어야
 * 하는데, 러너마다 보고하는 축이 다르다. claude를 직접 구동하는 쪽은 "3개 실행 중"까지밖에
 * 못 말하고, zannabi-code는 "3개 중 2개 통과, 1개는 증거 소실"을 말한다.
 * **화면이 러너를 알 필요는 없다 — 능력을 물으면 된다.**
 *
 * 그리고 이 구조가 유인을 만든다: 검증 축을 신고할 수 있는 러너만 검증 화면을 얻는다.
 * 강요가 아니라 유인이라는 것이 요점이다.
 *
 * **왜 실행 레시피까지 담는가.** 순수 관측만으로는 소비자가 "새 작업"을 시작할 수 없다.
 * 그렇다고 프로세스 수명(중단·종료)까지 계약에 넣으면 단방향 원칙이 깨지므로,
 * **어떻게 띄우는지만** 알려주고 띄운 뒤의 주인은 소비자다.
 */
import { z } from 'zod'
import { CONTRACT_VERSION, JOURNAL_FILENAME } from './journal'
import { RUNS_DIR } from './store'

/**
 * 한 축을 어느 정도로 보고하는가.
 *
 * `partial`이 따로 있는 이유: 비용이 정확히 그렇다. 러너는 비용을 보고할 **수** 있지만
 * 어떤 실행 런타임(codex)은 비용을 주지 않는다. 그것을 `true`로 신고하면 화면이
 * "$0.00"을 그리게 되고, 그 순간 계약이 거짓말을 옮기는 통로가 된다.
 */
export const SupportSchema = z.enum(['full', 'partial', 'none'])
export type Support = z.infer<typeof SupportSchema>

export const CapabilitiesSchema = z.object({
  /** 게이트를 러너가 직접 실행하고 종료코드로 판정하는가 — 검증 화면의 전제 */
  gates: SupportSchema,
  /** 실행마다 기계가 읽을 수 있는 증거를 남기는가 */
  evidence: SupportSchema,
  /** 증거가 리비전에 결박되는가(head + diffHash) */
  revisionBinding: SupportSchema,
  /** 비용을 보고하는가. `partial`은 "실행 런타임에 따라 다르다"는 뜻이다 */
  cost: SupportSchema,
  /** 진행을 실시간으로 흘리는가 — 저널 tail이 가능한가 */
  liveJournal: SupportSchema,
  /** 중단된 실행을 이어서 돌 수 있는가 */
  resume: SupportSchema,
  /** 실행끼리 워킹트리를 격리할 수 있는가 */
  isolation: SupportSchema,
  /** 같은 작업을 여러 조합으로 돌려 고르는가 */
  bestOfN: SupportSchema,
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

/**
 * 파일 계약의 자리 — 소비자가 무엇을 어디서 읽는지.
 * 경로를 신고하는 이유는 소비자가 `.zannabi`라는 이름을 하드코딩하지 않게 하기 위해서다.
 */
export const EvidenceLayoutSchema = z.object({
  runsDir: z.string(),
  racesDir: z.string(),
  journal: z.string(),
  goal: z.string(),
  evidence: z.string(),
  report: z.string(),
  diff: z.string(),
  plan: z.string(),
})

/**
 * 실행 레시피. `{...}` 자리표시자를 소비자가 채워 프로세스를 띄운다.
 *
 * 프로세스 수명은 여기 없다 — 띄운 프로세스의 주인은 띄운 쪽이다.
 */
export const LaunchSchema = z.object({
  command: z.string(),
  /** 자리표시자: {intent} {cwd} {runId} {gate} */
  run: z.array(z.string()),
  resume: z.array(z.string()),
  status: z.array(z.string()),
})

export const ManifestSchema = z.object({
  runner: z.string(),
  version: z.string(),
  contractVersion: z.number().int().positive(),
  capabilities: CapabilitiesSchema,
  evidenceLayout: EvidenceLayoutSchema,
  launch: LaunchSchema,
})
export type Manifest = z.infer<typeof ManifestSchema>

/**
 * 이 러너의 신고.
 *
 * `cost`가 `partial`인 것은 겸손이 아니라 사실이다 — claude는 비용을 주고 codex는 주지
 * 않는다. 그 차이를 러너가 삼키면 화면이 "$0.00"을 그리게 된다.
 * 나머지가 `full`인 것도 마찬가지로 사실이어야 한다: 신고는 자랑이 아니라 계약이고,
 * 못 하는 것을 신고하면 소비자가 없는 화면을 그리려다 깨진다.
 */
export function manifest(version: string): Manifest {
  return {
    runner: 'zannabi-code',
    version,
    contractVersion: CONTRACT_VERSION,
    capabilities: {
      gates: 'full',
      evidence: 'full',
      revisionBinding: 'full',
      // 실행 런타임에 따라 갈린다. 리포트의 커버리지(full/partial/none/not-run)가 실행마다 말한다
      cost: 'partial',
      liveJournal: 'full',
      resume: 'full',
      isolation: 'full',
      bestOfN: 'full',
    },
    evidenceLayout: {
      runsDir: RUNS_DIR,
      racesDir: '.zannabi/races',
      journal: JOURNAL_FILENAME,
      goal: 'goal.json',
      evidence: 'evidence.json',
      report: 'report.md',
      diff: 'diff.patch',
      plan: 'plan.md',
    },
    launch: {
      command: 'zannabi',
      run: ['run', '{intent}', '--cwd', '{cwd}', '--yes'],
      resume: ['resume', '{runId}', '--cwd', '{cwd}'],
      status: ['status', '{runId}', '--cwd', '{cwd}'],
    },
  }
}
