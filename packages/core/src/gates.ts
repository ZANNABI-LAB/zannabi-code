import type { Gate, Evidence, Revision } from './goal'

const TAIL_CHARS = 4000

export interface RunGateOptions {
  cwd: string
  /** SIGTERM 후 SIGKILL까지의 유예 */
  killGraceMs?: number
  /** 종료 후 남은 stdout/stderr를 거둬들이는 유예 */
  ioGraceMs?: number
  /** 이 게이트가 검사하는 워킹트리 상태. 그대로 증거에 결박된다 */
  revision?: Revision
}

async function collect(stream: ReadableStream<Uint8Array> | null, sink: { text: string }) {
  if (!stream) return
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true })
  } catch {
    // stream failure must not crash the gate; keep what we have
  }
}

export interface GateWarning {
  gate: string
  cmd: string
  reason: string
}

/** `cd x && y` 같은 복합 명령에서 판정 가능한 첫 낱말만 뽑는다. 판정 불가면 null */
function leadingWord(cmd: string): string | null {
  const first = cmd.trim().split(/\s+/)[0] ?? ''
  // 환경변수 대입 접두사(FOO=1 cmd)나 따옴표·서브셸은 이 검사로 판정하지 않는다
  if (!first || first.startsWith('-') || /[='"`($]/.test(first)) return null
  return first
}

/**
 * 승인 전 게이트 점검. **실행 가능성만** 본다 — 통과/불통과는 보지 않는다.
 * 작업 전 실패하는 게이트는 정상이기 때문이다(TDD가 그렇다).
 * 게이트 전체를 시행하면 빌드를 두 번 돌리게 되므로 첫 낱말 해석만 확인한다.
 */
export async function preflightGates(gates: Gate[], opts: { cwd: string }): Promise<GateWarning[]> {
  const warnings: GateWarning[] = []
  for (const gate of gates) {
    const word = leadingWord(gate.cmd)
    if (!word) continue
    try {
      // 낱말은 스크립트에 보간하지 않고 인자로 넘긴다 — 셸 주입 여지를 없앤다
      const proc = Bun.spawn(['sh', '-c', 'command -v "$1" >/dev/null 2>&1', 'sh', word], {
        cwd: opts.cwd,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      if ((await proc.exited) !== 0)
        warnings.push({ gate: gate.name, cmd: gate.cmd, reason: `명령을 찾을 수 없습니다: ${word}` })
    } catch {
      // 점검 자체가 실패하면 경고하지 않는다 — 사전점검이 새 실패 경로가 되면 안 된다
    }
  }
  return warnings
}

export async function runGate(gate: Gate, opts: RunGateOptions): Promise<Evidence> {
  const killGraceMs = opts.killGraceMs ?? 1000
  const ioGraceMs = opts.ioGraceMs ?? 500
  const started = Date.now()
  let exitCode: number | null = null
  let timedOut = false
  const stdoutSink = { text: '' }
  const stderrSink = { text: '' }
  try {
    const proc = Bun.spawn(['sh', '-c', gate.cmd], {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const outDone = collect(proc.stdout, stdoutSink)
    const errDone = collect(proc.stderr, stderrSink)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
      killTimer = setTimeout(() => proc.kill(9), killGraceMs)
    }, gate.timeoutMs)
    exitCode = await proc.exited
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    await Promise.race([Promise.allSettled([outDone, errDone]), Bun.sleep(ioGraceMs)])
  } catch {
    exitCode = null // spawn 자체 실패
  }
  const outcome =
    timedOut || exitCode === null || exitCode === 126 || exitCode === 127
      ? 'error'
      : exitCode === 0
        ? 'pass'
        : 'fail'
  return {
    gate: gate.name,
    cmd: gate.cmd,
    source: gate.source,
    outcome,
    exitCode,
    stdoutTail: stdoutSink.text.slice(-TAIL_CHARS),
    stderrTail: stderrSink.text.slice(-TAIL_CHARS),
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
    revision: opts.revision,
  }
}
