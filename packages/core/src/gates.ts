import type { Gate, Evidence } from './goal'

const TAIL_CHARS = 4000

export async function runGate(gate: Gate, opts: { cwd: string }): Promise<Evidence> {
  const started = Date.now()
  let exitCode: number | null = null
  let stdout = ''
  let stderr = ''
  let timedOut = false
  try {
    const proc = Bun.spawn(['sh', '-c', gate.cmd], {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitedPromise = proc.exited
    let timer: any
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        proc.kill()
        resolve()
      }, gate.timeoutMs)
    })
    await Promise.race([exitedPromise, timeoutPromise])
    clearTimeout(timer)

    // Only process exit and read streams if not timed out
    if (!timedOut) {
      exitCode = await proc.exited
      // Narrow try/catch to stream reads only
      try {
        stdout = await new Response(proc.stdout).text()
        stderr = await new Response(proc.stderr).text()
      } catch {
        // Error reading streams - don't override exitCode
      }
    }
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
    outcome,
    exitCode,
    stdoutTail: stdout.slice(-TAIL_CHARS),
    stderrTail: stderr.slice(-TAIL_CHARS),
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  }
}
