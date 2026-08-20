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

/**
 * 실패를 설명하는 줄을 알아보는 패턴들.
 *
 * `stdoutTail`을 늘리는 것으로는 안 되는 이유: 실측에서 잘린 것은 크기 부족이 아니라
 * **노이즈**였다. 시험 수백 건의 PASSED와 Spring 종료 로그가 꼬리를 채워 정작 `FAILED`
 * 줄이 창 밖으로 밀렸다. 4000을 8000으로 올려도 시험이 많으면 또 밀린다.
 * 그래서 크기를 키우는 대신 **신호를 추린다.**
 *
 * 도구를 특정하지 않는다 — 어느 러너에서든 실패는 대개 이 낱말들로 말한다.
 * 못 알아본 형식은 여전히 tail에 남으므로, 이 목록이 틀려도 잃는 것은 없다.
 */
const SIGNAL_PATTERNS = [
  /\bFAILED\b/,
  /\bFAIL(URE)?S?\b/,
  /\bERROR\b/,
  /\berror:/i,
  /Syntax error/i,
  /Exception\b/,
  /Assertion\w*(Error|Failed)/i, // JUnit5는 AssertionFailedError로 말한다
  /Caused by:/,
  /Compilation (error|failed)/i,
  /^\s*e: /, // kotlinc
  /^\s*\d+\) /, // 시험 실패 목록
  /panic:/,
  /Traceback \(most recent call last\)/,
]

/** 신호 줄은 이만큼만 싣는다. 이보다 많으면 그것대로 tail을 읽어야 할 신호다 */
const MAX_SIGNAL_LINES = 30
const SIGNAL_LINE_CHARS = 300

/**
 * 출력에서 실패를 설명하는 줄만 추린다. 순서는 원본 그대로 — 인과가 순서에 담긴다.
 *
 * 성공한 게이트에는 쓰지 않는다. 통과 로그의 "0 errors" 같은 줄까지 신호로 실으면
 * 신호와 잡음의 비율이 다시 나빠진다.
 */
export function signalLines(text: string): string[] {
  const seen = new Set<string>()
  const picked: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim() || !SIGNAL_PATTERNS.some(p => p.test(line))) continue
    const clipped = line.slice(0, SIGNAL_LINE_CHARS)
    if (seen.has(clipped)) continue // 같은 줄이 회차마다 반복되는 로그가 흔하다
    seen.add(clipped)
    picked.push(clipped)
    if (picked.length >= MAX_SIGNAL_LINES) break
  }
  return picked
}

export interface GateWarning {
  gate: string
  cmd: string
  reason: string
  /**
   * `blocking`은 이 환경에서 게이트를 아예 실행할 수 없다는 뜻이고,
   * `advisory`는 돌기는 하지만 사람이 알아야 할 것이 있다는 뜻이다.
   *
   * 둘을 나누는 이유: `--yes`는 사람이 안 보는 대신 기계가 최소한의 검사를 대신하는데,
   * 조언까지 거부 사유로 삼으면 배치 실행이 조언 때문에 죽는다.
   */
  kind: 'blocking' | 'advisory'
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
        warnings.push({
          gate: gate.name,
          cmd: gate.cmd,
          reason: `명령을 찾을 수 없습니다: ${word}`,
          kind: 'blocking',
        })
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
  // 실패한 게이트만 신호를 추린다 — 진단이 필요한 자리가 거기다
  const signals = outcome === 'pass' ? [] : signalLines(`${stdoutSink.text}\n${stderrSink.text}`)
  return {
    gate: gate.name,
    cmd: gate.cmd,
    source: gate.source,
    outcome,
    ...(signals.length > 0 ? { signals } : {}),
    exitCode,
    stdoutTail: stdoutSink.text.slice(-TAIL_CHARS),
    stderrTail: stderrSink.text.slice(-TAIL_CHARS),
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
    revision: opts.revision,
  }
}
