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
  /^\s*--- FAIL: /, // Go 시험 실패 표준 머리. 통과는 `--- PASS:`라 갈린다
  /^\s*error\[E\d+\]/, // rustc 진단. 기존 `/\berror:/i`가 `error[E0308]:`을 못 잡는 자리라 새로 필요
  /thread '[^']*' panicked at/, // Rust 런타임 패닉. 기존 `/panic:/`는 콜론을 요구해서 이 형식을 놓친다
  /^\s*test .+ \.\.\. FAILED/, // cargo test 개별 실패. 통과 줄 `... ok`와 명시적으로 갈린다
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

/**
 * 셸 빌트인과 늘 존재하는 도구들. `command -v`가 언제나 성공하므로 검사해도 아무것도 못 밝힌다.
 *
 * **이 목록이 없으면 검사가 통째로 무력해진다**: `cd frontend && npm test`의 첫 낱말은 `cd`이고
 * `command -v cd`는 언제나 성공한다. 그래서 실측에서 이 형태가 전부 통과했다 —
 * 사전점검이 도는 것처럼 보이면서 실제로는 아무것도 안 보고 있었다.
 */
const ALWAYS_PRESENT = new Set(['cd', 'true', 'false', ':', 'echo', 'test', 'set', 'export', 'exit'])

/** 이 낱말들 뒤에 오는 것이 실제로 검사할 명령이다 (`env FOO=1 bun test`, `nohup ./gradlew`) */
const PASSTHROUGH = new Set(['env', 'nohup', 'time', 'exec', 'command'])

/**
 * 복합 명령을 셸 연산자로 가른다. 따옴표 안의 연산자는 가르지 않는다 —
 * `sh -c "a && b"` 한 덩어리를 둘로 쪼개면 있지도 않은 명령을 검사하게 된다.
 */
function segments(cmd: string): string[] {
  const parts: string[] = []
  let buf = ''
  let quote: string | undefined
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = undefined
      buf += c
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      buf += c
      continue
    }
    const two = cmd.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      parts.push(buf)
      buf = ''
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '&') {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  parts.push(buf)
  return parts.map(p => p.trim()).filter(Boolean)
}

/** 한 조각에서 검사할 낱말. 판정 불가면 null */
function segmentWord(segment: string): string | null {
  let words = segment.trim().split(/\s+/)
  // 환경변수 대입 접두사(FOO=1 cmd)와 감싸는 명령(env·nohup…)을 벗겨 낸다.
  // 한 번씩만 벗기면 `env FOO=1 ./gradlew`처럼 섞인 형태에서 대입이 남아 판정 불가가 된다
  for (;;) {
    const head = words[0]
    if (head === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || PASSTHROUGH.has(head)) {
      words = words.slice(1)
      continue
    }
    break
  }
  const first = words[0] ?? ''
  // 따옴표·서브셸·변수 전개가 섞이면 무엇이 실행될지 이 검사로는 알 수 없다
  if (!first || first.startsWith('-') || /[='"`($)]/.test(first)) return null
  return first
}

/**
 * 명령에서 존재 여부를 검사할 낱말들을 뽑는다.
 *
 * **첫 낱말 하나만 보면 안 되는 이유**: `cd frontend && npm test`에서 검사해야 할 것은
 * `npm`이지 `cd`가 아니다. 첫 조각만 보던 시절 이 형태가 통째로 통과했고,
 * `--yes`는 blocking 경고에만 기대므로 그 모드에서 검사가 사실상 없었다.
 */
export function checkableWords(cmd: string): string[] {
  const words = segments(cmd)
    .map(segmentWord)
    .filter((w): w is string => w !== null && !ALWAYS_PRESENT.has(w))
  return [...new Set(words)]
}

/**
 * 승인 전 게이트 점검. **실행 가능성만** 본다 — 통과/불통과는 보지 않는다.
 * 작업 전 실패하는 게이트는 정상이기 때문이다(TDD가 그렇다).
 * 게이트 전체를 시행하면 빌드를 두 번 돌리게 되므로 첫 낱말 해석만 확인한다.
 */
export async function preflightGates(gates: Gate[], opts: { cwd: string }): Promise<GateWarning[]> {
  const warnings: GateWarning[] = []
  for (const gate of gates) {
    // 복합 명령은 조각마다 본다 — `cd x && y`에서 정작 중요한 것은 뒤쪽이다
    for (const word of checkableWords(gate.cmd)) {
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
    /**
     * 타임아웃.
     *
     * **알려진 한계: 프로세스 트리를 죽이지 못한다.** 죽이는 것은 우리가 띄운 `sh`뿐이라,
     * 게이트가 백그라운드로 띄운 손자(`cmd &`, 데몬을 세우는 시험 등)는 살아남는다.
     * 판정은 정확하다 — 타임아웃은 `error`로 정직하게 기록되고 통과로 세지 않는다.
     * 남는 것은 자원 누수이고, 그 프로세스가 포트나 파일을 쥐고 있으면 다음 라운드의
     * 게이트가 그 때문에 실패할 수 있다.
     *
     * 고치지 않은 이유: 그룹째 죽이려면 새 세션으로 띄워야 하는데(`setsid`), 실측에서
     * 그룹 id를 잘못 잡으면 **러너 자신이 속한 그룹을 죽인다.** 검증 도구가 자기를 죽이는
     * 위험을 감수할 자리가 아니다. 이식성(setsid는 리눅스 것이다) 문제도 함께 있다.
     */
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
