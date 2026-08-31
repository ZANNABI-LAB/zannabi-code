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
  /**
   * **실행 턴의 에이전트가 셸 명령을 돌릴 수 있는가.**
   *
   * 이것을 신고하지 않으면 지시서를 쓰는 사람이 되지 않을 것을 지시한다 — 실측에서
   * "1단계를 넣고 게이트를 돌려 초록이면 2단계로 가라"는 순서 제약이 계획에는 그대로
   * 실렸는데 실행 턴이 그것을 할 수 없었고, 그 사실은 실행이 끝난 뒤 transcript의
   * 권한 거부 7건으로만 드러났다. 단계별 귀속을 사람이 지시서로 만들 수 없다는 뜻이다.
   *
   * 값이 `none`이면 **에이전트는 검증 없이 한 라운드를 써야 한다.** 라운드가 유일한
   * 피드백 루프이므로 오타 하나가 라운드 하나 값이다. 지시를 짜는 쪽이 그 전제를
   * 알고 짜는 것과 모르고 짜는 것은 다르다.
   */
  execShell: SupportSchema,
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
 * **한 번 과장했다가 외부 리뷰에 잡혔다.** 처음에는 비용만 `partial`이고 나머지는 전부
 * `full`이었는데, 증거는 작업하는 에이전트가 지울 수 있고, 리비전 결박은 git 밖에서
 * 성립하지 않으며, 재개는 워크트리로 돌던 실행에서 격리를 잇지 못한다.
 * "신고는 자랑이 아니라 계약"이라고 문서에 써 놓고 정작 자기에게는 관대했던 것이다.
 *
 * 그래서 규칙을 다시 적는다: **여기 `full`을 적으려면 예외가 없어야 한다.**
 * 조건부로 되는 것은 전부 `partial`이고, 그 조건을 주석에 남긴다.
 * 못 하는 것을 신고하면 소비자가 없는 화면을 그리려다 깨진다.
 */
export function manifest(version: string): Manifest {
  return {
    runner: 'zannabi-code',
    version,
    contractVersion: CONTRACT_VERSION,
    capabilities: {
      // 게이트는 러너가 직접 돌리고 종료코드로만 판정한다 — 여기에는 예외가 없다
      gates: 'full',
      /**
       * `partial`인 이유: 증거 디렉토리가 **대상 저장소 안**에 있어 작업하는 에이전트가
       * 지울 수 있다. 러너는 손실을 감지해 판정을 `evidence-lost`로 강등하지만
       * 그것은 사후 복구지 경계가 아니다. `full`로 신고하면 소비자가 "증거는 항상 있다"를
       * 전제로 화면을 그리게 된다.
       */
      evidence: 'partial',
      /** `partial`인 이유: git 저장소가 아니면 `tracked: false`가 되어 결박할 리비전이 없다 */
      revisionBinding: 'partial',
      /** `partial`인 이유: claude는 비용을 주고 codex는 주지 않는다 */
      cost: 'partial',
      liveJournal: 'full',
      /**
       * `partial`인 이유: **워크트리로 돌던 실행은 재개할 수 없다.**
       * 브랜치 이름이 `zannabi/<runId>`로 결정되는데 워크트리를 치워도 브랜치는 남으므로,
       * 재개가 같은 이름을 다시 만들려다 실패한다. `--worktree` 없이 재개하면 뜨기는 하지만
       * 원본 저장소에서 돌아 라운드 N까지의 작업이 없는 상태에서 이어간다.
       * 격리 없이 돌린 실행의 재개는 온전하다.
       */
      resume: 'partial',
      /**
       * `partial`인 이유: **git 저장소가 아니거나 커밋이 하나도 없으면 격리할 수 없다.**
       * 워크트리는 갈라져 나올 지점을 요구하므로 `worktreeUsable`이 두 경우를 모두 거부한다.
       * `revisionBinding`이 정확히 같은 이유로 `partial`인데 이쪽만 `full`이었다 —
       * 같은 조건에 다른 값을 적으면 신고가 조건이 아니라 기분을 말하는 것이 된다.
       */
      isolation: 'partial',
      /**
       * `partial`인 이유: **격리 위에서만 성립한다.** 조마다 워크트리를 만들므로
       * `isolation`이 안 되는 곳에서는 race도 안 된다. 신고는 자기 전제까지 물려받아야 한다.
       */
      bestOfN: 'partial',
      /**
       * `partial`인 이유: **여는 것이 게이트 명령뿐이다.**
       * claude는 승인된 게이트의 `cmd`를 `--allowedTools`의 접두 패턴으로 받아 그것만 돌릴 수
       * 있다(`--no-exec-shell`로 끌 수 있다). codex는 `--sandbox workspace-write`라
       * 샌드박스 안에서 더 넓게 돈다 — 여기서도 두 런타임이 갈린다.
       *
       * **`full`이 아닌 이유가 능력 부족이 아니라 설계다.** 넓게 열면 러너가 준 권한을
       * 러너가 설명할 수 없게 된다. 열어 준 범위는 "완료의 정의" 그 자체다.
       */
      execShell: 'partial',
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
      /**
       * `--yes`가 들어 있으므로 **승인 화면이 없다.** 그 대신 러너는 사용자 게이트를
       * 하나 이상 요구한다 — 완료 기준이 전부 에이전트 제안인 채로 사람 없이 도는 것이
       * 이 도구가 막아야 할 바로 그 상태이기 때문이다.
       * `{gate}`는 `이름:명령` 한 쌍이고, 여러 개면 `--gate`와 함께 되풀이한다.
       */
      run: ['run', '{intent}', '--cwd', '{cwd}', '--gate', '{gate}', '--yes'],
      resume: ['resume', '{runId}', '--cwd', '{cwd}'],
      status: ['status', '{runId}', '--cwd', '{cwd}'],
    },
  }
}
