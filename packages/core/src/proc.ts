/**
 * 헤드리스 CLI 하나를 구동하고 출력을 거둬들이는 런타임 중립 헬퍼.
 *
 * 어떤 에이전트의 존재도 모른다 — 어댑터들이 공통으로 필요로 하는
 * "멈추면 죽이고, 죽은 뒤엔 남은 출력만 잠깐 더 받는다"만 담는다.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_KILL_GRACE_MS = 1000
const DEFAULT_IO_GRACE_MS = 500

export interface RunProcessOptions {
  cwd?: string
  /** 마지막 출력 이후 이 시간이 지나면 종료시킨다. 0 이하면 끄기 */
  idleTimeoutMs?: number
  /** SIGTERM 후 SIGKILL까지의 유예 */
  killGraceMs?: number
  /** 종료 후 남은 출력을 거둬들이는 유예 */
  ioGraceMs?: number
}

export interface ProcessOutcome {
  /** null이면 spawn 자체가 실패한 것 */
  exitCode: number | null
  stdout: string
  stderr: string
  /** 출력이 끊겨 러너가 종료시켰는지 */
  idleKilled: boolean
  /** 판정에 쓰인 행 감시 값 — 진단 메시지에 실린다 */
  idleTimeoutMs: number
  spawnError?: string
}

async function collect(
  stream: ReadableStream<Uint8Array> | null,
  sink: { text: string },
  touch: () => void,
) {
  if (!stream) return
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream) {
      touch()
      sink.text += decoder.decode(chunk, { stream: true })
    }
  } catch {
    // 스트림이 끊겨도 지금까지 모은 것은 진단에 쓴다
  }
}

export async function runProcess(
  command: string[],
  opts: RunProcessOptions = {},
): Promise<ProcessOutcome> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const ioGraceMs = opts.ioGraceMs ?? DEFAULT_IO_GRACE_MS
  const stdout = { text: '' }
  const stderr = { text: '' }

  try {
    const proc = Bun.spawn(command, {
      cwd: opts.cwd,
      // 헤드리스 실행에서 stdin을 열어두면 CLI가 입력을 기다리며 멈출 수 있다
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // 드레인을 먼저 시작한 뒤 exit을 기다린다 (파이프 버퍼가 차서 생기는 교착 방지)
    let lastActivity = Date.now()
    const touch = () => { lastActivity = Date.now() }
    const outDone = collect(proc.stdout, stdout, touch)
    const errDone = collect(proc.stderr, stderr, touch)

    let idleKilled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const watchdog =
      idleMs > 0
        ? setInterval(() => {
            if (Date.now() - lastActivity < idleMs) return
            idleKilled = true
            proc.kill()
            killTimer ??= setTimeout(() => proc.kill(9), killGraceMs)
          }, Math.max(50, Math.min(idleMs, 5000)))
        : undefined

    const exitCode = await proc.exited
    if (watchdog) clearInterval(watchdog)
    if (killTimer) clearTimeout(killTimer)

    // 손자 프로세스가 파이프를 붙들고 있으면 수집이 끝나지 않는다 — 유예만 주고 넘어간다
    await Promise.race([Promise.allSettled([outDone, errDone]), Bun.sleep(ioGraceMs)])

    return { exitCode, stdout: stdout.text, stderr: stderr.text, idleKilled, idleTimeoutMs: idleMs }
  } catch (err) {
    return {
      exitCode: null,
      stdout: stdout.text,
      stderr: stderr.text,
      idleKilled: false,
      idleTimeoutMs: idleMs,
      spawnError: err instanceof Error ? err.message : String(err),
    }
  }
}
